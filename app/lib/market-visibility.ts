/** Discovery policy only. Hidden test markets remain reachable for owner exits. */
const smokeMarkets = new Set([
  "4AhXYjfYy5kVBTyWbmrxFJ7KmydghcaktprU74aVv5kC",
  "6TbjosDZT3V8MSCwARhK5RhaYHbeS56rS7rEWYYt48i7",
]);

export function visiblePredictionMarket(address: string, displayName = "") {
  return !smokeMarkets.has(address) && !/\bsmoke(?:[\s-]+(?:only|test))?\b/i.test(displayName);
}
