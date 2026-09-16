import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { formatUsdPrecise } = await jiti.import("./currency-format.ts");

test("keeps small real charges visible without making wallet amounts noisy", () => {
  assert.equal(formatUsdPrecise(0), "$0.00");
  assert.equal(formatUsdPrecise(137.231), "$137.23");
  assert.equal(formatUsdPrecise(0.03), "$0.03");
  assert.equal(formatUsdPrecise(0.0150716), "$0.0151");
  assert.equal(formatUsdPrecise(0.007514), "$0.007514");
  assert.equal(formatUsdPrecise(0.0007514), "$0.000751");
  assert.equal(formatUsdPrecise(0.0000004), "<$0.000001");
  assert.equal(formatUsdPrecise(Number.NaN), "$0.00");
});
