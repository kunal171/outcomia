/** Local-validator end-to-end check of clubs and a members-only club market,
 * using the app's real club builders and shared trade planner.
 *
 *   solana-keygen new --no-bip39-passphrase -o /tmp/authority.json
 *   solana-test-validator --reset --upgradeable-program \
 *     AG4ztZvcZjzFKjoXLzH8M6U3if9CwVFTXH2FHjqg7SdL ../target/deploy/outcomia.so \
 *     $(solana-keygen pubkey /tmp/authority.json)
 *   node scripts/local-club-e2e.mjs /tmp/authority.json
 *
 * Creates a club and pays its security deposit, invites and admits two
 * members, creates a members-only market (create, open and book in one
 * transaction), trades between members with the club fee split, removes a
 * member and clears their order as an outsider, proposes as a club admin, has
 * a holder dispute and a protocol admin uphold the outcome, redeems as the
 * removed member, withdraws the club's fees, settles the market and closes
 * the club with its deposit refunded. Uses only the local validator by default:
 * locally it also sets the club rules, USDC deposit rules (the test mint) and
 * short dispute windows. On devnet the deposit is paid in SOL at Pyth's price.
 *
 * Devnet smoke (RPC=<url> RESULT=<json path> node scripts/local-club-e2e.mjs
 * <authority.json>): uses the deployed protocol as configured (no fee or
 * config changes), a fresh valueless mint, temporary wallets funded by
 * transfer whose SOL is returned afterwards, and hidden "Smoke test" names. */
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
const dep = loadTypeScript(new URL(`file://${APP}/lib/club-deposits.ts`));
const life = loadTypeScript(new URL(`file://${APP}/lib/club-lifecycle.ts`));
const dis = loadTypeScript(new URL(`file://${APP}/lib/disputes.ts`));
const idl = JSON.parse(fs.readFileSync(`${APP}/idl/outcomia.json`, "utf8"));
const DEVNET = !!process.env.RPC;
/** Retries network failures of any JSON-RPC call. Safe: resending the same
 * signed transaction or read is idempotent. */
async function fetchWithRetry(url, init) {
  for (let i = 0; ; i++) {
    try {
      const response = await fetch(url, init);
      if (response.status !== 429 && response.status < 500) return response;
      if (i >= 6) return response;
    } catch (e) {
      if (i >= 6) throw e;
    }
    await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
  }
}
const conn = new Connection(process.env.RPC ?? "http://127.0.0.1:8899", {
  commitment: "confirmed",
  fetch: fetchWithRetry,
});
const report = { cluster: DEVNET ? "devnet" : "local", steps: [] };
const admin = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(process.argv[2], "utf8"))),
);
const program = (kp) =>
  new Program(
    idl,
    new AnchorProvider(conn, new Wallet(kp), { commitment: "confirmed" }),
  );
const P = program(admin);
const log = (...a) => {
  report.steps.push(a.join(" "));
  console.log("ok ", ...a);
};
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
/** Retries token-helper calls after connection failures. A retried mint after
 * an unconfirmed success only creates a spare valueless mint or tokens. */
async function retry(attempt) {
  for (let i = 0; ; i++) {
    try {
      return await attempt();
    } catch (e) {
      const transient =
        /fetch failed|ETIMEDOUT|ECONNRESET|429|socket hang up|block height exceeded|Blockhash not found/i.test(
          `${e.message} ${e.cause?.code ?? ""}`,
        );
      if (!transient || i >= 4) throw e;
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
}
const airdrop = async (kp) => {
  if (DEVNET)
    return send(admin, [
      SystemProgram.transfer({
        fromPubkey: admin.publicKey,
        toPubkey: kp.publicKey,
        lamports: 60_000_000,
      }),
    ]);
  const s = await conn.requestAirdrop(kp.publicKey, 5e9);
  await conn.confirmTransaction(s, "confirmed");
};
/** Signs once and rebroadcasts the same bytes until confirmed, so a lost
 * confirmation can never execute an instruction twice. Only when the blockhash
 * expires and the signature provably did not land is it re-signed. Program
 * errors surface from preflight simulation unchanged. */
async function send(kp, ixs) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { blockhash, lastValidBlockHeight } =
      await conn.getLatestBlockhash("confirmed");
    const tx = new Transaction({
      feePayer: kp.publicKey,
      blockhash,
      lastValidBlockHeight,
    }).add(...ixs);
    tx.sign(kp);
    const raw = tx.serialize();
    const signature = await conn.sendRawTransaction(raw, {
      preflightCommitment: "confirmed",
    });
    for (;;) {
      const status = (await conn.getSignatureStatuses([signature])).value[0];
      if (status?.err)
        throw new Error(`transaction failed: ${JSON.stringify(status.err)}`);
      if (
        status?.confirmationStatus === "confirmed" ||
        status?.confirmationStatus === "finalized"
      )
        return signature;
      if ((await conn.getBlockHeight("confirmed")) > lastValidBlockHeight) {
        const final = (
          await conn.getSignatureStatuses([signature], {
            searchTransactionHistory: true,
          })
        ).value[0];
        if (final?.err)
          throw new Error(`transaction failed: ${JSON.stringify(final.err)}`);
        if (final) return signature;
        break; // expired without landing: safe to re-sign
      }
      await conn
        .sendRawTransaction(raw, { skipPreflight: true })
        .catch(() => {});
      await sleep(2000);
    }
  }
  throw new Error("transaction did not land after 5 blockhashes");
}
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

let takerFeeBps = 100,
  clubShareBps = 2_500;
if (DEVNET) {
  // The deployed protocol is used exactly as configured.
  takerFeeBps = (
    await o
      .getOutcomiaAccounts(P)
      .protocolConfig.fetch(o.deriveProtocolConfigPda())
  ).takerFeeBps;
  const share = await P.account.clubFeeConfig.fetchNullable(
    sh.clubFeeConfigPda(),
  );
  clubShareBps = share?.clubShareBps ?? 0;
  log(
    `devnet protocol: ${takerFeeBps} bps taker fee, ${clubShareBps} bps club share`,
  );
} else {
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
  await send(admin, [
    await c.setClubRulesInstruction(P, admin.publicKey, {
      publicMemberCap: 100_000,
      privateMemberCap: 1_000,
      maxOwnedClubs: 2,
      maxClubAdmins: 5,
    }),
    // Short windows so the local run finishes quickly.
    await dis.setDisputeConfigInstruction(P, admin.publicKey, {
      clubWindowSeconds: new BN(3),
      regularWindowSeconds: new BN(3),
      bondTokens: new BN(1),
      rulingDeadlineSeconds: new BN(600),
      treasury: admin.publicKey,
    }),
  ]);
  log("club rules and 3-second dispute windows set");
}
const fee = Math.ceil((600_000 * takerFeeBps) / 10_000),
  clubFee = Math.floor((fee * clubShareBps) / 10_000);
const usd = await retry(() =>
  spl.createMint(conn, admin, admin.publicKey, null, 6),
);
if (!DEVNET) {
  await send(admin, [
    await dep.setClubDepositRulesInstruction(P, admin.publicKey, usd, {
      privateMinDepositUsd: new BN(100_000_000),
      publicMinDepositUsd: new BN(200_000_000),
      solBufferBps: 12_000,
      solUsdFeedId: Array.from(Buffer.from(dep.SOL_USD_FEED_ID, "hex")),
      maxPriceAgeSeconds: 60,
      maxPriceConfBps: 100,
    }),
  ]);
  log("USDC deposit rules set with the test mint ($100 private minimum)");
}
const depositRules = await c.readClubRules(P);
assert(dep.depositsConfigured(depositRules), "club deposit rules are not set");
/** Pyth's shared SOL/USD account when it is fresh (devnet SOL deposits). */
const solPrice = () => dep.freshSolUsdPrice(conn, depositRules);
// Persist temporary keypairs before funding them, so an interrupted devnet
// run can be swept instead of stranding SOL (WALLETS=<private json path>).
const walletFile = process.env.WALLETS;
const [owner, alice, bob, carol] =
  walletFile && fs.existsSync(walletFile)
    ? JSON.parse(fs.readFileSync(walletFile, "utf8")).map((k) =>
        Keypair.fromSecretKey(Uint8Array.from(k)),
      )
    : Array.from({ length: 4 }, () => Keypair.generate());
if (walletFile)
  fs.writeFileSync(
    walletFile,
    JSON.stringify(
      [owner, alice, bob, carol].map((k) => Array.from(k.secretKey)),
    ),
    { mode: 0o600 },
  );
for (const kp of [owner, alice, bob, carol]) {
  await airdrop(kp);
  const ata = await retry(() =>
    spl.getOrCreateAssociatedTokenAccount(conn, admin, usd, kp.publicKey),
  );
  // A retried mint after an unconfirmed success only leaves spare test tokens.
  await retry(() =>
    spl.mintTo(conn, admin, usd, ata.address, admin, 10_000_000),
  );
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
  DEVNET ? "Smoke test - club" : "Local chess club",
  "private",
);
const club = created.club;
await send(owner, [created.instruction]);
// The security deposit: USDC (the test mint) locally, SOL on devnet, where the
// deposit mint is the real tUSDC. Closing the club refunds it at the end.
let ownerDeposit;
if (DEVNET) {
  const read = await solPrice();
  const lamports =
    (dep.depositShortfall(depositRules, "private", "sol", 0n, read.price) * 101n) / 100n;
  await send(admin, [
    SystemProgram.transfer({
      fromPubkey: admin.publicKey,
      toPubkey: owner.publicKey,
      lamports: lamports + 10_000_000n,
    }),
  ]);
  await send(owner, [
    await dep.depositClubSolInstruction(P, owner.publicKey, club, read.address, lamports),
  ]);
  ownerDeposit = { asset: "sol", amount: lamports };
} else {
  const ata = spl.getAssociatedTokenAddressSync(usd, owner.publicKey);
  await retry(() => spl.mintTo(conn, admin, usd, ata, admin, 100_000_000));
  await send(owner, [
    await dep.depositClubUsdcInstruction(P, owner.publicKey, club, usd, ata, 100_000_000n),
  ]);
  ownerDeposit = { asset: "usdc", amount: 100_000_000n };
}
const paid = (await c.clubAccounts(P).club.fetchNullable(club)).depositAmount;
assert.equal(paid.toString(), ownerDeposit.amount.toString());
log(`club deposit paid in ${ownerDeposit.asset.toUpperCase()}`);
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
const closeTs = (await chainNow()) + (DEVNET ? 300 : 25);
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
  DEVNET
    ? "Smoke test - club market"
    : "Will the local club market resolve YES?",
  "USD",
  false,
  DEVNET ? (await solPrice()).address : null,
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
assert.equal(bobBefore.sub(bobAfter).toString(), String(600_000 + fee));
snapshot = await c.readClub(P, club);
assert.equal(
  snapshot.markets[0].binding.accruedClubFees.toString(),
  String(clubFee),
);
log(`bob bought 1 YES at 0.60 + ${fee} fee; the club accrued ${clubFee}`);

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
// Alice (holding 2 YES) disputes with a one-token bond; finalization then
// waits for a ruling, and the protocol admin (not the creator, resolver or a
// club admin) upholds YES, which resolves the market at once.
const aliceToken = spl.getAssociatedTokenAddressSync(usd, alice.publicKey);
await retry(() => spl.mintTo(conn, admin, usd, aliceToken, admin, 1_000_000));
await send(alice, [
  await dis.openDisputeInstruction(P, "binary", alice.publicKey, market, usd, aliceToken),
]);
while ((await chainNow()) < proposedAt + 4) await sleep(1000);
await rejects(
  send(carol, [await c.advanceClubPredictionInstruction(P, market, 2)]),
  /DisputeOpen|0x184a/,
);
const disputeConfig = await dis.readDisputeConfig(P);
const treasuryToken = spl.getAssociatedTokenAddressSync(usd, disputeConfig.treasury, true);
await send(admin, [
  spl.createAssociatedTokenAccountIdempotentInstruction(
    admin.publicKey,
    treasuryToken,
    disputeConfig.treasury,
    usd,
  ),
  await dis.ruleDisputeInstruction(
    P,
    "binary",
    admin.publicKey,
    market,
    "uphold",
    treasuryToken,
    alice.publicKey,
    club,
  ),
]);
assert.equal((await spl.getAccount(conn, treasuryToken)).amount, 1_000_000n);
const dispute = await dis.readMarketDispute(P, market);
assert.equal(dis.disputeState(dispute), "upheld");
log("alice disputed; the protocol admin upheld YES and the bond went to the treasury");
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
if (clubFee > 0) {
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
      new BN(clubFee),
    ),
  ]);
  assert.equal(
    (await spl.getAccount(conn, destination)).amount - ownerTokens,
    BigInt(clubFee),
  );
  log(`owner withdrew the club's ${clubFee} fee share`);
} else log("no club fee share is configured, so there is nothing to withdraw");

// ----- Settle the market and close the club with its deposit refunded -----
await send(carol, [await life.settleClubMarketInstruction(P, carol.publicKey, club, market)]);
assert.equal((await c.clubAccounts(P).club.fetchNullable(club)).liveMarkets, 0);
const usdcRefund =
  ownerDeposit.asset === "usdc"
    ? { ownerToken: spl.getAssociatedTokenAddressSync(usd, owner.publicKey) }
    : null;
const before = usdcRefund
  ? (await spl.getAccount(conn, usdcRefund.ownerToken)).amount
  : BigInt(await conn.getBalance(owner.publicKey, "confirmed"));
await send(owner, [await life.closeClubInstruction(P, owner.publicKey, club, usdcRefund)]);
const after = usdcRefund
  ? (await spl.getAccount(conn, usdcRefund.ownerToken)).amount
  : BigInt(await conn.getBalance(owner.publicKey, "confirmed"));
// SOL: the refund plus the listing and membership rent, less the fee.
assert(after - before >= ownerDeposit.amount - (usdcRefund ? 0n : 10_000n));
const closed = await c.clubAccounts(P).club.fetchNullable(club);
assert(closed.closed && closed.depositAmount.isZero());
await rejects(
  send(owner, [
    await c.inviteClubMemberInstruction(P, owner.publicKey, club, carol.publicKey),
  ]),
  /./,
);
log("market settled; club closed and its deposit refunded to the owner");

report.club = club.toBase58();
report.market = market.toBase58();
report.mint = usd.toBase58();
report.wallets = Object.fromEntries(
  [
    ["owner", owner],
    ["alice", alice],
    ["bob", bob],
    ["carol", carol],
  ].map(([n, k]) => [n, k.publicKey.toBase58()]),
);
if (DEVNET) {
  // Return the temporary wallets' SOL; their rent-bearing accounts stay for audit.
  for (const kp of [owner, alice, bob, carol]) {
    const balance = await conn.getBalance(kp.publicKey, "confirmed");
    if (balance > 5_000)
      await send(kp, [
        SystemProgram.transfer({
          fromPubkey: kp.publicKey,
          toPubkey: admin.publicKey,
          lamports: balance - 5_000,
        }),
      ]);
  }
  log("temporary wallets' remaining SOL returned to the authority");
}
report.result = "passed";
if (process.env.RESULT)
  fs.writeFileSync(process.env.RESULT, JSON.stringify(report, null, 2) + "\n");
console.log(`PASS: club lifecycle end to end on ${report.cluster}`);
// Open RPC connections can keep Node alive after the run; finish explicitly.
process.exit(0);
