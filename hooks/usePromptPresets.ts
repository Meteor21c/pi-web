"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PromptPresetSettings } from "@/lib/prompt-presets";

const CHANGED_EVENT = "meteoragent:prompt-presets-changed";

export function usePromptPresets() {
  const [settings, setSettings] = useState<PromptPresetSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revision = useRef(0);
  const mounted = useRef(true);
  const mutationPending = useRef(false);

  const reload = useCallback(async () => {
    const requestRevision = ++revision.current;
    try {
      const response = await fetch("/api/prompt-presets", { cache: "no-store" });
      const data = await response.json() as PromptPresetSettings & { error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      if (mounted.current && requestRevision === revision.current) {
        setSettings(data);
        setError(null);
      }
    } catch (cause) {
      if (mounted.current && requestRevision === revision.current) setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const changed = (event: Event) => {
      revision.current += 1;
      setSettings((event as CustomEvent<PromptPresetSettings>).detail);
      setError(null);
    };
    const focus = () => { void reload(); };
    window.addEventListener(CHANGED_EVENT, changed);
    window.addEventListener("focus", focus);
    void reload();
    return () => {
      mounted.current = false;
      revision.current += 1;
      window.removeEventListener(CHANGED_EVENT, changed);
      window.removeEventListener("focus", focus);
    };
  }, [reload]);

  const update = useCallback(async (action: Record<string, unknown>): Promise<boolean> => {
    if (mutationPending.current) return false;
    mutationPending.current = true;
    setBusy(true);
    setError(null);
    revision.current += 1;
    try {
      const response = await fetch("/api/prompt-presets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action),
      });
      const data = await response.json() as PromptPresetSettings & { error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      window.dispatchEvent(new CustomEvent(CHANGED_EVENT, { detail: data }));
      return true;
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      mutationPending.current = false;
      if (mounted.current) setBusy(false);
    }
  }, []);

  return { settings, busy, error, update, reload };
}
