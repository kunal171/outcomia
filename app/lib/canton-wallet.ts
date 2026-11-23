import type { CantonSession } from "./canton-session";
import { parseHoldingAssets } from "./canton-display";
import { holdingContracts } from "./canton/transport";

/** Wallet balances from the party's Token Standard holdings, read through the
 * wallet's CIP-0103 `ledgerApi` with identity checked around the read. The
 * same path serves every wallet; no vendor balance endpoint is used. */
export async function readCantonWalletAssets(session: CantonSession) {
  return parseHoldingAssets(await holdingContracts(session), session.partyId);
}
