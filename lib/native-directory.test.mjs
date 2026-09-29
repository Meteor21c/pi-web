import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { nativeDirectoryCommand } = await createJiti(import.meta.url).import("./native-directory.ts");

test("opens project directories with the native file manager without shell interpolation", () => {
  const directory = "/Users/example/Project With Spaces";
  assert.deepEqual(nativeDirectoryCommand(directory, "darwin"), { command: "open", args: [directory] });
  assert.deepEqual(nativeDirectoryCommand("C:\\Users\\example\\Project With Spaces", "win32"), {
    command: "explorer.exe",
    args: ["C:\\Users\\example\\Project With Spaces"],
  });
  assert.deepEqual(nativeDirectoryCommand(directory, "linux"), { command: "xdg-open", args: [directory] });
});
