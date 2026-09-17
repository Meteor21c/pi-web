"use client";

import { useI18n } from "@/hooks/useI18n";
import { METEORAGENT_DOWNLOAD_URL } from "@/lib/meteoragent-brand";

type Variant = "banner" | "compact" | "inline";

/**
 * A small, consistent bridge between the meteor21c relay and the MeteorAgent
 * desktop client. Keep this as an ordinary external link: the download page
 * decides whether to offer Windows, macOS, or the manual package.
 */
export function MeteorAgentDownloadLink({ variant = "inline" }: { variant?: Variant }) {
  const { t } = useI18n();
  const className = variant === "banner"
    ? "meteoragent-download-banner"
    : variant === "compact"
      ? "meteoragent-download-compact"
      : "meteoragent-download-inline";

  return (
    <a
      href={METEORAGENT_DOWNLOAD_URL}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
      data-meteoragent-download="true"
      title={variant === "banner" ? t("brand.download.description") : t("brand.download.action")}
    >
      <svg className="meteoragent-download-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 3v12" />
        <path d="m7 10 5 5 5-5" />
        <path d="M5 21h14" />
      </svg>
      {variant === "banner" ? (
        <span className="meteoragent-download-copy">
          <strong>{t("brand.download.title")}</strong>
          <small>{t("brand.download.description")}</small>
        </span>
      ) : (
        <span>{t("brand.download.short")}</span>
      )}
      {variant === "banner" && <span className="meteoragent-download-action">{t("brand.download.action")} <span aria-hidden="true">↗</span></span>}
    </a>
  );
}
