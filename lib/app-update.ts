const STABLE_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_UPDATE_BYTES = 512 * 1024 * 1024;

export interface AppUpdateManifest {
  version: string;
  artifact: string;
  sha256: string;
  bytes: number;
  releaseNotes: string[];
  publishedAt?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStableVersion(version: string): [number, number, number] | null {
  const match = STABLE_VERSION_PATTERN.exec(version);
  if (!match) return null;

  const parts = match.slice(1).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) return null;
  return parts as [number, number, number];
}

export function isNewerStableVersion(candidate: string, current: string): boolean {
  const candidateParts = parseStableVersion(candidate);
  const currentParts = parseStableVersion(current);
  if (!candidateParts || !currentParts) return false;

  for (let index = 0; index < candidateParts.length; index += 1) {
    if (candidateParts[index] !== currentParts[index]) {
      return candidateParts[index] > currentParts[index];
    }
  }
  return false;
}

export function getMeteorAgentReleaseUrl(version: string): string | null {
  if (!parseStableVersion(version)) return null;
  return "https://dl.meteor21c.fun/";
}

/** Validate every field used by the privileged updater before constructing a URL. */
export function parseAppUpdateManifest(value: unknown): AppUpdateManifest | null {
  if (!isRecord(value) || typeof value.version !== "string" || !parseStableVersion(value.version)) return null;
  const expectedArtifact = `meteor21c-webagent-${value.version}.tgz`;
  if (value.artifact !== expectedArtifact) return null;
  if (typeof value.sha256 !== "string" || !SHA256_PATTERN.test(value.sha256)) return null;
  if (typeof value.bytes !== "number" || !Number.isSafeInteger(value.bytes) || value.bytes <= 0 || value.bytes > MAX_UPDATE_BYTES) return null;
  const releaseNotes = Array.isArray(value.releaseNotes)
    ? value.releaseNotes
      .filter((note): note is string => typeof note === "string")
      .map((note) => note.trim())
      .filter(Boolean)
      .slice(0, 20)
      .map((note) => note.slice(0, 300))
    : [];
  const publishedAt = typeof value.publishedAt === "string" && Number.isFinite(Date.parse(value.publishedAt))
    ? value.publishedAt
    : undefined;
  return {
    version: value.version,
    artifact: expectedArtifact,
    sha256: value.sha256,
    bytes: value.bytes,
    releaseNotes,
    ...(publishedAt ? { publishedAt } : {}),
  };
}
