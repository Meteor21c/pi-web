import type { RelaySyncResult } from "./relay-keys-sync";

const pending = new Map<number, Promise<RelaySyncResult>>();

/** Shared by onboarding/settings. Counts follow the server sync contract. */
export function syncRelayConfig(generation = 0): Promise<RelaySyncResult> {
  const existing = pending.get(generation);
  if (existing) return existing;
  const task = (async () => {
    const response = await fetch("/api/relay-config/auto", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      signal: AbortSignal.timeout(120_000),
    });
    const result = await response.json() as RelaySyncResult;
    // A complete empty/revoked-key sync also mutates local configuration.
    if (response.ok && (result.ok || result.reason === "no-key" || result.reason === "no-usable-key")) {
      window.dispatchEvent(new Event("relay-config-updated"));
    }
    return response.ok ? result : { ...result, ok: false };
  })().finally(() => { pending.delete(generation); });
  pending.set(generation, task);
  return task;
}
