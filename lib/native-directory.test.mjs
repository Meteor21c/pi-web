import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { launchNativeCommand, nativeDirectoryCommand, nativeFileCommand } = await createJiti(import.meta.url).import("./native-directory.ts");

test("opens project directories with the native file manager without shell interpolation", () => {
  const directory = "/Users/example/Project With Spaces";
  assert.deepEqual(nativeDirectoryCommand(directory, "darwin"), { command: "open", args: [directory] });
  assert.deepEqual(nativeDirectoryCommand("C:\\Users\\example\\Project With Spaces", "win32"), {
    command: "explorer.exe",
    args: ["C:\\Users\\example\\Project With Spaces"],
  });
  assert.deepEqual(nativeDirectoryCommand(directory, "linux"), { command: "xdg-open", args: [directory] });
});

test("opens or reveals the original path without shell interpolation", () => {
  const file = "/Users/example/Project With Spaces/文件 & 复核.zip";
  assert.deepEqual(nativeFileCommand(file, "open", "darwin"), { command: "open", args: [file] });
  assert.deepEqual(nativeFileCommand(file, "reveal", "darwin"), { command: "open", args: ["-R", file] });
  assert.deepEqual(nativeFileCommand(file, "reveal", "linux"), {
    command: "xdg-open",
    args: ["/Users/example/Project With Spaces"],
  });

  const windowsFile = "C:\\Users\\example\\Project With Spaces\\文件 & [复核].zip";
  assert.deepEqual(nativeFileCommand(windowsFile, "reveal", "win32"), {
    command: "explorer.exe",
    args: ["/select,", windowsFile],
  });
  const windowsOpen = nativeFileCommand(windowsFile, "open", "win32");
  assert.equal(windowsOpen.command, "powershell.exe");
  assert.match(windowsOpen.args.at(-1), /Invoke-Item -LiteralPath/);
  assert.ok(!windowsOpen.args.includes(windowsFile));
  assert.equal(windowsOpen.env.METEORAGENT_NATIVE_FILE, windowsFile);
});

test("reports a native handler's immediate failure", async () => {
  await assert.rejects(launchNativeCommand({ command: process.execPath, args: ["-e", "process.exit(1)"] }),
    /Unable to open the item/);
});
