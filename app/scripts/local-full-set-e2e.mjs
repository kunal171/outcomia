/** Local-validator end-to-end check of eight-outcome full sets through a frozen
 * market lookup table, using the app's real planner and table helpers.
 *
 *   solana-keygen new --no-bip39-passphrase -o /tmp/authority.json
 *   solana-test-validator --reset --upgradeable-program \
 *     AG4ztZvcZjzFKjoXLzH8M6U3if9CwVFTXH2FHjqg7SdL ../target/deploy/outcomia.so \
 *     $(solana-keygen pubkey /tmp/authority.json)
 *   node scripts/local-full-set-e2e.mjs /tmp/authority.json
 *
 * Seven makers in distinct wallets rest heads with successors on outcomes
 * 1-7 (the largest packet case). Without the table the planner must ask for
 * it; the table is created, filled and frozen in one transaction; the full set
 * then lands as v0 and supplies, reserve tokens and balances are checked.
 * Uses only the local validator: nothing touches devnet. */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createRequire } from "node:module";
const APP = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const { loadTypeScript } = await import(
  `${APP}/scripts/support/typescript.mjs`
);
const require = createRequire(`${APP}/package.json`);
const { AnchorProvider, BN, Program, Wallet } = require("@anchor-lang/core");
const web3 = require("@solana/web3.js");
const spl = require("@solana/spl-token");
const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  sendAndConfirmTransaction,
} = web3;
const m = loadTypeScript(new URL(`file://${APP}/lib/multi-outcome.ts`));
const creation = loadTypeScript(
  new URL(`file://${APP}/lib/multi-outcome-creation.ts`),
);
const tables = loadTypeScript(
  new URL(`file://${APP}/lib/market-lookup-table.ts`),
);
const sh = loadTypeScript(new URL(`file://${APP}/lib/shared.ts`));
const o = loadTypeScript(new URL(`file://${APP}/lib/outcomia.ts`));
const idl = JSON.parse(fs.readFileSync(`${APP}/idl/outcomia.json`, "utf8"));
const conn = new Connection("http://127.0.0.1:8899", "confirmed");
const admin = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(process.argv[2], "utf8"))),
);
const program = (kp) =>
  new Program(
    idl,
    new AnchorProvider(conn, new Wallet(kp), { commitment: "confirmed" }),
  );
const P = program(admin);
const log = (...a) => console.log("ok ", ...a);

for (let i = 0; ; i++) {
  try {
    await conn.getVersion();
    break;
  } catch {
    if (i > 60) throw new Error("validator not up");
    await new Promise((r) => setTimeout(r, 1000));
  }
}
const fund = async (kp) => {
  const s = await conn.requestAirdrop(kp.publicKey, 5e9);
  await conn.confirmTransaction(s, "confirmed");
};
const send = (kp, ixs) =>
  sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [kp], {
    commitment: "confirmed",
  });
await fund(admin);
const programData = PublicKey.findProgramAddressSync(
  [new PublicKey(idl.address).toBuffer()],
  new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"),
)[0];
await send(admin, [
  await P.methods
    .initializeProtocol()
    .accountsPartial({
      deployer: admin.publicKey,
      program: new PublicKey(idl.address),
      programData,
    })
    .instruction(),
]);
log("protocol initialized");

const usd = await spl.createMint(conn, admin, admin.publicKey, null, 6);
const taker = Keypair.generate();
const makers = Array.from({ length: 7 }, () => Keypair.generate());
for (const kp of [taker, ...makers]) await fund(kp);
for (const kp of [taker, ...makers]) {
  const ata = await spl.getOrCreateAssociatedTokenAccount(
    conn,
    admin,
    usd,
    kp.publicKey,
  );
  await spl.mintTo(conn, admin, usd, ata.address, admin, 10_000_000);
  const c = {
    owner: kp.publicKey,
    mint: usd,
    assetBalance: sh.assetBalancePda(kp.publicKey, usd),
    vaultAuthority: sh.assetAuthorityPda(usd),
    assetVault: sh.assetVaultPda(usd),
    tokenProgram: o.TOKEN_PROGRAM_ID,
  };
  await send(kp, [
    await P.methods
      .initializeAssetBalance()
      .accountsStrict({ ...c, systemProgram: SystemProgram.programId })
      .instruction(),
    await P.methods
      .depositAsset(new BN(10_000_000))
      .accountsStrict({
        owner: c.owner,
        mint: usd,
        assetBalance: c.assetBalance,
        walletToken: ata.address,
        vaultAuthority: c.vaultAuthority,
        assetVault: c.assetVault,
        tokenProgram: o.TOKEN_PROGRAM_ID,
      })
      .instruction(),
  ]);
}
log("8 wallets funded with 10 USD shared cash");

const now =
  (await conn.getBlockTime(await conn.getSlot())) ??
  Math.floor(Date.now() / 1000);
const terms = {
  resolver: admin.publicKey,
  fallback: null,
  outcomeLabels: Array.from({ length: 8 }, (_, i) => `Outcome ${i}`),
  questionHash: [...crypto.randomBytes(32)],
  rulesHash: [...crypto.randomBytes(32)],
  rulesUri: "https://example.com/rules.json",
  closeTs: new BN(now + 3600),
  earliestResolutionTs: null,
  resolutionDelaySeconds: new BN(60),
  payoutPerContract: new BN(1_000_000),
  priceTick: new BN(10_000),
  quantityLot: new BN(1),
};
const id = crypto.randomBytes(32);
const plan0 = await creation.creationTransactions(
  P,
  admin.publicKey,
  id,
  usd,
  terms,
  "E2E eight outcomes",
  "USD",
);
for (const tx of plan0.uploads)
  await sendAndConfirmTransaction(conn, tx, [admin]);
await sendAndConfirmTransaction(conn, plan0.create, [admin]);
if (plan0.cleanup)
  await sendAndConfirmTransaction(conn, plan0.cleanup, [admin]);
const market = plan0.market;
const manage = {
  authority: admin.publicKey,
  market,
  adminRecord: o.deriveAdminRecordPda(admin.publicKey),
};
await send(admin, [
  await P.methods.openMultiOutcomeMarket().accountsStrict(manage).instruction(),
  await P.methods
    .initializeMultiOutcomeBook()
    .accountsStrict({
      ...manage,
      book: m.multiBookPda(market),
      systemProgram: SystemProgram.programId,
    })
    .instruction(),
]);
for (const kp of [taker, ...makers])
  await send(kp, [
    await P.methods
      .initializeMultiOutcomePosition()
      .accountsStrict({
        owner: kp.publicKey,
        market,
        position: m.multiPositionPda(market, kp.publicKey),
        systemProgram: SystemProgram.programId,
      })
      .instruction(),
  ]);
log("8-outcome market open, book and positions initialized");

const A = m.multiAccounts(P);
const place = async (kp, outcome, price, qty) => {
  const mk = await A.multiOutcomeMarket.fetch(market);
  const b = await m.readMultiBook(P, market);
  const r = await m.buildMultiTrade(
    program(kp),
    market,
    mk,
    b.book,
    b.rows,
    kp.publicKey,
    outcome,
    "bid",
    new BN(price),
    new BN(qty),
    0,
    false,
  );
  assert.ok(r.remaining.isZero());
  await sendAndConfirmTransaction(conn, r.transaction, [kp]);
};
const feeBps = (
  await P.account.protocolConfig.fetch(o.deriveProtocolConfigPda())
).takerFeeBps;
for (let j = 1; j < 8; j++) {
  await place(makers[j - 1], j, 50_000, 3); // head: 0.05 x 3
  await place(makers[j % 7], j, 40_000, 1); // successor from another wallet
}
log(
  "7 distinct makers rest 0.05 x3 heads with 0.04 successors (fee bps " +
    feeBps +
    ")",
);

// 1. Without the market table the full set cannot fit; the planner says so.
const mk = await A.multiOutcomeMarket.fetch(market);
let b = await m.readMultiBook(P, market);
await assert.rejects(
  m.buildMultiTrade(
    program(taker),
    market,
    mk,
    b.book,
    b.rows,
    taker.publicKey,
    0,
    "bid",
    new BN(800_000),
    new BN(3),
    feeBps,
    true,
  ),
  /lookup table/,
);
log("planner without a table reports the lookup table is needed");

// 2. Create, extend and freeze the table in ONE transaction.
assert.equal(await tables.findMarketTable(conn, market, usd), null);
const slot = await conn.getSlot("finalized");
const created = tables.createMarketTableInstructions(
  admin.publicKey,
  market,
  usd,
  slot,
);
const sig = await send(admin, created.instructions);
log("table created+extended+frozen in one tx", sig.slice(0, 16) + "…");
const startSlot = await conn.getSlot();
while ((await conn.getSlot()) <= startSlot + 1)
  await new Promise((r) => setTimeout(r, 200));
const table = await tables.findMarketTable(conn, market, usd);
assert.ok(table && table.key.equals(created.table), "table discovered");
assert.equal(table.state.authority, undefined, "frozen");
log("discovered and validated frozen table", table.key.toBase58());

// 3. The planner now fits the full set as v0 (one lot less: all heads would complete).
b = await m.readMultiBook(P, market);
const plan = await m.buildMultiTrade(
  program(taker),
  market,
  mk,
  b.book,
  b.rows,
  taker.publicKey,
  0,
  "bid",
  new BN(800_000),
  new BN(3),
  feeBps,
  true,
  [],
  table,
);
assert.ok(plan.lookupTable, "plan requires v0");
const ix = plan.transaction.instructions[0];
assert.equal(
  P.coder.instruction.decode(ix.data).name,
  "matchMultiOutcomeComplement",
);
const { blockhash } = await conn.getLatestBlockhash("confirmed");
const vtx = new VersionedTransaction(
  new TransactionMessage({
    payerKey: taker.publicKey,
    recentBlockhash: blockhash,
    instructions: plan.transaction.instructions,
  }).compileToV0Message([plan.lookupTable]),
);
const bytes = vtx.serialize().length;
assert.ok(bytes <= 1232);
vtx.sign([taker]);
const vsig = await conn.sendRawTransaction(vtx.serialize());
const res = await conn.confirmTransaction(
  {
    signature: vsig,
    blockhash,
    lastValidBlockHeight: (await conn.getLatestBlockhash())
      .lastValidBlockHeight,
  },
  "confirmed",
);
assert.equal(res.value.err, null);
const meta = await conn.getTransaction(vsig, {
  commitment: "confirmed",
  maxSupportedTransactionVersion: 0,
});
log(
  `v0 full set landed: ${bytes} bytes, ${meta.meta.computeUnitsConsumed} CU, fill ${P.coder.instruction.decode(ix.data).data.quantity}`,
);

// 4. On-chain effects.
const after = await A.multiOutcomeMarket.fetch(market);
const supplies = after.supplies.slice(0, 8).map((s) => s.toNumber());
assert.deepEqual(supplies, Array(8).fill(2));
assert.equal(after.backingReserve.toNumber(), 2_000_000);
const reserveTokens = (
  await spl.getAccount(conn, o.deriveVaultPda(market, usd))
).amount;
assert.equal(reserveTokens, 2_000_000n);
const takerPos = await A.multiOutcomePosition.fetch(
  m.multiPositionPda(market, taker.publicKey),
);
assert.equal(takerPos.free[0].toNumber(), 2);
const takerCash = await P.account.assetBalance.fetch(
  sh.assetBalancePda(taker.publicKey, usd),
);
const takerCost = (1_000_000 - 7 * 50_000) * 2; // 0.65 each
const fee = Math.ceil((takerCost * feeBps) / 10_000);
assert.equal(takerCash.free.toNumber(), 10_000_000 - takerCost - fee);
for (let j = 1; j < 8; j++) {
  const pos = await A.multiOutcomePosition.fetch(
    m.multiPositionPda(market, makers[j - 1].publicKey),
  );
  assert.equal(pos.free[j].toNumber(), 2, `maker ${j} received 2 contracts`);
}
const book = await A.multiOutcomeBook.fetch(m.multiBookPda(market));
for (let j = 1; j < 8; j++)
  assert.equal(
    book.heads[j * 2].price.toNumber(),
    50_000,
    "heads keep 1 remaining",
  );
log(
  `supplies ${JSON.stringify(supplies)}, reserve ${reserveTokens} tokens, taker paid ${takerCost}+${fee} fee, every maker +2 contracts`,
);
console.log("\nE2E PASSED");
process.exit(0);
