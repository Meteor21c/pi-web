/**
 * The small, low-risk slice of the Pi package catalog shown in Magent.
 *
 * Keep this data separate from the settings UI so a future
 * `/api/plugins/catalog` response can replace it without changing the
 * install flow. The full Pi catalog also contains TUI, shortcut, theme, and
 * provider packages; those are intentionally not included here yet.
 */

export const COMMUNITY_PLUGIN_CATEGORY_ORDER = ["skill", "prompt", "tool"] as const;

export type CommunityPluginCategory = (typeof COMMUNITY_PLUGIN_CATEGORY_ORDER)[number];
export type CommunityPluginRisk = "low" | "review";
export type CommunityPluginLocale = "en" | "zh-CN" | "zh-TW";

export interface CommunityPluginEntry {
  /** Stable UI key. It is not used as the package source. */
  id: string;
  /** Source accepted by DefaultPackageManager.installAndPersist. */
  source: string;
  name: string;
  description: Record<CommunityPluginLocale, string>;
  category: CommunityPluginCategory;
  /** `review` means executable code is involved and the warning is important. */
  risk: CommunityPluginRisk;
  packageUrl: string;
  repositoryUrl?: string;
  /** Human-readable capability hints shown before installation. */
  capabilities: Record<CommunityPluginLocale, string[]>;
}

/**
 * A deliberately conservative starter catalog.
 *
 * The entries are package sources from pi.dev's public catalog. A package can
 * contain more than one resource kind, so the category describes the
 * resource the Magent UI is recommending, not a claim that the whole package
 * is sandboxed. Every executable package keeps the install disclaimer.
 */
export const COMMUNITY_PLUGIN_CATALOG: readonly CommunityPluginEntry[] = [
  {
    id: "llm-wiki",
    source: "npm:@micuintus/llm-wiki",
    name: "llm-wiki",
    description: {
      en: "A lightweight, Markdown-only skill for maintaining a long-lived knowledge wiki.",
      "zh-CN": "纯 Markdown 的轻量知识库技能，用于持续整理和维护项目知识。",
      "zh-TW": "純 Markdown 的輕量知識庫技能，用於持續整理和維護專案知識。",
    },
    category: "skill",
    risk: "low",
    packageUrl: "https://pi.dev/packages/@micuintus/llm-wiki",
    capabilities: {
      en: ["Skill only", "No dependencies", "No executable extension"],
      "zh-CN": ["仅技能", "无依赖", "不含可执行扩展"],
      "zh-TW": ["僅技能", "無依賴", "不含可執行擴充"],
    },
  },
  {
    id: "remove-ai-writing-indicators",
    source: "npm:remove-ai-writing-indicators",
    name: "remove-ai-writing-indicators",
    description: {
      en: "A Markdown-only writing skill for finding and reducing common AI-writing patterns.",
      "zh-CN": "纯 Markdown 写作技能，用于识别并减少常见的 AI 写作痕迹。",
      "zh-TW": "純 Markdown 寫作技能，用於識別並減少常見的 AI 寫作痕跡。",
    },
    category: "skill",
    risk: "low",
    packageUrl: "https://pi.dev/packages/remove-ai-writing-indicators",
    capabilities: {
      en: ["Skill only", "No dependencies", "No executable extension"],
      "zh-CN": ["仅技能", "无依赖", "不含可执行扩展"],
      "zh-TW": ["僅技能", "無依賴", "不含可執行擴充"],
    },
  },
  {
    id: "pi-plugins-prompts",
    source: "npm:@pi-plugins/prompts",
    name: "@pi-plugins/prompts",
    description: {
      en: "Two reusable prompt templates for simplifying code and reviewing diffs.",
      "zh-CN": "用于简化代码和审查变更的两个可复用提示词模板。",
      "zh-TW": "用於簡化程式碼和審查變更的兩個可重用提示詞範本。",
    },
    category: "prompt",
    risk: "low",
    packageUrl: "https://pi.dev/packages/@pi-plugins/prompts",
    capabilities: {
      en: ["Prompt only", "No dependencies", "No executable extension"],
      "zh-CN": ["仅提示词", "无依赖", "不含可执行扩展"],
      "zh-TW": ["僅提示詞", "無依賴", "不含可執行擴充"],
    },
  },
  {
    id: "pi-hermes-memory",
    source: "npm:pi-hermes-memory",
    name: "pi-hermes-memory",
    description: {
      en: "Persistent memory and session search tools for Pi.",
      "zh-CN": "为 Pi 提供持久记忆和会话搜索工具。",
      "zh-TW": "為 Pi 提供持久記憶與會話搜尋工具。",
    },
    category: "tool",
    risk: "review",
    packageUrl: "https://pi.dev/packages/pi-hermes-memory",
    capabilities: {
      en: ["Executable extension", "Uses local storage"],
      "zh-CN": ["可执行扩展", "使用本地存储"],
      "zh-TW": ["可執行擴充", "使用本機儲存"],
    },
  },
  {
    id: "pi-simplify",
    source: "npm:pi-simplify",
    name: "pi-simplify",
    description: {
      en: "A code-review helper for recently changed files.",
      "zh-CN": "用于检查最近修改文件的代码审查工具。",
      "zh-TW": "用於檢查最近修改檔案的程式碼審查工具。",
    },
    category: "tool",
    risk: "review",
    packageUrl: "https://pi.dev/packages/pi-simplify",
    capabilities: {
      en: ["Executable extension", "Reads workspace files"],
      "zh-CN": ["可执行扩展", "读取工作区文件"],
      "zh-TW": ["可執行擴充", "讀取工作區檔案"],
    },
  },
] as const;

function searchableText(entry: CommunityPluginEntry): string {
  return [
    entry.name,
    entry.source,
    entry.category,
    ...Object.values(entry.capabilities).flat(),
    ...Object.values(entry.description),
  ].join(" ").toLocaleLowerCase();
}

/**
 * Keep the visible order stable: skills, prompts, then executable tools;
 * within a category, low-risk entries come first.
 */
export function filterCommunityPluginCatalog(
  catalog: readonly CommunityPluginEntry[] = COMMUNITY_PLUGIN_CATALOG,
  category: CommunityPluginCategory | "all" = "all",
  query = "",
): CommunityPluginEntry[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const categoryRank = new Map(COMMUNITY_PLUGIN_CATEGORY_ORDER.map((value, index) => [value, index]));
  return catalog
    .filter((entry) => category === "all" || entry.category === category)
    .filter((entry) => !normalizedQuery || searchableText(entry).includes(normalizedQuery))
    .slice()
    .sort((left, right) => {
      const categoryDelta = (categoryRank.get(left.category) ?? 0) - (categoryRank.get(right.category) ?? 0);
      if (categoryDelta !== 0) return categoryDelta;
      if (left.risk !== right.risk) return left.risk === "low" ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
}

/** Match `npm:foo` and `foo` in existing package settings. */
export function sameCommunityPluginSource(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const trimmed = value.trim();
    return trimmed.startsWith("npm:") ? trimmed.slice(4) : trimmed;
  };
  return normalize(left) === normalize(right);
}
