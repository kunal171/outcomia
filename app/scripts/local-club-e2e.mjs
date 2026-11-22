/** Local-validator end-to-end check of clubs and a members-only club market,
 * using the app's real club builders and shared trade planner.
 *
 *   solana-keygen new --no-bip39-passphrase -o /tmp/authority.json
 *   solana-test-validator --reset --upgradeable-program \
 *     AG4ztZvcZjzFKjoXLzH8M6U3if9CwVFTXH2FHjqg7SdL ../target/deploy/outcomia.so \
 *     $(solana-keygen pubkey /tmp/authority.json)
 *   node scripts/local-club-e2e.mjs /tmp/authority.json
 *
 * Creates a club, invites and admits two members, creates a members-only
 * market (create, open and book in one transaction), trades between members
 * with the club fee split, removes a member and clears their order as an
 * outsider, resolves as a club admin, redeems as the removed member and
 * withdraws the club's fees. Uses only the local validator. */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const APP = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const { loadTypeScript } = await import(
  `${APP}/scripts/support/typescript.mjs`
);
const require = createRequire(`${APP}/package.json`);
const { AnchorProvider, BN, Program, Wallet } = require("@anchor-lang/core");
const web3 = require("@solana/web3.js");
const spl = require("@solana/spl-token");
const { Connection, Keypair, PublicKey, SystemProgram, Transaction } = web3;
const c = loadTypeScript(new URL(`file://${APP}/lib/clubs.ts`));
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (let i = 0; ; i++) {
  try {
    await conn.getVersion();
    break;
  } catch {
    if (i > 60) throw new Error("validator not up");
    await sleep(1000);
  }
}
const airdrop = async (kp) => {
  const s = await conn.requestAirdrop(kp.publicKey, 5e9);
  await conn.confirmTransaction(s, "confirmed");
};
const send = (kp, ixs) =>
  web3.sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [kp], {
    commitment: "confirmed",
  });
const rejects = async (promise, pattern) => {
  try {
    await promise;
  } catch (e) {
    const text = `${e.message} ${(e.logs ?? []).join(" ")}`;
    assert.match(text, pattern);
    return;
  }
  throw new Error(`expected rejection ${pattern}`);
};
const chainNow = async () => conn.getBlockTime(await conn.getSlot());

await airdrop(admin);
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
  await P.methods
    .setTakerFee(100)
    .accountsPartial({
      superAdmin: admin.publicKey,
      protocolConfig: o.deriveProtocolConfigPda(),
    })
    .instruction(),
  await P.methods
    .setClubFeeShare(2_500)
    .accountsPartial({
      superAdmin: admin.publicKey,
      protocolConfig: o.deriveProtocolConfigPda(),
      clubFeeConfig: sh.clubFeeConfigPda(),
      systemProgram: SystemProgram.programId,
    })
    .instruction(),
]);
log("protocol initialized: 1% taker fee, 25% club share");

const usd = await spl.createMint(conn, admin, admin.publicKey, null, 6);
const [owner, alice, bob, carol] = Array.from({ length: 4 }, () =>
  Keypair.generate(),
);
for (const kp of [owner, alice, bob, carol]) {
  await airdrop(kp);
  const ata = await spl.getOrCreateAssociatedTokenAccount(
    conn,
    admin,
    usd,
    kp.publicKey,
  );
  await spl.mintTo(conn, admin, usd, ata.address, admin, 10_000_000);
  const custody = {
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
      .accountsStrict({ ...custody, systemProgram: SystemProgram.programId })
      .instruction(),
    await P.methods
      .depositAsset(new BN(10_000_000))
      .accountsStrict({ ...custody, walletToken: ata.address })
      .instruction(),
  ]);
}
log("four wallets funded with 10 USD of shared balance");

// ----- Club and membership -----
const created = await c.createClubInstruction(
  program(owner),
  owner.publicKey,
  "Local chess club",
);
const club = created.club;
await send(owner, [created.instruction]);
for (const kp of [alice, bob])
  await send(owner, [
    await c.inviteClubMemberInstruction(P, owner.publicKey, club, kp.publicKey),
  ]);
for (const kp of [alice, bob]) {
  const mine = await c.readWalletClubs(P, kp.publicKey);
  assert.equal(mine.invites.length, 1);
  await send(kp, [
    await c.acceptClubInviteInstruction(
      P,
      kp.publicKey,
      mine.invites[0].invite,
    ),
  ]);
}
let snapshot = await c.readClub(P, club);
assert.equal(snapshot.members.length, 3);
assert.equal(snapshot.invites.length, 0);
assert.equal((await c.readWalletClubs(P, alice.publicKey)).clubs.length, 1);
log("club created; alice and bob accepted invitations");

// ----- Members-only market: create, open and book in one transaction -----
const closeTs = (await chainNow()) + 25;
const { market, instructions } = await c.createClubMarketInstructions(
  P,
  owner.publicKey,
  club,
  usd,
  {
    resolver: owner.publicKey,
    fallback: null,
    closeTs: new BN(closeTs),
    earliestResolutionTs: null,
    resolutionDelaySeconds: new BN(3),
    payoutPerContract: new BN(1_000_000),
    priceTick: new BN(10_000),
    rulesUri: `ar://${"r".repeat(43)}`,
    questionHash: Array(32).fill(1),
    rulesHash: Array(32).fill(2),
  },
  "Will the local club market resolve YES?",
  "USD",
  false,
);
await send(owner, instructions);
snapshot = await c.readClub(P, club);
assert.equal(snapshot.markets.length, 1);
assert(c.membersOnly(snapshot.markets[0].binding));
assert("open" in snapshot.markets[0].market.status);
const publicList = (
  await o.getOutcomiaAccounts(P).predictionMarket.all()
).filter(({ publicKey, account }) =>
  c.isPublicPredictionMarket(publicKey, account.marketId),
);
assert(!publicList.some(({ publicKey }) => publicKey.equals(market)));
log("members-only market open with its book; absent from public discovery");

const context = () => c.clubTrading(snapshot, snapshot.markets[0].binding);
const position = (kp) =>
  PublicKey.findProgramAddressSync(
    [
      Buffer.from("prediction_position"),
      market.toBuffer(),
      kp.publicKey.toBuffer(),
    ],
    new PublicKey(idl.address),
  )[0];
for (const kp of [alice, bob, carol])
  await send(kp, [
    await c.initializeClubPositionInstruction(
      P,
      kp.publicKey,
      market,
      position(kp),
    ),
  ]);
await send(alice, [
  await c.clubCompleteSetInstruction(
    P,
    alice.publicKey,
    context(),
    market,
    usd,
    position(alice),
    new BN(3),
    true,
  ),
]);
log("positions created; alice split 3 pairs");

const trade = async (kp, outcome, side, price, quantity) => {
  const book = await sh.readSharedBook(P, market, context());
  const plan = await sh.buildSharedTrade(
    P,
    book,
    kp.publicKey,
    outcome,
    side,
    new BN(price),
    new BN(quantity),
    [],
    true,
    context(),
  );
  await send(kp, plan.instructions);
  return plan;
};
await trade(alice, "yes", "ask", 600_000, 2);
await rejects(trade(carol, "yes", "bid", 600_000, 1), /Only club members/);
// The program enforces it too, whatever the client does.
{
  const book = await sh.readSharedBook(P, market, context());
  const outsider = {
    ...context(),
    members: new Set([carol.publicKey.toBase58(), alice.publicKey.toBase58()]),
  };
  const plan = await sh.buildSharedTrade(
    P,
    book,
    carol.publicKey,
    "yes",
    "bid",
    new BN(600_000),
    new BN(1),
    [],
    true,
    outsider,
  );
  await rejects(
    send(carol, plan.instructions),
    /ClubMembershipRequired|AccountNotInitialized|0x/,
  );
}
const bobBefore = (
  await sh
    .sharedAccounts(P)
    .assetBalance.fetchNullable(sh.assetBalancePda(bob.publicKey, usd))
).free;
await trade(bob, "yes", "bid", 600_000, 1);
const bobAfter = (
  await sh
    .sharedAccounts(P)
    .assetBalance.fetchNullable(sh.assetBalancePda(bob.publicKey, usd))
).free;
assert.equal(bobBefore.sub(bobAfter).toString(), "606000");
snapshot = await c.readClub(P, club);
assert.equal(snapshot.markets[0].binding.accruedClubFees.toString(), "1500");
log("bob bought 1 YES at 0.60 + 6,000 fee; the club accrued 1,500");

// ----- Removal: the departed order blocks fills until anyone clears it -----
await send(owner, [
  await c.removeClubMemberInstruction(
    P,
    owner.publicKey,
    club,
    alice.publicKey,
  ),
]);
snapshot = await c.readClub(P, club);
await rejects(trade(bob, "yes", "bid", 600_000, 1), /former member/);
const book = await sh.readSharedBook(P, market, context());
const departed = book.orders.filter(
  (r) => "open" in r.account.status && sh.departedOrder(context(), r.account),
);
assert.equal(departed.length, 1);
await send(carol, [
  await sh.cancelShared(
    P,
    book,
    carol.publicKey,
    departed[0].publicKey,
    context(),
  ),
]);
const alicePosition = await o
  .getOutcomiaAccounts(P)
  .predictionPosition.fetch(position(alice));
assert.equal(alicePosition.yesFree.toString(), "2");
assert.equal(alicePosition.yesLocked.toString(), "0");
log(
  "alice removed; carol cleared her order and the contract returned to alice",
);

// ----- Resolution by a club admin; redemption by the removed member -----
while ((await chainNow()) < closeTs + 1) await sleep(1000);
await send(carol, [await c.advanceClubPredictionInstruction(P, market, 0)]);
await send(owner, [
  await c.proposeClubPredictionInstruction(
    P,
    owner.publicKey,
    club,
    market,
    "yes",
    `ar://${"e".repeat(43)}`,
    Array(32).fill(5),
    false,
  ),
]);
const proposedAt = (
  await o.getOutcomiaAccounts(P).predictionMarket.fetch(market)
).proposal.proposedAt.toNumber();
while ((await chainNow()) < proposedAt + 4) await sleep(1000);
await send(carol, [await c.advanceClubPredictionInstruction(P, market, 2)]);
const aliceCash = (
  await sh
    .sharedAccounts(P)
    .assetBalance.fetchNullable(sh.assetBalancePda(alice.publicKey, usd))
).free;
await send(alice, [
  await c.redeemClubPredictionInstruction(
    P,
    alice.publicKey,
    context(),
    market,
    usd,
    position(alice),
    new BN(2),
    new BN(3),
  ),
]);
const aliceRedeemed = (
  await sh
    .sharedAccounts(P)
    .assetBalance.fetchNullable(sh.assetBalancePda(alice.publicKey, usd))
).free;
assert.equal(aliceRedeemed.sub(aliceCash).toString(), "2000000");
log("resolved YES by the club owner; removed alice redeemed 2 YES for 2 USD");

// ----- Club fee withdrawal by the owner -----
const destination = spl.getAssociatedTokenAddressSync(usd, owner.publicKey);
const ownerTokens = (await spl.getAccount(conn, destination)).amount;
await send(owner, [
  await c.withdrawClubFeesInstruction(
    P,
    owner.publicKey,
    club,
    market,
    usd,
    destination,
    new BN(1500),
  ),
]);
assert.equal(
  (await spl.getAccount(conn, destination)).amount - ownerTokens,
  1500n,
);
log("owner withdrew the club's 1,500 fee share");
console.log("PASS: club lifecycle end to end on a local validator");
