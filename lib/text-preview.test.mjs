import assert from "node:assert/strict";
import { mkdtempSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { TEXT_PREVIEW_MAX_BYTES } = await jiti.import("./file-types.ts");
const { readTextPreviewChunk } = await jiti.import("./text-preview.ts");

test("reads large text in contiguous UTF-8 chunks", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-web-text-preview-"));
  const filePath = path.join(directory, "large.txt");
  t.after(() => unlinkSync(filePath));
  const prefix = "a".repeat(4095) + "中";
  const content = prefix + "a".repeat(TEXT_PREVIEW_MAX_BYTES - Buffer.byteLength(prefix) - 1) + "😀tail";
  writeFileSync(filePath, content);
  const size = statSync(filePath).size;

  const first = readTextPreviewChunk(filePath, size, 0);
  const second = readTextPreviewChunk(filePath, size, first.nextOffset);

  assert.equal(first.truncated, true);
  assert.equal(first.nextOffset, TEXT_PREVIEW_MAX_BYTES - 1);
  assert.equal(second.truncated, false);
  assert.equal(first.content + second.content, content);
  assert.equal(second.nextOffset, size);
});

test("detects binary content even when the filename appears to be text", (t) => {
  const filePath = path.join(mkdtempSync(path.join(tmpdir(), "pi-web-text-preview-")), "binary.txt");
  t.after(() => unlinkSync(filePath));
  for (const data of [Buffer.from([0x50, 0x4b, 0x03, 0x04, 0]), Buffer.alloc(4096, 0x80)]) {
    writeFileSync(filePath, data);
    assert.equal(readTextPreviewChunk(filePath, data.length, 0), null);
  }
});
