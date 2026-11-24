/**
 * Probability series for prediction charts (pure, no React). Prices are
 * shares of the one-token payout, so a price of 0.62 reads as a 62% chance.
 * Candles come from the indexer as decimal-string atoms per time bucket.
 */

export type CandleLike = { time: string; close: string };
export type Point = { t: number; v: number };

/** Chart ranges in the Polymarket style, each with a bucket size that keeps
 * the series detailed but under the indexer's 2,000-bucket limit. */
export const RANGES = [
  { label: "1H", seconds: 3_600, interval: 60 },
  { label: "6H", seconds: 21_600, interval: 300 },
  { label: "1D", seconds: 86_400, interval: 300 },
  { label: "1W", seconds: 604_800, interval: 900 },
  { label: "1M", seconds: 2_592_000, interval: 3_600 },
  { label: "ALL", seconds: 7_776_000, interval: 14_400 },
] as const;
export type RangeLabel = (typeof RANGES)[number]["label"];

const toValue = (raw: string, decimals: number) => Number(raw) / 10 ** decimals;

/** One outcome's candles as points at each bucket's end (its close). */
export function pointsFrom(
  candles: CandleLike[],
  decimals: number,
  interval: number,
): Point[] {
  return candles
    .map((c) => ({
      t: Number(c.time) + interval,
      v: toValue(c.close, decimals),
    }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v));
}

/**
 * YES probability from both books: a NO trade at 0.30 implies YES at 0.70.
 * Where both outcomes traded in the same bucket, the YES close wins.
 * Example: YES@t1=0.60, NO@t2=0.35 → [t1: 0.60, t2: 0.65].
 */
export function binarySeries(
  yes: CandleLike[],
  no: CandleLike[],
  decimals: number,
  interval: number,
): Point[] {
  const byTime = new Map<number, number>();
  for (const p of pointsFrom(no, decimals, interval))
    byTime.set(p.t, Math.max(0, Math.min(1, 1 - p.v)));
  for (const p of pointsFrom(yes, decimals, interval)) byTime.set(p.t, p.v);
  return [...byTime.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, v]) => ({ t, v }));
}

/**
 * The line to draw over [from, to]: starts at `from` with the last price seen
 * before the window (if any), steps at each trade, and holds the latest price
 * to `to`. Points outside the window are dropped.
 */
export function heldLine(
  points: Point[],
  from: number,
  to: number,
  prior: number | null,
  interval = 0,
): Point[] {
  // A point sits at its bucket's end; the bucket still open now ends up to
  // one interval after `to`, so clamp it rather than drop the latest trade.
  const inside = points
    .filter((p) => p.t >= from && p.t < to + interval + (interval ? 0 : 1))
    .map((p) => (p.t > to ? { t: to, v: p.v } : p));
  const line: Point[] =
    prior === null ? [...inside] : [{ t: from, v: prior }, ...inside];
  if (!line.length) return [];
  line.push({ t: to, v: line[line.length - 1].v });
  return line;
}

/** Held value at time t: the latest point at or before t. */
export function valueAt(line: Point[], t: number): number | null {
  let value: number | null = null;
  for (const p of line) {
    if (p.t > t) break;
    value = p.v;
  }
  return value;
}

/** SVG path of a step line (horizontal hold, then vertical move). */
export function stepPath(
  line: Point[],
  x: (t: number) => number,
  y: (v: number) => number,
): string {
  return line
    .map((p, i) =>
      i
        ? `H${x(p.t).toFixed(1)} V${y(p.v).toFixed(1)}`
        : `M${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`,
    )
    .join(" ");
}

/**
 * Y-axis domain and ticks in probability (0–1): at least a 10-point span,
 * padded, snapped to round steps (1, 2, 2.5, 5, 10, 20, 25 points), inside
 * [0, 1]. Example: values 0.58–0.66 → 0.55–0.70 by 0.05.
 */
export function probabilityAxis(values: number[]) {
  if (!values.length) return { min: 0, max: 1, ticks: [0, 0.25, 0.5, 0.75, 1] };
  const lo = Math.min(...values),
    hi = Math.max(...values);
  const span = Math.max(hi - lo, 0.1),
    pad = span * 0.15;
  const step =
    [0.01, 0.02, 0.025, 0.05, 0.1, 0.2, 0.25].find(
      (s) => s * 5 >= span + 2 * pad,
    ) ?? 0.25;
  let min = Math.max(0, Math.floor((lo - pad) / step + 1e-9) * step);
  let max = Math.min(1, Math.ceil((hi + pad) / step - 1e-9) * step);
  if (max - min < step * 2) {
    if (max + step <= 1) max += step;
    else min = Math.max(0, min - step);
  }
  const ticks: number[] = [];
  for (let v = min; v <= max + 1e-9; v += step)
    ticks.push(Number(v.toFixed(4)));
  return { min, max, ticks };
}

/** Axis label: whole points, or one decimal for 2.5-point steps (27.5%). */
export function tickLabel(v: number): string {
  const p = Math.round(v * 1000) / 10;
  return `${Number.isInteger(p) ? p.toFixed(0) : p.toFixed(1)}%`;
}

/** "62%" with one decimal below 1% and above 99% so extremes stay readable. */
export function percent(v: number): string {
  const p = v * 100;
  if (p > 0 && p < 1) return `${p.toFixed(1)}%`;
  if (p > 99 && p < 100) return `${p.toFixed(1)}%`;
  return `${Math.round(p)}%`;
}
