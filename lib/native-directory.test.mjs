import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { launchNativeCommand, nativeDirectoryCommand, nativeFileCommand } = await createJiti(import.meta.url).import("./native-directory.ts");

test("opens project directories with the native file manager without shell interpolation", () => {
  const directory = "/Users/example/Project With Spaces";
  assert.deepEqual(nativeDirectoryCommand(directory, "darwin"), { command: "open", args: [directory] });
  const windowsDirectory = nativeDirectoryCommand("D:/项目/Project With Spaces & Review", "win32");
  assert.equal(windowsDirectory.command, "powershell.exe");
  assert.equal(windowsDirectory.waitForExit, true);
  assert.deepEqual(windowsDirectory.env, {
    METEORAGENT_NATIVE_PATH: "D:\\项目\\Project With Spaces & Review",
    METEORAGENT_NATIVE_ACTION: "open",
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

  const windowsFile = "D:\\项目\\Project With Spaces\\文件 & [复核], 2026's.pdf";
  for (const action of ["open", "reveal"]) {
    const windowsAction = nativeFileCommand(windowsFile, action, "win32");
    assert.equal(windowsAction.command, "powershell.exe");
    assert.equal(windowsAction.waitForExit, true);
    assert.equal(windowsAction.args.at(-2), "-EncodedCommand");
    const script = Buffer.from(windowsAction.args.at(-1), "base64").toString("utf16le");
    assert.match(script, /\$start\.UseShellExecute = \$true/);
    assert.match(script, /\$start\.WindowStyle = .*::Normal/);
    assert.match(script, /'\/select,"' \+ \$target \+ '"'/);
    assert.ok(!script.includes(windowsFile));
    assert.deepEqual(windowsAction.env, {
      METEORAGENT_NATIVE_PATH: windowsFile,
      METEORAGENT_NATIVE_ACTION: action,
    });
  }
});

test("reports a native handler's immediate failure", async () => {
  await assert.rejects(launchNativeCommand({ command: process.execPath, args: ["-e", "process.exit(1)"] }),
    /Unable to open the item/);
});

test("waits for the Windows helper and reports failures beyond the desktop-handler grace period", async () => {
  const { waitForExit } = nativeDirectoryCommand("C:\\Example", "win32");
  await assert.rejects(launchNativeCommand({
    command: process.execPath,
    args: ["-e", "setTimeout(() => process.exit(1), 2_050)"],
    waitForExit,
  }), /Unable to open the item/);
});
