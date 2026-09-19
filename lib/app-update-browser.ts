import type { AppUpdateResponse } from "./api-types";

export const MANUAL_APP_UPDATE_RESULT_EVENT = "meteoragent:manual-app-update-result";

export function announceManualAppUpdateResult(result: AppUpdateResponse): void {
  window.dispatchEvent(new CustomEvent<AppUpdateResponse>(MANUAL_APP_UPDATE_RESULT_EVENT, { detail: result }));
}
