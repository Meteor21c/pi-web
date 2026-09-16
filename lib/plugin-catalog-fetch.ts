import type {
  CommunityPluginCategory,
  CommunityPluginCatalogResponse,
  CommunityPluginEntry,
  CommunityPluginLocale,
} from "./plugin-catalog";

const PI_CATALOG_ORIGIN = "https://pi.dev";
const CATALOG_TYPES = ["skill", "prompt", "extension"] as const;
const CATALOG_TTL_MS = 15 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

interface CatalogCache {
  entries: CommunityPluginEntry[];
  fetchedAt: string;
  expiresAt: number;
}

declare global {
  var __magentPluginCatalogCache: CatalogCache | undefined;
  var __magentPluginCatalogSearchCache: Map<string, CatalogCache> | undefined;
}

function decodeHtml(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, body: string) => {
      if (body.startsWith("#x") || body.startsWith("#X")) {
        return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
      }
      if (body.startsWith("#")) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
      return named[body.toLowerCase()] ?? entity;
    })
    .replace(/\s+/g, " ")
    .trim();
}

function attribute(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`\\b${name}="([^"]*)"`, "i"));
  return match ? decodeHtml(match[1]) : undefined;
}

function textFromClass(card: string, tag: string, className: string): string | undefined {
  const match = card.match(new RegExp(`<${tag}\\b[^>]*class="[^"]*\\b${className}\\b[^"]*"[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? decodeHtml(match[1]) : undefined;
}

function localized(values: Record<CommunityPluginLocale, string>): Record<CommunityPluginLocale, string> {
  return values;
}

function capabilitiesFor(types: Set<string>, category: CommunityPluginCategory) {
  const executable = types.has("extension");
  const englishTypes = [...types].map((type) => type === "skill" ? "Skill" : type === "prompt" ? "Prompt" : "Extension");
  const simplifiedTypes = [...types].map((type) => type === "skill" ? "技能" : type === "prompt" ? "提示词" : "可执行扩展");
  const traditionalTypes = [...types].map((type) => type === "skill" ? "技能" : type === "prompt" ? "提示詞" : "可執行擴充");
  if (!englishTypes.length) englishTypes.push(category === "tool" ? "Extension" : category === "skill" ? "Skill" : "Prompt");
  return {
    en: executable ? englishTypes : [...englishTypes, "No executable extension declared"],
    "zh-CN": executable ? simplifiedTypes : [...simplifiedTypes, "未声明可执行扩展"],
    "zh-TW": executable ? traditionalTypes : [...traditionalTypes, "未宣告可執行擴充"],
  } satisfies Record<CommunityPluginLocale, string[]>;
}

export function parsePiPackageCatalogHtml(html: string): CommunityPluginEntry[] {
  const entries: CommunityPluginEntry[] = [];
  const cards = html.match(/<article\b[^>]*data-package-card="true"[\s\S]*?<\/article>/gi) ?? [];

  for (const card of cards) {
    const openTag = card.match(/^<article\b[^>]*>/i)?.[0] ?? "";
    const name = attribute(openTag, "data-package-name");
    if (!name) continue;

    const types = new Set((attribute(openTag, "data-package-types") ?? "").split(/\s+/).filter(Boolean));
    if (types.has("theme")) continue;

    let category: CommunityPluginCategory | undefined;
    if (types.has("extension")) category = "tool";
    else if (types.has("skill")) category = "skill";
    else if (types.has("prompt")) category = "prompt";
    if (!category) continue;

    const description = textFromClass(card, "p", "packages-desc") ?? "";
    const meta = card.match(/<div\b[^>]*class="[^"]*\bpackages-meta\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? "";
    const metaValues = [...meta.matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)].map((match) => decodeHtml(match[1]));
    const repositoryUrl = [...card.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)]
      .find((match) => /\brepo\b/i.test(decodeHtml(match[2])))?.[1];
    const downloadsMonthly = Number.parseInt(attribute(openTag, "data-package-downloads") ?? "", 10);
    const publishedTimestamp = Number.parseInt(attribute(openTag, "data-package-date") ?? "", 10);

    entries.push({
      id: name,
      source: `npm:${name}`,
      name,
      description: localized({ en: description, "zh-CN": description, "zh-TW": description }),
      category,
      risk: category === "tool" ? "review" : "low",
      packageUrl: `${PI_CATALOG_ORIGIN}/packages/${name.split("/").map(encodeURIComponent).join("/")}`,
      repositoryUrl: repositoryUrl && /^https:\/\/github\.com\//i.test(repositoryUrl)
        ? decodeHtml(repositoryUrl)
        : undefined,
      capabilities: capabilitiesFor(types, category),
      author: metaValues[0] || undefined,
      downloadsMonthly: Number.isFinite(downloadsMonthly) ? downloadsMonthly : undefined,
      publishedAt: Number.isFinite(publishedTimestamp) ? new Date(publishedTimestamp).toISOString() : undefined,
      packageTypes: [...types],
    });
  }
  return entries;
}

function mergeCatalogEntries(groups: CommunityPluginEntry[][]): CommunityPluginEntry[] {
  const merged = new Map<string, CommunityPluginEntry>();
  for (const group of groups) {
    for (const entry of group) {
      const current = merged.get(entry.source);
      if (!current || (entry.category === "tool" && current.category !== "tool")) merged.set(entry.source, entry);
    }
  }
  return [...merged.values()];
}

async function fetchCatalogType(type: (typeof CATALOG_TYPES)[number]): Promise<CommunityPluginEntry[]> {
  const url = new URL("/packages", PI_CATALOG_ORIGIN);
  url.searchParams.set("type", type);
  url.searchParams.set("sort", "downloads");
  const response = await fetch(url, {
    cache: "no-store",
    headers: { Accept: "text/html", "User-Agent": "Magent/1.0 (+https://api.meteor21c.fun)" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Pi catalog returned HTTP ${response.status}`);
  const entries = parsePiPackageCatalogHtml(await response.text());
  if (!entries.length) throw new Error(`Pi catalog returned no ${type} packages`);
  return entries;
}

async function fetchCatalogSearch(query: string): Promise<CommunityPluginEntry[]> {
  const url = new URL("/packages", PI_CATALOG_ORIGIN);
  url.searchParams.set("name", query);
  url.searchParams.set("sort", "downloads");
  const response = await fetch(url, {
    cache: "no-store",
    headers: { Accept: "text/html", "User-Agent": "Magent/1.0 (+https://api.meteor21c.fun)" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Pi catalog search returned HTTP ${response.status}`);
  return parsePiPackageCatalogHtml(await response.text());
}

export async function getCommunityPluginCatalog(
  forceRefresh = false,
  searchQuery = "",
): Promise<CommunityPluginCatalogResponse> {
  const now = Date.now();
  const query = searchQuery.trim().slice(0, 120);
  if (query) {
    const key = query.toLocaleLowerCase();
    const searchCache = globalThis.__magentPluginCatalogSearchCache
      ??= new Map<string, CatalogCache>();
    const cachedSearch = searchCache.get(key);
    if (!forceRefresh && cachedSearch && cachedSearch.expiresAt > now) {
      return { entries: cachedSearch.entries, fetchedAt: cachedSearch.fetchedAt, source: "cache" };
    }
    try {
      const entries = await fetchCatalogSearch(query);
      const fetchedAt = new Date().toISOString();
      searchCache.set(key, { entries, fetchedAt, expiresAt: now + CATALOG_TTL_MS });
      return { entries, fetchedAt, source: "live" };
    } catch (error) {
      if (cachedSearch) {
        return {
          entries: cachedSearch.entries,
          fetchedAt: cachedSearch.fetchedAt,
          source: "cache",
          warning: error instanceof Error ? error.message : String(error),
        };
      }
      throw error;
    }
  }

  const cached = globalThis.__magentPluginCatalogCache;
  if (!forceRefresh && cached && cached.expiresAt > now) {
    return { entries: cached.entries, fetchedAt: cached.fetchedAt, source: "cache" };
  }

  try {
    const entries = mergeCatalogEntries(await Promise.all(CATALOG_TYPES.map(fetchCatalogType)));
    const fetchedAt = new Date().toISOString();
    globalThis.__magentPluginCatalogCache = { entries, fetchedAt, expiresAt: now + CATALOG_TTL_MS };
    return { entries, fetchedAt, source: "live" };
  } catch (error) {
    if (cached) {
      return {
        entries: cached.entries,
        fetchedAt: cached.fetchedAt,
        source: "cache",
        warning: error instanceof Error ? error.message : String(error),
      };
    }
    throw error;
  }
}
