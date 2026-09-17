import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const linkSource = await readFile(new URL("./MeteorAgentDownloadLink.tsx", import.meta.url), "utf8");
const brandSource = await readFile(new URL("../lib/meteoragent-brand.ts", import.meta.url), "utf8");
const welcomeSource = await readFile(new URL("./NewSessionWelcome.tsx", import.meta.url), "utf8");
const sidebarSource = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const usageSource = await readFile(new URL("./RelayUsageSummary.tsx", import.meta.url), "utf8");

test("uses the official MeteorAgent download page with safe external-link attributes", () => {
  assert.match(brandSource, /METEORAGENT_DOWNLOAD_URL = "https:\/\/dl\.meteor21c\.fun"/);
  assert.match(linkSource, /href=\{METEORAGENT_DOWNLOAD_URL\}/);
  assert.match(linkSource, /target="_blank"/);
  assert.match(linkSource, /rel="noopener noreferrer"/);
  assert.match(linkSource, /data-meteoragent-download="true"/);
});

test("places the download bridge on the welcome page, sidebar, and relay dashboard", () => {
  assert.match(welcomeSource, /<MeteorAgentDownloadLink variant="banner" \/>/);
  assert.match(sidebarSource, /<MeteorAgentDownloadLink variant="compact" \/>/);
  assert.match(usageSource, /showBalance && <MeteorAgentDownloadLink variant="inline" \/>/);
});
