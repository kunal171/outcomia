/** Where each collateral asset's USD price comes from. Keys are
 * `solana:<mint>` or `canton:<instrument id>`. Test stablecoins are valued at
 * $1 by convention so devnet totals read like real ones. */
export type PriceSource =
  { fixed: string; note: "stablecoin" | "test stablecoin" } | { pyth: string };

/** Pyth price feed ids (Hermes), e.g. SOL/USD. */
export const PYTH_FEEDS = {
  SOL: "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  BTC: "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
} as const;

export const DEFAULT_PRICE_SOURCES: Record<string, PriceSource> = {
  // Wrapped SOL.
  "solana:So11111111111111111111111111111111111111112": {
    pyth: PYTH_FEEDS.SOL,
  },
  // USDC (mainnet and devnet).
  "solana:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": {
    fixed: "1",
    note: "stablecoin",
  },
  "solana:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU": {
    fixed: "1",
    note: "stablecoin",
  },
  // Devnet test tokens.
  "solana:FUU2RPtv519UtUD2apwBRUM8BT2x2Kew71AxRRLMCAbd": {
    fixed: "1",
    note: "test stablecoin",
  },
  "solana:8KRa3QwidV2yZspR3wr4p3eNzq2KtejMbU1tZUgNLdtt": {
    fixed: "1",
    note: "test stablecoin",
  },
  "solana:FggaZG7eJ5tpr2vmpNMbMCHkWkcw9n2Nhmf54g3wQwGk": {
    pyth: PYTH_FEEDS.BTC,
  },
  // Canton USD test collateral.
  "canton:test-USD": { fixed: "1", note: "test stablecoin" },
};

/** Defaults plus `PRICE_SOURCES` (JSON of the same shape) from the server
 * environment, so operators can add assets such as a CC feed without a release.
 * Malformed overrides are ignored rather than mispricing anything. */
export function priceSources(
  env: string | undefined,
): Record<string, PriceSource> {
  if (!env) return DEFAULT_PRICE_SOURCES;
  try {
    const extra = JSON.parse(env) as Record<string, unknown>;
    const valid = Object.entries(extra).filter(([key, value]) => {
      const v = (value ?? {}) as Record<string, unknown>;
      return (
        /^(solana|canton):[^\s]{1,128}$/.test(key) &&
        ((typeof v.pyth === "string" && /^0x[0-9a-f]{64}$/.test(v.pyth)) ||
          (typeof v.fixed === "string" && /^\d+(\.\d+)?$/.test(v.fixed)))
      );
    });
    return {
      ...DEFAULT_PRICE_SOURCES,
      ...(Object.fromEntries(valid) as Record<string, PriceSource>),
    };
  } catch {
    return DEFAULT_PRICE_SOURCES;
  }
}
