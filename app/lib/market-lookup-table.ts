/** Per-market address lookup table for large multi-outcome full-set fills.
 *
 * A full set across seven or eight outcomes can exceed one legacy packet. A v0
 * transaction referencing a lookup table replaces each of the market's nine
 * fixed accounts with a one-byte index. The table is created once per market,
 * extended with exactly those addresses and frozen in the same transaction, so
 * nobody can later alter, deactivate or close it. Anyone may create it and
 * everyone shares it; discovery validates every candidate strictly. */
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  PublicKey,
  type Connection,
  type TransactionInstruction,
} from "@solana/web3.js";
import { assetAuthorityPda, assetVaultPda } from "./shared";
import {
  TOKEN_PROGRAM_ID,
  deriveProtocolConfigPda,
  deriveVaultAuthorityPda,
  deriveVaultPda,
} from "./outcomia";
import { PROGRAM_ID } from "./solana";

/** Same seeds as `multiBookPda`; derived here to avoid a circular import. */
const bookPda = (market: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("multi_book"), market.toBuffer()],
    PROGRAM_ID,
  )[0];

/** Fixed accounts of `match_multi_outcome_complement`, market first. */
export function marketTableAddresses(market: PublicKey, mint: PublicKey) {
  return [
    market,
    bookPda(market),
    deriveProtocolConfigPda(),
    mint,
    assetAuthorityPda(mint),
    assetVaultPda(mint),
    deriveVaultAuthorityPda(market),
    deriveVaultPda(market, mint),
    TOKEN_PROGRAM_ID,
  ];
}

/** Table account size: 56-byte header plus nine 32-byte addresses. */
const TABLE_SIZE = 56 + 9 * 32;
const ACTIVE = BigInt("18446744073709551615");

/** A usable shared table is frozen (no authority), never deactivated and holds
 * exactly this market's fixed addresses in order. */
export function validMarketTable(
  table: AddressLookupTableAccount,
  market: PublicKey,
  mint: PublicKey,
) {
  const expected = marketTableAddresses(market, mint);
  return (
    table.state.authority === undefined &&
    table.state.deactivationSlot === ACTIVE &&
    table.state.addresses.length === expected.length &&
    table.state.addresses.every((a, i) => a.equals(expected[i]))
  );
}

/** Finds the market's frozen table, or null. Candidates are matched by size
 * and first address, then validated; the lowest address wins deterministically. */
export async function findMarketTable(
  connection: Connection,
  market: PublicKey,
  mint: PublicKey,
) {
  const accounts = await connection.getProgramAccounts(
    AddressLookupTableProgram.programId,
    {
      commitment: "confirmed",
      filters: [
        { dataSize: TABLE_SIZE },
        { memcmp: { offset: 56, bytes: market.toBase58() } },
      ],
    },
  );
  const tables = accounts
    .map(
      ({ pubkey, account }) =>
        new AddressLookupTableAccount({
          key: pubkey,
          state: AddressLookupTableAccount.deserialize(account.data),
        }),
    )
    .filter((t) => validMarketTable(t, market, mint))
    .sort((a, b) => a.key.toBase58().localeCompare(b.key.toBase58()));
  return tables[0] ?? null;
}

/** One transaction that creates, fills and freezes the market's table. The
 * payer funds about 0.003 SOL of rent, which a frozen table never returns.
 * The table can be referenced from the slot after this transaction lands. */
export function createMarketTableInstructions(
  payer: PublicKey,
  market: PublicKey,
  mint: PublicKey,
  recentSlot: number,
): { table: PublicKey; instructions: TransactionInstruction[] } {
  const [create, table] = AddressLookupTableProgram.createLookupTable({
    authority: payer,
    payer,
    recentSlot,
  });
  return {
    table,
    instructions: [
      create,
      AddressLookupTableProgram.extendLookupTable({
        lookupTable: table,
        authority: payer,
        payer,
        addresses: marketTableAddresses(market, mint),
      }),
      AddressLookupTableProgram.freezeLookupTable({
        lookupTable: table,
        authority: payer,
      }),
    ],
  };
}

/** Same addresses as a real table, for packet-size estimates before one exists. */
export function provisionalMarketTable(market: PublicKey, mint: PublicKey) {
  return new AddressLookupTableAccount({
    key: PublicKey.default,
    state: {
      deactivationSlot: ACTIVE,
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      authority: undefined,
      addresses: marketTableAddresses(market, mint),
    },
  });
}
