import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./PwaRegistration.tsx", import.meta.url), "utf8");
const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
const manifest = await readFile(new URL("../app/manifest.ts", import.meta.url), "utf8");

test("offers desktop installation only when the browser exposes the PWA prompt", () => {
  assert.match(source, /addEventListener\("beforeinstallprompt"/);
  assert.match(source, /promptEvent\.preventDefault\(\)/);
  assert.match(source, /await installPrompt\.prompt\(\)/);
  assert.match(source, /await installPrompt\.userChoice/);
  assert.match(source, /if \(!showInstallPrompt \|\| !installPrompt\) return null/);
});

test("keeps installed and dismissed users out of the prompt flow", () => {
  assert.match(source, /matchMedia\("\(display-mode: standalone\)"\)/);
  assert.match(source, /navigator as NavigatorWithStandalone/);
  assert.match(source, /meteoragent-pwa-install-dismissed-v1/);
  assert.match(source, /addEventListener\("appinstalled"/);
  assert.match(css, /@media \(display-mode: standalone\) \{[\s\S]*?\.pwa-install-prompt \{[\s\S]*?display: none;/);
});

test("uses the MeteorAgent hamster assets for the installed app", () => {
  assert.match(source, /src="\/icons\/meteoragent-192\.png"/);
  assert.match(manifest, /src: "\/icons\/meteoragent-192\.png"/);
  assert.match(manifest, /src: "\/icons\/meteoragent-512\.png"/);
});
