import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export function getStandaloneChatDirectory(): string {
  const cwd = join(getAgentDir(), "webagent-standalone-chats");
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  return cwd;
}
