"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useRelaySession } from "@/hooks/useRelaySession";
import { relayLoginMessageKey, type BrowserLoginResult } from "@/lib/relay-session-client";
import { ConfigButton } from "./SettingsUi";

type Challenge = Extract<BrowserLoginResult, { status: "started" }>;
type Attempt = { controller: AbortController; id?: string };

export function RelayBrowserLogin({ onDone, disabled = false }: {
  onDone?: (accountId: string) => Promise<void> | void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const { browserLogin } = useRelaySession();
  const active = useRef<Attempt | null>(null);
  const [starting, setStarting] = useState(false);
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => () => {
    const attempt = active.current;
    attempt?.controller.abort();
    if (attempt?.id) void browserLogin("cancel", attempt.id);
  }, [browserLogin]);

  const cancel = () => {
    const attempt = active.current;
    if (!attempt) return;
    active.current = null;
    attempt.controller.abort();
    if (attempt.id) void browserLogin("cancel", attempt.id);
    setStarting(false);
    setChallenge(null);
    setMessage(null);
  };

  const start = async () => {
    if (active.current || disabled) return;
    const attempt: Attempt = { controller: new AbortController() };
    const signal = attempt.controller.signal;
    active.current = attempt;
    setMessage(null);
    setStarting(true);
    let tab: Window | null = null;
    try {
      tab = window.open("about:blank", "_blank");
      if (tab) tab.opener = null;
    } catch {
      tab = null;
    }

    try {
      const initial = await browserLogin("start", undefined, signal);
      if (initial.status === "started") attempt.id = initial.id;
      if (signal.aborted) {
        tab?.close();
        if (attempt.id) void browserLogin("cancel", attempt.id);
        return;
      }
      setStarting(false);
      if (initial.status !== "started") {
        tab?.close();
        setMessage(initial.status === "unavailable" ? "brand.auth.browserUnavailable"
          : initial.status === "error" ? relayLoginMessageKey(initial.message) : "brand.auth.browserCancelled");
        return;
      }
      const expiresAt = Date.now() + initial.expiresIn * 1000;
      setChallenge(initial);
      try {
        if (tab && !tab.closed) tab.location.replace(initial.verificationUrl);
      } catch {
        tab?.close();
      }
      while (!signal.aborted && Date.now() < expiresAt) {
        await new Promise((resolve) => setTimeout(resolve, initial.interval * 1000));
        if (signal.aborted || Date.now() >= expiresAt) break;
        const result = await browserLogin("poll", initial.id, signal);
        if (signal.aborted) return;
        if (result.status === "pending") continue;
        if (result.status === "authenticated") {
          active.current = null;
          setChallenge(null);
          await onDone?.(result.accountId);
          return;
        }
        setMessage(result.status === "expired" ? "brand.auth.browserExpired"
          : result.status === "denied" || result.status === "cancelled" ? "brand.auth.browserCancelled"
            : result.status === "error" ? relayLoginMessageKey(result.message) : "brand.auth.relayError");
        return;
      }
      if (!signal.aborted) setMessage("brand.auth.browserExpired");
    } catch {
      if (!signal.aborted) setMessage("brand.auth.relayError");
    } finally {
      if (active.current === attempt) {
        active.current = null;
        if (attempt.id) void browserLogin("cancel", attempt.id);
        setChallenge(null);
        setStarting(false);
      }
    }
  };

  return (
    <div style={{ display: "grid", gap: 8 }}>
      {!challenge && (
        <ConfigButton variant="primary" disabled={starting || disabled} onClick={() => void start()}>
          {t(starting ? "brand.auth.browserOpening" : "brand.auth.browserLogin")}
        </ConfigButton>
      )}
      {challenge && (
        <div style={{ display: "grid", gap: 8, fontSize: 13, lineHeight: 1.5 }}>
          <div role="status">{t("brand.auth.browserWaiting", { code: challenge.userCode })}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <a href={challenge.verificationUrl} target="_blank" rel="noopener noreferrer" style={{ color: "inherit", textDecoration: "underline" }}>
              {t("brand.auth.browserOpenAgain")}
            </a>
            <ConfigButton size="small" onClick={cancel}>{t("i18n.cancel")}</ConfigButton>
          </div>
        </div>
      )}
      {message && <div role="alert" style={{ fontSize: 13 }}>{t(message)}</div>}
    </div>
  );
}
