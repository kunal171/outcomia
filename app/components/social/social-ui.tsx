"use client";
/** Small building blocks shared by profiles and leaderboards. */
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useIndexerUpdates } from "../use-indexer-updates";
import { knownTokenSymbol } from "../../lib/market-display";
import { TEST_USDC_MINT, TEST_USDC_SYMBOL } from "../../lib/collateral-display";
import type { Profile } from "../../lib/graphql/social";

/** Signed atoms → grouped decimal text, trimmed to `maxFraction` digits. */
export function formatAtoms(
  value: string | null | undefined,
  decimals: number,
  maxFraction = 2,
) {
  if (value == null || !/^-?\d+$/.test(value)) return "—";
  let atoms = BigInt(value);
  const negative = atoms < BigInt(0);
  if (negative) atoms = -atoms;
  const keep = Math.min(maxFraction, decimals);
  const step = BigInt(10) ** BigInt(decimals - keep);
  // Round half up at the displayed precision.
  const rounded = (atoms + step / BigInt(2)) / step;
  const shown = BigInt(10) ** BigInt(keep);
  const whole = (rounded / shown)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = keep
    ? (rounded % shown).toString().padStart(keep, "0").replace(/0+$/, "")
    : "";
  const text = fraction ? `${whole}.${fraction}` : whole;
  return negative && text !== "0" ? `-${text}` : text;
}

/** Display name for a mint: known test tokens first, then the indexer's
 * metadata symbol, then a shortened address. */
export function tokenLabel(mint: string, symbol?: string | null) {
  if (mint === TEST_USDC_MINT) return TEST_USDC_SYMBOL;
  try {
    const known = knownTokenSymbol(new PublicKey(mint));
    if (known) return known;
  } catch {
    /* Not an address; fall through. */
  }
  return symbol?.trim() || shortAddress(mint);
}

export function shortAddress(address: string) {
  return address.length > 10
    ? `${address.slice(0, 4)}…${address.slice(-4)}`
    : address;
}

export function profileHref(wallet: string, profile?: Profile | null) {
  return `/u/${profile?.username ?? wallet}`;
}

function hash(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Default avatar colour for a wallet without a profile. */
export function walletHue(wallet: string) {
  return hash(wallet) % 360;
}

/** A symmetric 5×5 pattern derived from the address; the colour comes from
 * the profile, or from the address when there is none. */
export function WalletAvatar({
  wallet,
  hue,
  size = 32,
}: {
  wallet: string;
  hue?: number | null;
  size?: number;
}) {
  const colour = hue ?? walletHue(wallet);
  const cells: { x: number; y: number }[] = [];
  let bits = hash(`${wallet}:pattern`);
  for (let y = 0; y < 5; y++)
    for (let x = 0; x < 3; x++) {
      if (bits & 1) {
        cells.push({ x, y });
        if (x < 2) cells.push({ x: 4 - x, y });
      }
      bits = bits >>> 1 || hash(`${wallet}:${y}:${x}`);
    }
  return (
    <svg
      className="wallet-avatar"
      width={size}
      height={size}
      viewBox="0 0 5 5"
      aria-hidden="true"
      style={{ background: `hsl(${colour} 70% 90%)` }}
    >
      {cells.map(({ x, y }) => (
        <rect
          key={`${x}:${y}`}
          x={x}
          y={y}
          width="1"
          height="1"
          fill={`hsl(${colour} 65% 42%)`}
        />
      ))}
    </svg>
  );
}

/** Avatar plus display name (or short address), linking to the profile. */
export function TraderName({
  wallet,
  profile,
  size = 28,
}: {
  wallet: string;
  profile?: Profile | null;
  size?: number;
}) {
  const primary =
    profile?.displayName ||
    (profile ? `@${profile.username}` : shortAddress(wallet));
  return (
    <Link className="trader-name" href={profileHref(wallet, profile)}>
      <WalletAvatar wallet={wallet} hue={profile?.avatarHue} size={size} />
      <span>
        <strong>{primary}</strong>
        {profile?.displayName && <small>@{profile.username}</small>}
      </span>
    </Link>
  );
}

/** Loads with `fetcher`, then refreshes quietly (keeping the shown data) on
 * live indexer updates, at most once per `minGapMs`. Data and errors are
 * tagged with the `deps` they belong to, so a view never renders another
 * view's rows during the render that switches between them. */
export function useQuietData<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  deps: unknown[],
  minGapMs = 10_000,
) {
  const key = JSON.stringify(deps);
  const [state, setState] = useState<{
    key: string;
    data: T | null;
    error: string | null;
    done: boolean;
  }>({ key, data: null, error: null, done: false });
  const [revision, setRevision] = useState(0);
  const last = useRef(0);
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const run = useRef(fetcher);
  run.current = fetcher;
  useEffect(() => {
    const controller = new AbortController();
    run
      .current(controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        last.current = Date.now();
        setState({ key, data, error: null, done: true });
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        const error = cause instanceof Error ? cause.message : String(cause);
        // A failed background refresh keeps the rows already shown.
        setState((s) =>
          s.key === key
            ? { ...s, error, done: true }
            : { key, data: null, error, done: true },
        );
      });
    return () => controller.abort();
  }, [key, revision]);
  const reload = useCallback(() => setRevision((v) => v + 1), []);
  useIndexerUpdates(() => {
    clearTimeout(pending.current);
    const wait = Math.max(0, last.current + minGapMs - Date.now());
    pending.current = setTimeout(() => setRevision((v) => v + 1), wait);
  });
  useEffect(() => () => clearTimeout(pending.current), []);
  const current = state.key === key;
  return {
    data: current ? state.data : null,
    error: current ? state.error : null,
    loading: !current || !state.done,
    reload,
  };
}
