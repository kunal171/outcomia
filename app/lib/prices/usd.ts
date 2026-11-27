/** Exact USD arithmetic for P&L. Prices are decimal strings; amounts are
 * integer atom strings with their token decimals. */
export type Price = {
  usd: string;
  source: "fixed" | "pyth";
  publishTime?: number;
};

/** Pyth's integer price and exponent as an exact decimal string. */
export function pythDecimal(price: string, expo: number): string {
  if (!/^-?\d+$/.test(price) || !Number.isInteger(expo))
    throw new Error("Invalid Pyth price");
  const negative = price.startsWith("-");
  const digits = negative ? price.slice(1) : price;
  if (expo >= 0) return (negative ? "-" : "") + digits + "0".repeat(expo);
  const places = -expo;
  const padded = digits.padStart(places + 1, "0");
  const whole = padded.slice(0, -places);
  const frac = padded.slice(-places).replace(/0+$/, "");
  return (negative ? "-" : "") + whole + (frac ? `.${frac}` : "");
}

/** Latest parsed prices from a Hermes `/v2/updates/price/latest` response, by
 * feed id with `0x`. Stale prices (older than `maxAgeSeconds`) are dropped. */
export function parseHermes(
  body: unknown,
  nowSeconds: number,
  maxAgeSeconds = 300,
): Record<string, Price> {
  const parsed = (body as { parsed?: unknown[] })?.parsed;
  if (!Array.isArray(parsed)) throw new Error("Invalid Hermes response");
  const out: Record<string, Price> = {};
  for (const row of parsed) {
    const r = (row ?? {}) as { id?: unknown; price?: Record<string, unknown> };
    const p = r.price ?? {};
    if (typeof r.id !== "string" || typeof p.price !== "string") continue;
    const publishTime = Number(p.publish_time);
    if (
      !Number.isFinite(publishTime) ||
      nowSeconds - publishTime > maxAgeSeconds
    )
      continue;
    const usd = pythDecimal(p.price, Number(p.expo));
    if (usd.startsWith("-")) continue;
    out[`0x${r.id.replace(/^0x/, "")}`] = { usd, source: "pyth", publishTime };
  }
  return out;
}

const SCALE = 8;
function scaled(decimal: string): bigint {
  const [whole, frac = ""] = decimal.split(".");
  return BigInt(whole + frac.padEnd(SCALE, "0").slice(0, SCALE));
}

/** Atoms × price as USD micro-cents (1e-8 USD), truncated toward zero. */
export function atomsToUsd8(
  atoms: string,
  decimals: number,
  usd: string,
): bigint {
  return (BigInt(atoms) * scaled(usd)) / BigInt(10) ** BigInt(decimals);
}

/** USD (1e-8 units) as a dollar string with 2 decimals, rounded half away from zero. */
export function formatUsd8(value: bigint): string {
  const negative = value < BigInt(0);
  const abs = negative ? -value : value;
  const cents = (abs + BigInt(500000)) / BigInt(1000000);
  const s = cents.toString().padStart(3, "0");
  return `${negative && cents > BigInt(0) ? "-" : ""}${s.slice(0, -2)}.${s.slice(-2)}`;
}

export type PnlRow = {
  chain: "solana" | "canton";
  /** Price key: `solana:<mint>` or `canton:<instrument id>`. */
  asset: string;
  label: string;
  decimals: number;
  /** Realized and unrealized P&L in atoms (may be negative). */
  realized: string;
  unrealized: string;
};

/** Per-asset P&L converted to USD and summed. Assets without a price are
 * returned separately and left out of the total. */
export function combinePnl(rows: PnlRow[], prices: Record<string, Price>) {
  const priced: (PnlRow & { usd: string; price: Price })[] = [];
  const unpriced: PnlRow[] = [];
  let total = BigInt(0);
  for (const row of rows) {
    const price = prices[row.asset];
    if (!price) {
      unpriced.push(row);
      continue;
    }
    const usd =
      atomsToUsd8(row.realized, row.decimals, price.usd) +
      atomsToUsd8(row.unrealized, row.decimals, price.usd);
    total += usd;
    priced.push({ ...row, usd: formatUsd8(usd), price });
  }
  return { totalUsd: formatUsd8(total), priced, unpriced };
}
