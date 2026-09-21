import { lt, valid } from "semver";

/**
 * MeteorAgent ships a small, deliberately boring set of starter capabilities.
 *
 * These are references to the packages published in Pi's official community,
 * not forks or vendored copies.  Keeping the source unpinned is intentional:
 * users can update the same package from Settings → Plugins, while a future
 * MeteorAgent release can refresh this recommendation list independently.
 *
 * Download counts are evidence captured from pi.dev on 2026-09-17.  They are
 * displayed as context only and are never used as a trust decision.
 */

export const BUILTIN_PLUGIN_DEFINITIONS = [
  {
    id: "web-access",
    name: "网页访问",
    source: "npm:pi-web-access",
    purpose: "搜索网页、读取页面、GitHub、PDF 和视频内容",
    purposeEn: "Search and read webpages, GitHub, PDFs, and video pages",
    category: "tool",
    risk: "review",
    recommendedVersion: "0.30.0",
    downloadsMonthly: 423_107,
    officialUrl: "https://pi.dev/packages/pi-web-access",
    repositoryUrl: "https://github.com/nicobailon/pi-web-access",
    requiresNetwork: true,
  },
  {
    id: "docparser",
    name: "文档处理",
    source: "npm:pi-docparser",
    purpose: "读取、检索和截图常见文档",
    purposeEn: "Read, search, and capture common document formats",
    category: "tool",
    risk: "review",
    recommendedVersion: "4.0.0",
    downloadsMonthly: 4_991,
    officialUrl: "https://pi.dev/packages/pi-docparser",
    repositoryUrl: "https://github.com/maxedapps/pi-docparser",
    requiresNetwork: false,
  },
  {
    id: "image-gen",
    name: "图片生成",
    source: "npm:@amaster.ai/pi-image-gen",
    purpose: "通过当前中转站的生图模型生成图片",
    purposeEn: "Generate images with the image models available on your relay",
    category: "tool",
    risk: "review",
    recommendedVersion: "0.1.17",
    downloadsMonthly: 9_291,
    officialUrl: "https://pi.dev/packages/@amaster.ai/pi-image-gen?name=image",
    repositoryUrl: "https://github.com/TGYD-helige/pi",
    requiresNetwork: true,
  },
  {
    id: "computer-use",
    name: "电脑操作",
    source: "npm:@amaster.ai/pi-computer-use",
    purpose: "在明确启用的会话中查看并操作本机桌面",
    purposeEn: "Inspect and control the local desktop in sessions where you enable it",
    category: "tool",
    risk: "review",
    recommendedVersion: "0.1.17",
    downloadsMonthly: 6_780,
    officialUrl: "https://pi.dev/packages/@amaster.ai/pi-computer-use?name=computer",
    repositoryUrl: "https://github.com/TGYD-helige/pi/tree/master/packages/pi-computer-use",
    requiresNetwork: false,
    // Desktop control should be opt-in per conversation. It remains visible
    // in the session plugin picker but starts disabled for every new session.
    activationMode: "session",
  },
] as const;

export type BuiltinPluginDefinition = (typeof BUILTIN_PLUGIN_DEFINITIONS)[number];
export type BuiltinPluginId = BuiltinPluginDefinition["id"];

/**
 * Return the exact package source audited with this Magent release. Only the
 * original unpinned starter source is eligible: user pins/ranges and alternate
 * sources stay under the user's control, and a newer installed version is
 * never downgraded.
 */
export function builtinRecommendedUpdateSource(
  definition: BuiltinPluginDefinition,
  configuredSource: string,
  installedVersion: string | undefined,
): string | undefined {
  if (configuredSource.trim() !== definition.source || !installedVersion) return undefined;
  if (!valid(installedVersion) || !valid(definition.recommendedVersion)) return undefined;
  if (!lt(installedVersion, definition.recommendedVersion)) return undefined;
  const packageName = npmPackageName(definition.source);
  return packageName ? `npm:${packageName}@${definition.recommendedVersion}` : undefined;
}

export function builtinPluginById(id: string): BuiltinPluginDefinition | undefined {
  return BUILTIN_PLUGIN_DEFINITIONS.find((plugin) => plugin.id === id);
}

/**
 * Compare an npm source by package name while deliberately ignoring a version
 * range.  The user may already have configured `npm:pkg@^1` or `pkg@latest`;
 * treating that as the same package avoids replacing their choice with the
 * unpinned starter source.
 */
export function npmPackageName(source: string): string | undefined {
  const value = source.trim().startsWith("npm:") ? source.trim().slice(4).trim() : source.trim();
  const match = value.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@.+)?$/);
  return match?.[1];
}

export function sameNpmPackageSource(left: string, right: string): boolean {
  const leftName = npmPackageName(left);
  const rightName = npmPackageName(right);
  return Boolean(leftName && rightName && leftName === rightName);
}
