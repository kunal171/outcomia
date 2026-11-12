import type { CantonNetwork } from "./canton-session";

export const walletNetworks = {
  "canton:devnet": "CANTON_NETWORK_DEV",
  "canton:testnet": "CANTON_NETWORK_TEST",
  "canton:mainnet": "CANTON_NETWORK",
} as const;

export type CantonWalletAsset = {
  id: string;
  symbol: string;
  name: string;
  amount: string;
  locked?: string;
};
const decimal = /^(\d+)(?:\.(\d+))?$/;

/** Wallet numbers remain decimal strings: never pass balances through Number. */
export function canonicalAmount(value: string): string {
  const match = decimal.exec(value);
  if (!match || value.length > 120) throw new Error("Invalid wallet amount.");
  const integer = match[1].replace(/^0+(?=\d)/, "");
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  return fraction ? `${integer}.${fraction}` : integer;
}

/** Validate the wallet boundary, including duplicate assets and wrong-network
 * responses. Symbols are display labels; token ID remains the list identity.
 */
export function parseWalletAssets(
  value: unknown,
  network: CantonNetwork,
): CantonWalletAsset[] {
  if (
    !value ||
    typeof value !== "object" ||
    !("tokens" in value) ||
    !Array.isArray(value.tokens)
  )
    throw new Error("Wallet returned an invalid balance response.");
  const seen = new Set<string>();
  return value.tokens.map((token: unknown) => {
    if (!token || typeof token !== "object")
      throw new Error("Wallet returned an invalid asset.");
    const item = token as Record<string, unknown>;
    if (item.network !== walletNetworks[network])
      throw new Error("Wallet returned assets for another network.");
    if (
      typeof item.id !== "string" ||
      !item.id.trim() ||
      seen.has(item.id) ||
      typeof item.symbol !== "string" ||
      !item.symbol.trim() ||
      typeof item.name !== "string" ||
      typeof item.balance !== "string"
    )
      throw new Error("Wallet returned an invalid asset.");
    seen.add(item.id);
    return {
      id: item.id,
      symbol: item.symbol,
      name: item.name,
      amount: canonicalAmount(item.balance),
    };
  });
}

/** Group the integer using the selected locale, preserving every fractional
 * digit. The only floating-point value is a constant for the decimal separator.
 */
export function formatCantonAmount(value: string, locale: string): string {
  const [integer, fraction] = canonicalAmount(value).split(".");
  const grouped = new Intl.NumberFormat(locale).format(BigInt(integer));
  const separator =
    new Intl.NumberFormat(locale)
      .formatToParts(1.1)
      .find((part) => part.type === "decimal")?.value ?? ".";
  return fraction ? `${grouped}${separator}${fraction}` : grouped;
}

/** Local explanation only: this does not validate a market tick, balance, fees
 * or deployment. Decimal scale and Int bounds match the current Daml contracts.
 */
export function previewCantonOrder(
  price: string,
  quantity: string,
): string | null {
  if (!/^(?:0|0\.\d{1,10})$/.test(price) || !/^[1-9]\d{0,18}$/.test(quantity))
    return null;
  const rawPrice = BigInt((price.split(".")[1] ?? "").padEnd(10, "0"));
  const count = BigInt(quantity);
  if (
    rawPrice <= BigInt(0) ||
    rawPrice >= BigInt(10000000000) ||
    count > BigInt("9223372036854775807")
  )
    return null;
  const total = rawPrice * count;
  const scale = BigInt(10000000000);
  return canonicalAmount(
    `${total / scale}.${(total % scale).toString().padStart(10, "0")}`,
  );
}

/** Loop holdings use (instrument admin, instrument ID) as identity. Preserve
 * unlocked and locked amounts separately; neither symbols nor floats are keys.
 */
export function parseLoopAssets(value: unknown): CantonWalletAsset[] {
  if (!Array.isArray(value))
    throw new Error("Wallet returned an invalid balance response.");
  const seen = new Set<string>();
  return value.map((holding: unknown) => {
    if (!holding || typeof holding !== "object")
      throw new Error("Wallet returned an invalid asset.");
    const item = holding as Record<string, unknown>;
    const instrument = item.instrument_id as
      | Record<string, unknown>
      | undefined;
    if (
      !instrument ||
      typeof instrument.admin !== "string" ||
      !instrument.admin.trim() ||
      typeof instrument.id !== "string" ||
      !instrument.id.trim() ||
      typeof item.symbol !== "string" ||
      !item.symbol.trim() ||
      typeof item.org_name !== "string" ||
      typeof item.total_unlocked_coin !== "string" ||
      typeof item.total_locked_coin !== "string"
    )
      throw new Error("Wallet returned an invalid asset.");
    const id = JSON.stringify([instrument.admin, instrument.id]);
    if (seen.has(id)) throw new Error("Wallet returned an invalid asset.");
    seen.add(id);
    return {
      id,
      symbol: item.symbol,
      name: item.org_name,
      amount: canonicalAmount(item.total_unlocked_coin),
      locked: canonicalAmount(item.total_locked_coin),
    };
  });
}
