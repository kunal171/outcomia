/** Display helpers only. Chain timestamps and hashes remain authoritative. */
import type { BN } from "@anchor-lang/core";
import { predictionTime } from "./prediction";

export function predictionCloseLabel(value: BN): string {
  const seconds = Number(value.toString());
  const date = new Date(seconds * 1000);
  if (!Number.isSafeInteger(seconds) || Number.isNaN(date.getTime()))
    return predictionTime(value);
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  return `${date.getUTCDate()} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()} · ${hour}:${minute} UTC`;
}

export function predictionReviewLabel(seconds: BN): string {
  for (const [unit, size] of [
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ] as const) {
    if (seconds.gtn(0) && seconds.modn(size) === 0) {
      const count = seconds.divn(size).toString();
      return `${count} ${unit}${count === "1" ? "" : "s"}`;
    }
  }
  return `${seconds.toString()} second${seconds.eqn(1) ? "" : "s"}`;
}

/** A rules reference may be shown as a link, never as executable URL content. */
export function rulesDocumentUrl(reference: string): string | null {
  const arweave = /^ar:\/\/([A-Za-z0-9_-]{43})$/.exec(reference);
  if (arweave) return `https://arweave.net/${arweave[1]}`;
  try {
    const url = new URL(reference);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}
