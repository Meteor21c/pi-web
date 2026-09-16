export const COMMUNITY_PLUGIN_CATEGORY_ORDER = ["skill", "prompt", "tool"] as const;

export type CommunityPluginCategory = (typeof COMMUNITY_PLUGIN_CATEGORY_ORDER)[number];
export type CommunityPluginRisk = "low" | "review";
export type CommunityPluginLocale = "en" | "zh-CN" | "zh-TW";
export type CommunityPluginCatalogSource = "live" | "cache";

export interface CommunityPluginEntry {
  id: string;
  source: string;
  name: string;
  description: Record<CommunityPluginLocale, string>;
  category: CommunityPluginCategory;
  risk: CommunityPluginRisk;
  packageUrl: string;
  repositoryUrl?: string;
  capabilities: Record<CommunityPluginLocale, string[]>;
  author?: string;
  downloadsMonthly?: number;
  publishedAt?: string;
  packageTypes?: string[];
}

export interface CommunityPluginCatalogResponse {
  entries: CommunityPluginEntry[];
  fetchedAt: string;
  source: CommunityPluginCatalogSource;
  warning?: string;
}

function searchableText(entry: CommunityPluginEntry): string {
  return [
    entry.name,
    entry.source,
    entry.author ?? "",
    entry.category,
    ...(entry.packageTypes ?? []),
    ...Object.values(entry.capabilities).flat(),
    ...Object.values(entry.description),
  ].join(" ").toLocaleLowerCase();
}

/** Keep the official catalog order inside each category (downloads by default). */
export function filterCommunityPluginCatalog(
  catalog: readonly CommunityPluginEntry[],
  category: CommunityPluginCategory | "all" = "all",
  query = "",
): CommunityPluginEntry[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const categoryRank = new Map(COMMUNITY_PLUGIN_CATEGORY_ORDER.map((value, index) => [value, index]));
  return catalog
    .filter((entry) => category === "all" || entry.category === category)
    .filter((entry) => !normalizedQuery || searchableText(entry).includes(normalizedQuery))
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => {
      const categoryDelta = (categoryRank.get(left.entry.category) ?? 0)
        - (categoryRank.get(right.entry.category) ?? 0);
      if (categoryDelta !== 0) return categoryDelta;
      if (left.entry.risk !== right.entry.risk) return left.entry.risk === "low" ? -1 : 1;
      return left.index - right.index;
    })
    .map(({ entry }) => entry);
}

/** Match `npm:foo` and `foo` in existing package settings. */
export function sameCommunityPluginSource(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const trimmed = value.trim();
    return trimmed.startsWith("npm:") ? trimmed.slice(4) : trimmed;
  };
  return normalize(left) === normalize(right);
}
