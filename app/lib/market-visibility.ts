/** Discovery policy for every market list (spot, binary and multi-outcome).
 * Hidden test markets remain reachable by direct address for owner exits.
 * Deployment smoke tests name their markets "Smoke test - ..." so they never
 * appear in public discovery. */
const smokeMarkets = new Set([
  "4AhXYjfYy5kVBTyWbmrxFJ7KmydghcaktprU74aVv5kC",
  "6TbjosDZT3V8MSCwARhK5RhaYHbeS56rS7rEWYYt48i7",
  // 2026-11-21 release smoke (multi-outcome); listed so it stays hidden even
  // if its metadata name cannot be read.
  "Ey5p8bBin49gfiaCuE7qHPdy8LdomzZX2tQEASbdo8ar",
  // 2026-11-21 complementary-matching smoke (binary and multi-outcome).
  "ECxeTETJuskYCPszPsK7LrNo3J5KZ7F3BwSvTQbspus1",
  "FN3grpJFuVNezLkd76iEBsMv54tnLeM3vsAhTL2rfmKX",
]);

export function visibleMarket(address: string, displayName = "") {
  return (
    !smokeMarkets.has(address) &&
    !/^smoke(?:[\s-]+(?:only|test))?\b/i.test(displayName)
  );
}
