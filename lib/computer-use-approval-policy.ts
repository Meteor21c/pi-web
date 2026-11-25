export type ComputerUseApprovalPolicy = "ask" | "full";

const PREFERENCE_KEY = "meteoragent:computer-use-approval-policy";

export function isComputerUseApprovalPolicy(value: unknown): value is ComputerUseApprovalPolicy {
  return value === "ask" || value === "full";
}

export function readPreferredApprovalPolicy(): ComputerUseApprovalPolicy {
  if (typeof window === "undefined") return "ask";
  try {
    const saved = window.localStorage.getItem(PREFERENCE_KEY);
    return isComputerUseApprovalPolicy(saved) ? saved : "ask";
  } catch {
    return "ask";
  }
}

export function savePreferredApprovalPolicy(policy: ComputerUseApprovalPolicy): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PREFERENCE_KEY, policy);
  } catch {
    // The current window can still use the selection when storage is unavailable.
  }
}
