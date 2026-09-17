import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./SidebarAccountMenu.tsx", import.meta.url), "utf8");

test("places a real local-service restart action below the account trigger", () => {
  assert.match(source, /data-restart-service="true"/);
  assert.match(source, /fetch\("\/api\/app-restart"/);
  assert.match(source, /window\.location\.reload\(\)/);
  assert.match(source, /window\.confirm\(t\("restart\.confirm"\)\)/);
});

test("keeps restart inside the expanded account menu", () => {
  assert.match(source, /\{open && \([\s\S]*?className=\{styles\.popover\}[\s\S]*?RestartLocalServiceButton \/>[\s\S]*?\)\}/);
  const triggerTail = source.slice(source.indexOf("aria-haspopup=\"menu\""));
  assert.doesNotMatch(triggerTail.split("    </div>", 1)[0], /RestartLocalServiceButton/);
});

test("does not offer restart while the launcher is unavailable or a task is running", () => {
  assert.match(source, /phase === "unsupported"/);
  assert.match(source, /runningCount > 0/);
  assert.match(source, /phase === "checking" \|\| phase === "unsupported" \|\| phase === "restarting" \|\| runningCount > 0/);
});
