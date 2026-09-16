/**
 * Keep ordinary wallet amounts compact while preserving small per-request
 * charges. A fixed two-decimal formatter turns valid relay charges such as
 * $0.0007514 into the misleading value $0.00.
 */
export function formatUsdPrecise(value: number): string {
  const amount = Number.isFinite(value) && value >= 0 ? value : 0;
  if (amount === 0) return "$0.00";
  if (amount < 0.000001) return "<$0.000001";

  const fractionDigits = amount >= 1 ? 2 : amount >= 0.01 ? 4 : 6;
  const [whole, rawFraction = ""] = amount.toFixed(fractionDigits).split(".");
  let fraction = rawFraction;
  while (fraction.length > 2 && fraction.endsWith("0")) fraction = fraction.slice(0, -1);
  return fraction ? `$${whole}.${fraction}` : `$${whole}`;
}
