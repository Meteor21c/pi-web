import type { ToolResultMessage } from "./types";

export type ComputerUsePermission = "screen_recording" | "accessibility";

/** Only an explicit native denial confirms that this tool required the OS grant. */
export function deniedComputerUsePermission(result: ToolResultMessage): ComputerUsePermission | undefined {
  if (!result.isError || !result.toolName?.startsWith("computer_use_")) return;
  const details = result.details as { code?: unknown; error?: { code?: unknown } } | undefined;
  const code = details?.error?.code ?? details?.code;
  for (const block of result.content) {
    if (block.type !== "text") continue;
    const text = block.text.trimStart();
    if (/^Screen Recording permission not granted\b/i.test(text)) return "screen_recording";
    if (/^Accessibility permission not granted\b/i.test(text)) return "accessibility";
  }
  if (code === "sc_not_granted") return "screen_recording";
  if (code === "ax_not_granted") return "accessibility";
}

/** The plugin adds a permissions hint even when its generic capture command failed. */
export function computerUseCaptureFailed(result: ToolResultMessage): boolean {
  return Boolean(result.isError && result.toolName?.startsWith("computer_use_") && result.content.some((block) =>
    block.type === "text" && /^Screenshot (?:failed for (?:the main display|window)|captured an empty image)/i.test(block.text.trimStart()),
  ));
}

export function computerUsePermissionCheck(result: ToolResultMessage, permission: ComputerUsePermission): boolean | undefined {
  if (result.isError || result.toolName !== "computer_use_check_permissions") return;
  const details = result.details as Partial<Record<ComputerUsePermission | "direct_capture_status", unknown>> | undefined;
  if (permission === "screen_recording" && details?.direct_capture_status === "blocked_by_screen_recording") return false;
  const value = details?.[permission];
  if (typeof value === "boolean") return value;
}
