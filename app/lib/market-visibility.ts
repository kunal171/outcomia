/** Discovery policy for every market list (spot, binary and multi-outcome).
 * Hidden test markets remain reachable by direct address for owner exits.
 * Deployment smoke tests name their markets "Smoke test - ..." so they never
 * appear in public discovery. */
const smokeMarkets = new Set([
  "4AhXYjfYy5kVBTyWbmrxFJ7KmydghcaktprU74aVv5kC",
  "6TbjosDZT3V8MSCwARhK5RhaYHbeS56rS7rEWYYt48i7",
]);

export function visibleMarket(address: string, displayName = "") {
  return (
    !smokeMarkets.has(address) &&
    !/^smoke(?:[\s-]+(?:only|test))?\b/i.test(displayName)
  );
}
