import { NextResponse } from "next/server";
import { listRelayAccounts } from "@/lib/relay-auth";
import { isApiRequestAllowed } from "@/lib/request-security";
import { readRelayGroups } from "@/lib/relay-group-store";
import { readModelsConfig } from "@/lib/models-config-store";

export const dynamic = "force-dynamic";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function protocolsFor(provider: Record<string, unknown> | undefined): string[] {
  if (!provider) return [];
  const protocols = new Set<string>();
  if (typeof provider.api === "string") protocols.add(provider.api);
  if (Array.isArray(provider.models)) {
    for (const model of provider.models) {
      const entry = asRecord(model);
      if (typeof entry?.api === "string") protocols.add(entry.api);
    }
  }
  return [...protocols];
}

/** Token-free account switcher data. The active account remains the default for older APIs. */
export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  const { accounts, activeAccountId } = await listRelayAccounts();
  const indexedGroups = readRelayGroups();
  const providers = asRecord(readModelsConfig().providers);
  const safeAccounts = accounts.map((account) => ({
    accountId: account.accountId,
    email: account.email,
    username: account.user?.username,
    balance: account.user?.balance,
    status: account.user?.status,
    active: account.accountId === activeAccountId,
    groups: indexedGroups
      .filter((group) => group.accountId === account.accountId)
      .map((group) => {
        const provider = asRecord(providers?.[group.providerId]);
        // The provider file may still contain a legacy catalog. The account
        // index is authoritative for synced groups; missing snapshots are
        // shown as zero until the user synchronizes the group.
        const chatModelCount = Array.isArray(group.modelIds)
          ? group.modelIds.length
          : 0;
        const imageModelCount = group.imageModels?.length ?? 0;
        const protocols = protocolsFor(provider);
        if (imageModelCount > 0) protocols.push("openai-images");
        return {
          ...group,
          modelCount: chatModelCount + imageModelCount,
          chatModelCount,
          imageModelCount,
          protocols: [...new Set(protocols)],
        };
      }),
  }));
  return NextResponse.json({
    ok: true,
    accounts: safeAccounts,
    groups: safeAccounts.flatMap((account) => account.groups),
    activeAccountId,
  }, { headers: { "Cache-Control": "no-store" } });
}
