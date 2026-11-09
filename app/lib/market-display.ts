/** Display names supplement addresses; prices always use the market's mint decimals. */
import type { PublicKey } from "@solana/web3.js";
import { BN } from "@anchor-lang/core";
import type { MarketAccount, MarketMetadataAccount } from "./outcomia";
import { formatAtomicAmount } from "./outcomia";

// Valueless test assets recorded in docs/devnet-addresses.md. Do not label an
// unknown mint BTC/USDT just because somebody chose similar market symbols.
const DEVNET_TOKENS: Record<string, string> = {
  FggaZG7eJ5tpr2vmpNMbMCHkWkcw9n2Nhmf54g3wQwGk: "tBTC",
  "8KRa3QwidV2yZspR3wr4p3eNzq2KtejMbU1tZUgNLdtt": "tUSDT",
};

export function knownTokenSymbol(mint: PublicKey): string | null {
  return DEVNET_TOKENS[mint.toBase58()] ?? null;
}

export function marketLabels(
  market: MarketAccount,
  metadata: MarketMetadataAccount | null | undefined,
) {
  const base =
    metadata?.baseSymbol ||
    DEVNET_TOKENS[market.baseMint.toBase58()] ||
    "Base token";
  const quote =
    metadata?.quoteSymbol ||
    DEVNET_TOKENS[market.quoteMint.toBase58()] ||
    "Quote token";
  return { base, quote, name: metadata?.displayName || `${base} / ${quote}` };
}

/** Group decimal strings directly: converting u64 values to Number loses precision. */
export function readableAmount(value: BN, decimals: number): string {
  const [whole, fraction] = formatAtomicAmount(value, decimals).split(".");
  return (
    whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") +
    (fraction ? `.${fraction}` : "")
  );
}

/** Approximate base units for one quote token, computed entirely with integers. */
export function inversePrice(price: BN, quoteDecimals: number): string | null {
  if (price.lten(0)) return null;
  const precision = 12;
  const units = new BN(10).pow(new BN(quoteDecimals + precision)).div(price);
  return units.isZero() ? "< 0.000000000001" : readableAmount(units, precision);
}

export function referencePrice(market: MarketAccount, lastPrice?: BN | null) {
  if (lastPrice?.gtn(0))
    return { price: lastPrice, label: "Last traded price", indicative: false };
  if (market.bestBid && market.bestAsk)
    return {
      price: market.bestBid.add(market.bestAsk).divn(2),
      label: "Indicative mid-price · not a completed trade",
      indicative: true,
    };
  if (market.bestAsk)
    return {
      price: market.bestAsk,
      label: "Lowest sell offer · not a completed trade",
      indicative: true,
    };
  if (market.bestBid)
    return {
      price: market.bestBid,
      label: "Highest buy offer · not a completed trade",
      indicative: true,
    };
  return null;
}
