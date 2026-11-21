// Client mirror of the program's `validate_spot_increments` rule.
//
// A fill whose quote value floors to zero is rejected on-chain, and only the
// FIFO head at the best price can be matched. If increments are too fine, a
// partial fill can leave a head remainder nobody can fill, freezing that price
// level. Requiring tick * lot >= 10^baseDecimals means every on-tick,
// lot-multiple fill moves at least one quote atom.
//
// The program remains the authority; this check only explains a rejection
// before the wallet is asked to sign.

/**
 * Inputs: base-mint decimals and positive raw tick/lot increments.
 * Returns: null when accepted, otherwise a user-facing reason.
 */
export function spotIncrementsError(
  baseDecimals: number,
  priceTick: bigint,
  quantityLot: bigint,
): string | null {
  if (
    !Number.isInteger(baseDecimals) ||
    baseDecimals < 0 ||
    baseDecimals > 255
  ) {
    return "Base mint decimals are invalid";
  }
  if (priceTick <= BigInt(0) || quantityLot <= BigInt(0)) {
    return "Price tick and quantity lot must be greater than zero";
  }
  const wholeBaseToken = BigInt(10) ** BigInt(baseDecimals);
  if (priceTick * quantityLot < wholeBaseToken) {
    return (
      `Price tick × quantity lot must be at least ${wholeBaseToken.toString()} ` +
      `(one whole base token at ${baseDecimals} decimals) so every fill moves quote`
    );
  }
  return null;
}
