import type { TranslationParams } from "./i18n/types";

export const SUBAGENT_NOTIFICATION_TYPE = "pi-web:subagent-notification";

interface SubagentDisplayIdentity {
  description?: string | null;
  name?: string | null;
  profile?: string | null;
}

function localizedBuiltInName(value: string, t: (key: string, params?: TranslationParams) => string): string {
  switch (value.toLowerCase()) {
    case "general-purpose":
    case "general purpose":
      return t("subagent.profile.generalPurpose");
    case "explore":
      return t("subagent.profile.explore");
    case "plan":
      return t("subagent.profile.plan");
    default:
      return value;
  }
}

export function getSubagentDisplayName(
  identity: SubagentDisplayIdentity,
  t: (key: string, params?: TranslationParams) => string,
): string {
  for (const value of [identity.description, identity.name, identity.profile]) {
    const candidate = value?.trim().replace(/^pi-web:\s*/i, "");
    if (!candidate || /^(?:subagent|subagent-notification|pi-web-subagent)$/i.test(candidate)) continue;
    return localizedBuiltInName(candidate, t);
  }
  return t("agentSwitcher.subagent");
}
