export const SUBAGENT_MODES = ["auto", "off", "on"] as const;
export type SubagentMode = typeof SUBAGENT_MODES[number];

export const DEFAULT_SUBAGENT_MODE: SubagentMode = "auto";
export const AUTOMATIC_SUBAGENT_RETRY_TYPE = "meteoragent:subagent-retry";
export const SUBAGENT_RESULTS_TYPE = "meteoragent:subagent-results";
export const DEFAULT_SUBAGENT_MAX_CONCURRENT = 10;
export const MAX_SUBAGENT_MAX_CONCURRENT = 20;

export function isSubagentMode(value: unknown): value is SubagentMode {
  return value === "auto" || value === "off" || value === "on";
}
