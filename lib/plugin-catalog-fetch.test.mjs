import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { parsePiPackageCatalogHtml } = await createJiti(import.meta.url).import("./plugin-catalog-fetch.ts");

const card = ({ name, types, description = "A useful package", downloads = "1234", repo = "" }) => `
  <article data-package-card="true" data-package-name="${name}" data-package-types="${types}"
    data-package-downloads="${downloads}" data-package-date="1789419235440">
    <div class="packages-card-body">
      <p class="packages-desc">${description}</p>
      <div class="packages-meta"><span>author-name</span><span>1.2K/mo</span><span>1d ago</span></div>
      <div class="packages-links">
        <a href="https://www.npmjs.com/package/${name}">npm</a>
        ${repo ? `<a href="${repo}">repo</a>` : ""}
      </div>
    </div>
  </article>`;

test("parses the official Pi catalog cards and assigns risk from declared resources", () => {
  const entries = parsePiPackageCatalogHtml([
    card({ name: "skill-only", types: "skill", description: "Skill &amp; docs", repo: "https://github.com/example/skill-only" }),
    card({ name: "prompt-only", types: "prompt" }),
    card({ name: "mixed-tool", types: "extension skill" }),
  ].join(""));

  assert.deepEqual(entries.map(({ name, category, risk }) => ({ name, category, risk })), [
    { name: "skill-only", category: "skill", risk: "low" },
    { name: "prompt-only", category: "prompt", risk: "low" },
    { name: "mixed-tool", category: "tool", risk: "review" },
  ]);
  assert.equal(entries[0].description.en, "Skill & docs");
  assert.equal(entries[0].repositoryUrl, "https://github.com/example/skill-only");
  assert.equal(entries[0].downloadsMonthly, 1234);
});

test("omits themes and untyped npm packages from the Magent community", () => {
  const entries = parsePiPackageCatalogHtml([
    card({ name: "theme-only", types: "theme" }),
    card({ name: "mixed-theme", types: "extension theme" }),
    card({ name: "untyped", types: "" }),
  ].join(""));
  assert.deepEqual(entries, []);
});
