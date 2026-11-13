import { obj, text, type Contract, type RecordValue } from "./model.ts";
type AssetRow = {
  key: string;
  instrument: RecordValue;
  admission?: Contract;
  balance?: Contract;
};
/** Union admissions with owned accounts, not their intersection. Revoking a
 * deposit admission must never hide an existing account's withdrawal path. */
export function assetRows(
  contracts: Contract[],
  owned: Contract[],
  party: string,
): AssetRow[] {
  const rows = new Map<string, AssetRow>();
  for (const c of [
    ...contracts.filter((c) => c.kind === "AssetAdmission"),
    ...owned.filter((c) => c.kind === "AssetBalance" && c.data.owner === party),
  ]) {
    const instrument = obj(c.data.instrument),
      key = JSON.stringify([
        text(instrument.admin),
        text(instrument.id),
        text(c.data.factory),
      ]);
    const row = rows.get(key) ?? { key, instrument };
    const field = c.kind === "AssetAdmission" ? "admission" : "balance";
    if (row[field])
      throw new Error(
        "Ambiguous asset admission or balance. Refresh and check deployment.",
      );
    row[field] = c;
    rows.set(key, row);
  }
  return [...rows.values()];
}
