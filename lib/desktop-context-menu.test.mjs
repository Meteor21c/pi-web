import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

const mainUrl = new URL("../desktop/main.cjs", import.meta.url);
const mainSource = await readFile(mainUrl, "utf8");
const require = createRequire(mainUrl);

function contextMenuFixture() {
  const frame = { url: "http://127.0.0.1:30341/" };
  const webContents = new EventEmitter();
  webContents.mainFrame = frame;
  webContents.setWindowOpenHandler = () => {};
  const window = { webContents };
  const shown = [];
  const electron = {
    app: {
      commandLine: { getSwitchValue: () => "" },
      requestSingleInstanceLock: () => false,
      getLocale: () => "zh-CN",
      quit: () => {},
    },
    Menu: {
      buildFromTemplate: (items) => ({ popup: (options) => shown.push({ items, options }) }),
    },
  };
  vm.runInNewContext(`${mainSource}\nprotectWindow(testWindow);`, {
    require: (name) => name === "electron" ? electron : require(name),
    process: { platform: "darwin", resourcesPath: "/resources" },
    __dirname: "/desktop",
    testWindow: window,
    URL,
  });

  return {
    frame,
    window,
    shown,
    rightClick: (params) => webContents.emit("context-menu", {}, { frame, x: 19, y: 34, ...params }),
  };
}

test("desktop menus use native edit roles and honor disabled input actions", () => {
  const { frame, rightClick, shown, window } = contextMenuFixture();
  rightClick({ isEditable: true, editFlags: { canUndo: true, canRedo: false, canCut: false, canCopy: false, canPaste: true, canSelectAll: true } });
  assert.equal(shown.length, 1);
  const [{ items, options }] = shown;
  assert.deepEqual(Array.from(items, (item) => item.role ?? item.type), ["undo", "redo", "separator", "cut", "copy", "paste", "separator", "selectAll"]);
  assert.equal(items[4].enabled, false);
  assert.equal(items[5].enabled, true);
  assert.equal(items[5].label, "粘贴");
  assert.equal(options.window, window);
  assert.equal(options.frame, frame);
});

test("desktop menus copy selected text while ignoring empty and nonlocal frames", () => {
  const { frame, rightClick, shown } = contextMenuFixture();
  const selection = { isEditable: false, selectionText: "sample", editFlags: { canCopy: true } };
  rightClick({ ...selection, frame: null });
  rightClick({ ...selection, frame: { url: frame.url } });
  rightClick({ ...selection, selectionText: "" });
  assert.equal(shown.length, 0);
  rightClick(selection);
  assert.equal(shown.length, 1);
  assert.deepEqual(Array.from(shown[0].items, (item) => item.role), ["copy"]);
});
