/** Display helpers only. Chain timestamps and hashes remain authoritative. */
import type { BN } from "@anchor-lang/core";
import { predictionTime } from "./prediction";
import type { Locale } from "../i18n/config";

export function predictionCloseLabel(value: BN, locale: Locale = "en"): string {
  const seconds = Number(value.toString());
  const date = new Date(seconds * 1000);
  if (!Number.isSafeInteger(seconds) || Number.isNaN(date.getTime()))
    return predictionTime(value);
  // An explicit UTC zone avoids changing the apparent deadline across devices.
  const parts = new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  return `${part("day")} ${part("month")} ${part("year")} · ${hour}:${minute} UTC`;
}

export function predictionReviewLabel(
  seconds: BN,
  locale: Locale = "en",
): string {
  const units = [
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ] as const;
  const match = units.find(
    ([, size]) => seconds.gtn(0) && seconds.modn(size) === 0,
  );
  const unit = match?.[0] ?? "second";
  const count = match ? seconds.divn(match[1]).toString() : seconds.toString();
  // BigInt preserves large on-chain durations; this never touches signed data.
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit,
    unitDisplay: "long",
    useGrouping: false,
  }).format(BigInt(count)).replace(/\s+/g, " ");
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
