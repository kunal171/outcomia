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

/** Display labels for well-known instruments; others show their instrument ID. */
const KNOWN_INSTRUMENTS: Record<string, { symbol: string; name: string }> = {
  Amulet: { symbol: "CC", name: "Canton Coin" },
};

const HOLDING_VIEW = ":Splice.Api.Token.HoldingV2:Holding";
const SCALE = BigInt(10) ** BigInt(10);
const atoms = (value: string) => {
  const [whole, fraction = ""] = canonicalAmount(value).split(".");
  if (fraction.length > 10) throw new Error("Invalid wallet amount.");
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(10, "0"));
};
const decimalText = (value: bigint) =>
  canonicalAmount(
    `${value / SCALE}.${(value % SCALE).toString().padStart(10, "0")}`,
  );

/**
 * Wallet balances from Token Standard `Holding` interface views, as read
 * through CIP-0103 `ledgerApi`. Groups the party's own holdings by instrument
 * (admin, ID) and keeps unlocked and locked totals apart, in exact decimals.
 * Example: holdings of 2.5 and 1 Amulet, plus 0.5 locked → CC 3.5, locked 0.5.
 */
export function parseHoldingAssets(
  response: unknown,
  party: string,
): CantonWalletAsset[] {
  const rows = Array.isArray(response)
    ? response
    : response && typeof response === "object" && "items" in response
      ? (response as { items: unknown }).items
      : null;
  if (!Array.isArray(rows))
    throw new Error("Wallet returned an invalid balance response.");
  const totals = new Map<
    string,
    { admin: string; id: string; free: bigint; locked: bigint }
  >();
  for (const row of rows) {
    const r = (row ?? {}) as Record<string, any>;
    const entry = r.contractEntry ?? r,
      active = entry.JsActiveContract ?? entry.activeContract ?? entry,
      views = active?.createdEvent?.interfaceViews;
    if (!Array.isArray(views)) continue;
    for (const v of views) {
      if (!String(v?.interfaceId).endsWith(HOLDING_VIEW)) continue;
      const data = (v.viewValue ?? {}) as Record<string, any>,
        instrument = data.instrumentId ?? {};
      if (data.account?.owner !== party) continue;
      if (
        typeof instrument.admin !== "string" ||
        typeof instrument.id !== "string" ||
        typeof data.amount !== "string"
      )
        throw new Error("Wallet returned an invalid asset.");
      const key = JSON.stringify([instrument.admin, instrument.id]),
        total = totals.get(key) ?? {
          admin: instrument.admin,
          id: instrument.id,
          free: BigInt(0),
          locked: BigInt(0),
        };
      if (data.lock) total.locked += atoms(data.amount);
      else total.free += atoms(data.amount);
      totals.set(key, total);
    }
  }
  return [...totals.entries()].map(([key, t]) => ({
    id: key,
    symbol: KNOWN_INSTRUMENTS[t.id]?.symbol ?? t.id,
    name: KNOWN_INSTRUMENTS[t.id]?.name ?? t.id,
    amount: decimalText(t.free),
    locked: decimalText(t.locked),
  }));
}
