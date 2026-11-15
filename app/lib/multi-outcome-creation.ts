import { BN, type Program } from "@anchor-lang/core";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { PROGRAM_ID } from "./solana";
import {
  deriveAdminRecordPda,
  deriveVaultAuthorityPda,
  deriveVaultPda,
  deriveMarketMetadataPda,
  TOKEN_PROGRAM_ID,
} from "./outcomia";
import { multiMarketPda, transactionBytes, type Terms } from "./multi-outcome";
export const termsBufferPda = (owner: PublicKey, id: Uint8Array) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("multi_terms"), owner.toBytes(), id],
    PROGRAM_ID,
  )[0];
export async function sha256(bytes: Uint8Array) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer),
    ),
  ];
}
export function validateTerms(t: Terms, now = Math.floor(Date.now() / 1000)) {
  const labels = t.outcomeLabels;
  if (
    labels.length < 2 ||
    labels.length > 8 ||
    new Set(labels).size !== labels.length ||
    labels.some(
      (s) =>
        !s ||
        s.trim() !== s ||
        new TextEncoder().encode(s).length > 64 ||
        /[\x00-\x1f\x7f]/.test(s),
    )
  )
    throw new Error(
      "Use 2–8 distinct outcome labels, each at most 64 UTF-8 bytes without outer spaces or control characters.",
    );
  if (
    t.closeTs.lten(now) ||
    t.earliestResolutionTs?.lt(t.closeTs) ||
    t.resolutionDelaySeconds.lten(0) ||
    t.resolutionDelaySeconds.bitLength() > 53
  )
    throw new Error(
      "Choose a future close, an earliest resolution at or after close, and a positive review delay.",
    );
  if (
    t.priceTick.lten(0) ||
    t.priceTick.gte(t.payoutPerContract) ||
    !t.payoutPerContract.mod(t.priceTick).isZero()
  )
    throw new Error(
      "Price tick must divide face payout and be smaller than it.",
    );
  if (
    t.quantityLot.lten(0) ||
    t.quantityLot.mul(t.payoutPerContract).modn(labels.length) !== 0 ||
    t.quantityLot.mul(t.payoutPerContract).bitLength() > 64
  )
    throw new Error(
      "The lot must permit exact equal Invalid refunds and fit in u64 collateral.",
    );
  if (
    t.fallback &&
    (t.fallback.availableTs.lt(t.earliestResolutionTs ?? t.closeTs) ||
      t.fallback.deadlineTs?.lte(t.fallback.availableTs))
  )
    throw new Error(
      "Fallback must start after resolution becomes eligible, and its deadline must follow its start.",
    );
  if (
    !/^(https:\/\/|ar:\/\/)[^/?#\s][\x21-\x7e]*$/.test(t.rulesUri) ||
    new TextEncoder().encode(t.rulesUri).length > 200
  )
    throw new Error(
      "Use an HTTPS or Arweave rules URI of at most 200 ASCII bytes.",
    );
}
function prepareCreation(
  owner: PublicKey,
  id: Uint8Array,
  mint: PublicKey,
  terms: Terms,
  name: string,
  symbol: string,
) {
  validateTerms(terms);
  if (
    !/^[\x20-\x7e]{1,64}$/.test(name) ||
    name.trim() !== name ||
    !/^[A-Za-z0-9._-]{1,16}$/.test(symbol)
  )
    throw new Error(
      "Use a printable name of 1–64 characters and a symbol of 1–16 letters, digits, '.', '_' or '-'.",
    );
  if (!terms.resolver.equals(owner))
    throw new Error("The active-admin creator must be the primary resolver.");
  const market = multiMarketPda(id),
    buffer = termsBufferPda(owner, id);
  const accounts = {
    authority: owner,
    adminRecord: deriveAdminRecordPda(owner),
    market,
    collateralMint: mint,
    vaultAuthority: deriveVaultAuthorityPda(market),
    collateralVault: deriveVaultPda(market, mint),
    marketMetadata: deriveMarketMetadataPda(market),
    tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  };
  return { market, buffer, accounts };
}
/** Shared account builder kept separate from serialized immutable terms. */
export async function creationTransactions(
  p: Program,
  owner: PublicKey,
  id: Uint8Array,
  mint: PublicKey,
  terms: Terms,
  name: string,
  symbol: string,
) {
  const { market, buffer, accounts } = prepareCreation(
    owner,
    id,
    mint,
    terms,
    name,
    symbol,
  );
  const bytes = p.coder.types.encode("multiOutcomeTerms", terms),
    uploads: Transaction[] = [];
  let create: Transaction | null = null;
  if (bytes.length <= 700) {
    const tx = new Transaction().add(
      await p.methods
        .initializeMultiOutcomeMarket([...id], terms, name, symbol)
        .accountsStrict(accounts)
        .instruction(),
    );
    try {
      transactionBytes(tx, owner);
      create = tx;
    } catch {
      /* Use explicit staged terms below. */
    }
  }
  if (!create) {
    for (let offset = 0; offset < bytes.length; offset += 600) {
      const tx = new Transaction().add(
        await p.methods
          .writeMultiOutcomeTerms(
            [...id],
            offset,
            bytes.subarray(offset, offset + 600),
          )
          .accountsStrict({
            authority: owner,
            buffer,
            systemProgram: SystemProgram.programId,
          })
          .instruction(),
      );
      transactionBytes(tx, owner);
      uploads.push(tx);
    }
    create = new Transaction().add(
      await p.methods
        .initializeMultiOutcomeMarketFromStaged(
          [...id],
          await sha256(bytes),
          name,
          symbol,
        )
        .accountsStrict(accounts)
        .remainingAccounts([
          { pubkey: buffer, isSigner: false, isWritable: false },
        ])
        .instruction(),
    );
  }
  transactionBytes(create, owner);
  const cleanup = uploads.length
    ? new Transaction().add(
        await p.methods
          .closeMultiOutcomeTerms()
          .accountsStrict({ authority: owner, buffer })
          .instruction(),
      )
    : null;
  return { market, uploads, create, cleanup };
}
