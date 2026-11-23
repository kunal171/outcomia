/** Display names for valueless devnet test collateral.
 *
 * The 23 November 2026 demo markets were created with "USDC" as their
 * on-chain quote symbol, but their collateral is Outcomia's own test mint
 * (FUU2RPtv519UtUD2apwBRUM8BT2x2Kew71AxRRLMCAbd), not Circle's devnet USDC.
 * The program cannot rename prediction-market metadata, so the app shows
 * "outcomia-tUSDC" for these markets wherever metadata is decoded.
 * Markets created later on the test mint carry the symbol on-chain. */
export const TEST_USDC_SYMBOL = "outcomia-tUSDC";
export const TEST_USDC_MINT = "FUU2RPtv519UtUD2apwBRUM8BT2x2Kew71AxRRLMCAbd";

const TEST_USDC_MARKETS = new Set([
  "4j3fKSLkUeAvvZYMrwn3qTAB53hcdQURBQYxYKKgyhib",
  "8tnxUrXfXry5WxiJoqsZ8q9BXXC9FkZVczaDKX9p4Z7D",
  "GNiocTMShWJix7GXEqZrtcc9xPDbiVsWMGsbQU17dnBv",
  "BgHYHdZNCnZZqQHtNHYNsfdPxU9LqnYj2yt1RFLj1p6m",
  "AnkrvLwXPMnKdz8DAhojdg9qt94XsUDuZU3dF6wLu3dE",
  "EJgGaUXdvfc38FQ6T4CK9ani2zuqoDajJLWaxnLRjhPv",
  "De6aGZSUsqtHChzXjWtvVBUTncYLUzQ6Ar3Tj5h4Nfvs",
  "4gqCExCZWwzV11QcDGqDM6kvTR2TkSLcmMQxfiNdedSY",
  "6oe1kcegJ29ayuDcxSr2WF9nEwGr5nf87oDPNfyZfSa2",
  "CG2WdM7y2hDj2cshzymC29b74ZeHRtH4gddEc5kim5jZ",
  "939bA9dJKaw4FhbTb8HgmaA7KW7mbKGuKmb2tMnCD5eH",
  "GXsCrXgcQ8Vjg3aWVC6n3xBU7x7PeUKuM2Ao1KZ9vM4",
  "2ydKB7tZVFin6xydYivPevun998vK7NY6vj548qDCN98",
  "ABuyzqheVr7kWFUFzLHMkqUMLyZpyivp5cSjUg7MYFGF",
]);

type Metadata = { market?: { toBase58(): string }; quoteSymbol?: string };

/** Returns market metadata with the display symbol for known test markets. */
export function displayMetadata<T>(metadata: T): T {
  const m = metadata as Metadata | null;
  const market = m?.market?.toBase58?.();
  return market && TEST_USDC_MARKETS.has(market)
    ? ({ ...m, quoteSymbol: TEST_USDC_SYMBOL } as T)
    : metadata;
}

/** Applies displayMetadata to every MarketMetadata the program decodes. */
export function withDisplaySymbols<T extends { coder: { accounts: unknown } }>(
  program: T,
): T {
  const accounts = program.coder.accounts as {
    decode: (name: string, data: Buffer) => unknown;
    decodeUnchecked?: (name: string, data: Buffer) => unknown;
    __displaySymbols?: boolean;
  };
  if (accounts.__displaySymbols) return program;
  for (const key of ["decode", "decodeUnchecked"] as const) {
    const original = accounts[key]?.bind(accounts);
    if (!original) continue;
    accounts[key] = (name: string, data: Buffer) => {
      const value = original(name, data);
      return name === "MarketMetadata" || name === "marketMetadata"
        ? displayMetadata(value)
        : value;
    };
  }
  accounts.__displaySymbols = true;
  return program;
}
