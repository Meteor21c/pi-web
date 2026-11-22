export type ComputerUseApprovalPolicy = "ask" | "full";

export function isComputerUseApprovalPolicy(value: unknown): value is ComputerUseApprovalPolicy {
  return value === "ask" || value === "full";
}
