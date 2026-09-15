import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { readRelaySessionFile, relayListKeys, type RelayKey } from "@/lib/relay-auth";
import { testRelayConnection } from "@/lib/relay-config-test";
import { persistRelayConfig, sanitizeBaseUrlOverride } from "@/lib/relay-config-save";

export const dynamic = "force-dynamic";

/**
 * POST /api/relay-config/auto — 登录后一键自动配置。
 *
 * 读取本地会话 → 拉取账号下全部 key → **逐个实测 /v1/models**（status 字段
 * 不可信：实测发现 status=active 的 key 仍可能 403）→ 第一个可用的 key 即写入
 * models.json + auth.json。全部不可用 → 返回明确原因，前端降级到手动粘贴。
 */
export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  let body: { baseUrl?: unknown } = {};
  try {
    body = (await request.json()) as { baseUrl?: unknown };
  } catch {
    /* 空 body 允许（{} 或空） */
  }
  const base = sanitizeBaseUrlOverride(
    typeof body.baseUrl === "string" ? body.baseUrl : undefined,
  );

  const session = await readRelaySessionFile();
  if (!session?.accessToken) {
    return NextResponse.json({ ok: false, reason: "unauthenticated" });
  }

  let keys: RelayKey[];
  try {
    keys = await relayListKeys(session.accessToken);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Network error")) {
      return NextResponse.json({ ok: false, reason: "network" });
    }
    return NextResponse.json({ ok: false, reason: "unauthenticated" });
  }

  if (keys.length === 0) {
    return NextResponse.json({ ok: false, reason: "no-key" });
  }

  // 逐个实测：跳过明确非 active 的，其余按顺序验证，第一个拉通模型列表的即采用。
  const candidates = keys.filter((k) => {
    const s = typeof k.status === "string" ? k.status.toLowerCase() : k.status;
    return s === undefined || s === "active" || s === "ok" || s === "valid" || s === "normal" || s === 200;
  });
  const ordered = [...candidates, ...keys.filter((k) => !candidates.includes(k))];

  const failures: string[] = [];
  for (const candidate of ordered) {
    const test = await testRelayConnection(candidate.key, base ?? undefined);
    if (test.ok && (test.modelCount ?? 0) > 0) {
      try {
        await persistRelayConfig(candidate.key, base, test.modelIds);
      } catch (error) {
        return NextResponse.json(
          { ok: false, reason: "save-failed", message: String(error) },
          { status: 500 },
        );
      }
      return NextResponse.json({
        ok: true,
        modelCount: test.modelCount ?? 0,
        usedKeyName: candidate.name ?? undefined,
        tried: failures.length + 1,
      });
    }
    failures.push(`${candidate.name ?? candidate.key.slice(0, 8)}: ${test.reason ?? "no-models"}`);
  }

  return NextResponse.json({
    ok: false,
    reason: "no-usable-key",
    message: `Tried ${ordered.length} key(s): ${failures.slice(0, 3).join("; ")}`,
  });
}
