"use client";

import Image from "next/image";
import { useEffect, useState } from "react";

type InstallChoice = {
  outcome: "accepted" | "dismissed";
  platform: string;
};

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<InstallChoice>;
};

type NavigatorWithStandalone = Navigator & {
  standalone?: boolean;
};

const INSTALL_DISMISSED_KEY = "meteoragent-pwa-install-dismissed-v1";

function isStandaloneDisplay(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches
    || Boolean((navigator as NavigatorWithStandalone).standalone);
}

export function PwaRegistration() {
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showInstallPrompt, setShowInstallPrompt] = useState(false);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) {
      return;
    }

    const register = () => {
      const appVersion = process.env.NEXT_PUBLIC_APP_VERSION ?? "dev";
      const scriptUrl = `/sw.js?v=${encodeURIComponent(appVersion)}`;

      void navigator.serviceWorker.register(scriptUrl, {
        scope: "/",
        updateViaCache: "none",
      }).catch((error: unknown) => {
        console.error("Failed to register the MeteorAgent service worker:", error);
      });
    };

    if (document.readyState === "complete") {
      register();
      return;
    }

    window.addEventListener("load", register, { once: true });
    return () => window.removeEventListener("load", register);
  }, []);

  useEffect(() => {
    if (isStandaloneDisplay()) return;

    try {
      if (localStorage.getItem(INSTALL_DISMISSED_KEY) === "1") return;
    } catch {
      // Storage is optional; an unavailable store should not disable installation.
    }

    let revealTimer: number | undefined;
    const handleBeforeInstallPrompt = (event: Event) => {
      const promptEvent = event as BeforeInstallPromptEvent;
      promptEvent.preventDefault();
      setInstallPrompt(promptEvent);
      window.clearTimeout(revealTimer);
      revealTimer = window.setTimeout(() => setShowInstallPrompt(true), 1200);
    };
    const handleInstalled = () => {
      window.clearTimeout(revealTimer);
      setShowInstallPrompt(false);
      setInstallPrompt(null);
      try {
        localStorage.setItem(INSTALL_DISMISSED_KEY, "1");
      } catch {
        // Keep the installed app usable when storage is unavailable.
      }
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleInstalled);
    return () => {
      window.clearTimeout(revealTimer);
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleInstalled);
    };
  }, []);

  const dismissInstallPrompt = () => {
    setShowInstallPrompt(false);
    setInstallPrompt(null);
    try {
      localStorage.setItem(INSTALL_DISMISSED_KEY, "1");
    } catch {
      // Dismissal remains effective for the current page without storage.
    }
  };

  const installToDesktop = async () => {
    if (!installPrompt || installing) return;
    setInstalling(true);
    try {
      await installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      if (choice.outcome === "dismissed") dismissInstallPrompt();
    } finally {
      setInstalling(false);
    }
  };

  if (!showInstallPrompt || !installPrompt) return null;

  return (
    <aside className="pwa-install-prompt" aria-label="安装 MeteorAgent 桌面版">
      <Image
        className="pwa-install-prompt-icon"
        src="/icons/meteoragent-192.png"
        alt=""
        width={42}
        height={42}
      />
      <div className="pwa-install-prompt-copy">
        <strong>安装到桌面</strong>
        <span>使用独立窗口，并显示金丝熊图标。</span>
      </div>
      <div className="pwa-install-prompt-actions">
        <button type="button" className="pwa-install-prompt-primary" onClick={() => void installToDesktop()} disabled={installing}>
          {installing ? "正在打开…" : "安装"}
        </button>
        <button type="button" className="pwa-install-prompt-dismiss" onClick={dismissInstallPrompt} disabled={installing}>
          暂不
        </button>
      </div>
    </aside>
  );
}
