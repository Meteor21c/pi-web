"use client";

import { useEffect, useSyncExternalStore } from "react";
import { createRelaySessionClient } from "@/lib/relay-session-client";

const enabled = process.env.NEXT_PUBLIC_AUTH_GATE === "1";
const client = createRelaySessionClient(enabled);
export type { RelaySessionStatus } from "@/lib/relay-session-client";

export function useRelaySession() {
  const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getServerSnapshot);
  useEffect(() => {
    if (!enabled) return;
    void client.initialize();
    const onStorage = (event: StorageEvent) => {
      if (event.key === "relay-session-changed") void client.recheck();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  return { ...snapshot, login: client.login, logout: client.logout, recheck: client.recheck };
}
