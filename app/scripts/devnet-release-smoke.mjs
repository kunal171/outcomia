/** Devnet smoke test for the 2026-11-21 release-hardening upgrade.
 *
 *   node scripts/devnet-release-smoke.mjs rules   # write the rules document (commit + push it)
 *   node scripts/devnet-release-smoke.mjs run     # execute against the pushed rules commit
 *
 * Checks, using a fresh valueless mint and a temporary second wallet:
 *  1. Spot increments (simulation only, no market is created): a too-fine
 *     market fails with SpotIncrementsTooFine; the exact boundary simulates.
 *  2. A hidden multi-outcome lifecycle: create, open, split, place, match
 *     through the app's real trade builder, cancel, freeze, propose, correct,
 *     a correction at the phase deadline fails with
 *     PredictionCorrectionWindowClosed although the proposal is immature,
 *     finalize, redeem both wallets, withdraw fees and cash, and conserve
 *     vault backing at every step.
 *
 * The market is named "Smoke test - ..." so public discovery hides it.
 * Signing keys stay under ignored target/; the public report holds only
 * addresses, amounts and signatures. Tokens are burned and spare SOL returned.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { loadTypeScript } from "./support/typescript.mjs";

const require = createRequire(import.meta.url);
const { AnchorProvider, BN, Program, Wallet } = require("@anchor-lang/core");
const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  sendAndConfirmTransaction,
} = require("@solana/web3.js");
const {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  burn,
  closeAccount,
  getAccount,
} = require("@solana/spl-token");

const root = fileURLToPath(new URL("../../", import.meta.url));
const rulesFile = path.join(root, "docs/devnet/release-smoke-rules.json");
const reportFile = path.join(root, "docs/devnet/release-smoke-result.json");
const privateDir = path.join(
  root,
  "target/deploy-history/2026-11-21-release-hardening",
);
const traderFile = path.join(privateDir, "smoke-trader.json");
const stage = process.argv[2];
if (!["rules", "run"].includes(stage)) throw new Error("Use rules or run");

const admin = Keypair.fromSecretKey(
  Uint8Array.from(
    JSON.parse(
      fs.readFileSync(
        path.join(os.homedir(), ".config/solana/id.json"),
        "utf8",
      ),
    ),
  ),
);

// --- Stage 1: rules document with a fixed future close -----------------------
const LABELS = ["Alpha", "Beta", "Gamma"];
if (stage === "rules") {
  const closeTs = Math.floor(Date.now() / 1000) + 8 * 60;
  const rules = {
    schemaVersion: 1,
    environment: "Solana devnet only",
    question: "Smoke test - which outcome does the release smoke resolve to?",
    purpose:
      "A technical deployment check with a newly created valueless token, not a public market.",
    resolutionSource:
      "docs/devnet/release-smoke-result.json in this repository, written by the smoke runner.",
    resolutionRules: {
      outcomes: [
        {
          label: "Alpha",
          criteria: "The runner proposes and finalizes Alpha.",
        },
        { label: "Beta", criteria: "The runner proposes and finalizes Beta." },
        {
          label: "Gamma",
          criteria: "The runner proposes and finalizes Gamma.",
        },
      ],
      invalidRefund: "equal-share",
      invalidCriteria: "The smoke run is interrupted before finalization.",
      evidenceRequirements:
        "Transaction signatures recorded in the smoke result document.",
      conflictingEvidencePolicy: "The on-chain proposal is authoritative.",
    },
    closeTimestamp: closeTs,
    earliestResolutionTimestamp: null,
    primaryResolver: admin.publicKey.toBase58(),
    fallback: null,
    resolutionDelaySeconds: 20,
  };
  fs.writeFileSync(rulesFile, `${JSON.stringify(rules, null, 2)}\n`);
  console.log(
    `Wrote ${path.relative(root, rulesFile)} with close ${new Date(closeTs * 1000).toISOString()}.`,
  );
  console.log("Commit and push it, then run the 'run' stage before that time.");
  process.exit(0);
}

// --- Stage 2: run ------------------------------------------------------------
const m = loadTypeScript(new URL("../lib/multi-outcome.ts", import.meta.url));
const creation = loadTypeScript(
  new URL("../lib/multi-outcome-creation.ts", import.meta.url),
);
const shared = loadTypeScript(new URL("../lib/shared.ts", import.meta.url));
const o = loadTypeScript(new URL("../lib/outcomia.ts", import.meta.url));
const visibility = loadTypeScript(
  new URL("../lib/market-visibility.ts", import.meta.url),
);

// Prefer SOLANA_RPC_URL or the local (never logged) Helius URL from app/.env;
// the public endpoint rate-limits program-account scans.
const envRpc = (() => {
  const file = path.join(root, "app/.env");
  if (!fs.existsSync(file)) return null;
  const vars = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^(HELIUS_RPC_URL|HELIUS_API_KEY)=(.*)$/);
    if (match) vars[match[1]] = match[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  if (!vars.HELIUS_RPC_URL) return null;
  const url = new URL(vars.HELIUS_RPC_URL);
  if (vars.HELIUS_API_KEY && !url.searchParams.has("api-key"))
    url.searchParams.set("api-key", vars.HELIUS_API_KEY);
  return url.toString();
})();
const conn = new Connection(
  process.env.SOLANA_RPC_URL || envRpc || "https://api.devnet.solana.com",
  "confirmed",
);
const idl = JSON.parse(
  fs.readFileSync(new URL("../idl/outcomia.json", import.meta.url), "utf8"),
);
const p = new Program(idl, new AnchorProvider(conn, new Wallet(admin), {}));
const programId = new PublicKey(idl.address);
const previous = fs.existsSync(reportFile)
  ? JSON.parse(fs.readFileSync(reportFile, "utf8"))
  : null;
const resuming = previous?.result === "failed" && !!previous.market;
const report = resuming
  ? {
      ...previous,
      result: undefined,
      error: undefined,
      resumedAt: new Date().toISOString(),
    }
  : { program: idl.address, startedAt: new Date().toISOString(), steps: [] };
const done = (label) => report.steps.some((s) => s.label === label);
const save = () =>
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
const sleepUntil = async (unix) => {
  for (;;) {
    const slot = await conn.getSlot("confirmed");
    const now = await conn.getBlockTime(slot);
    if (now >= unix) return now;
    await new Promise((r) => setTimeout(r, Math.min(5, unix - now) * 1000));
  }
};
const chainNow = async () => conn.getBlockTime(await conn.getSlot("confirmed"));

async function send(label, ixs, signers) {
  if (done(label)) return console.log(`skip ${label} (already done)`);
  const tx = ixs instanceof Transaction ? ixs : new Transaction().add(...ixs);
  const signature = await sendAndConfirmTransaction(conn, tx, signers, {
    commitment: "confirmed",
  });
  report.steps.push({ label, signature });
  save();
  console.log(`ok  ${label}  ${signature}`);
  return signature;
}
async function simulate(ixs, payer) {
  const { blockhash } = await conn.getLatestBlockhash();
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message();
  const result = await conn.simulateTransaction(
    new VersionedTransaction(message),
    {
      sigVerify: false,
      replaceRecentBlockhash: true,
    },
  );
  return { err: result.value.err, logs: result.value.logs ?? [] };
}
async function expectRejected(label, ixs, payer, error) {
  if (done(label)) return console.log(`skip ${label} (already done)`);
  const r = await simulate(ixs, payer);
  assert.ok(r.err, `${label}: expected failure`);
  assert.ok(
    r.logs.some((line) => line.includes(error)),
    `${label}: expected ${error}, got ${r.logs.join("\n")}`,
  );
  report.steps.push({ label, simulated: "rejected", error });
  save();
  console.log(`ok  ${label}  (simulated: ${error})`);
}
const tokens = async (address) => (await getAccount(conn, address)).amount;

async function main() {
  // Rules must be pushed exactly as committed; pin the URI to that commit.
  const bytes = fs.readFileSync(rulesFile);
  const rules = JSON.parse(bytes);
  const relative = path.relative(root, rulesFile);
  const commit = execFileSync(
    "git",
    ["log", "-1", "--format=%H", "--", relative],
    { cwd: root, encoding: "utf8" },
  ).trim();
  assert.ok(commit, "Commit the rules document first");
  const committed = execFileSync("git", ["show", `${commit}:${relative}`], {
    cwd: root,
  });
  assert.ok(committed.equals(bytes), "Rules differ from their commit");
  const rulesUri = `https://raw.githubusercontent.com/kunal171/outcomia/${commit}/${relative}`;
  const rulesHash = crypto.createHash("sha256").update(bytes).digest();
  const closeTs = rules.closeTimestamp;
  if (!resuming)
    assert.ok(
      closeTs > (await chainNow()) + 120,
      "Close is too soon; rerun rules",
    );
  Object.assign(report, { rulesUri, rulesSha256: rulesHash.toString("hex") });

  // Upgraded program check: the binary on chain must know the new errors.
  assert.ok(
    idl.errors.some((e) => e.name === "PredictionCorrectionWindowClosed"),
  );

  const protocol = await p.account.protocolConfig.fetch(
    o.deriveProtocolConfigPda(),
  );
  assert.ok(
    protocol.superAdmin.equals(admin.publicKey),
    "CLI wallet must be super-admin",
  );
  const feeBps = protocol.takerFeeBps;
  const adminRecord = await p.account.adminRecord.fetch(
    o.deriveAdminRecordPda(admin.publicKey),
  );
  assert.ok(
    "active" in adminRecord.status,
    "CLI wallet needs an active admin record",
  );

  // Temporary second wallet; its key stays private for recovery.
  fs.mkdirSync(privateDir, { recursive: true });
  const trader = resuming
    ? Keypair.fromSecretKey(
        Uint8Array.from(JSON.parse(fs.readFileSync(traderFile, "utf8"))),
      )
    : Keypair.generate();
  if (resuming) assert.equal(trader.publicKey.toBase58(), report.trader);
  else fs.writeFileSync(traderFile, JSON.stringify([...trader.secretKey]));
  await send(
    "fund temporary trader",
    [
      SystemProgram.transfer({
        fromPubkey: admin.publicKey,
        toPubkey: trader.publicKey,
        lamports: 100_000_000,
      }),
    ],
    [admin],
  );

  // Fresh valueless collateral (6 decimals) and a 9-decimal spot base.
  const usd = resuming
    ? new PublicKey(report.collateralMint)
    : await createMint(conn, admin, admin.publicKey, null, 6);
  const spotBase = resuming
    ? new PublicKey(report.spotBaseMint)
    : await createMint(conn, admin, admin.publicKey, null, 9);
  Object.assign(report, {
    trader: trader.publicKey.toBase58(),
    collateralMint: usd.toBase58(),
    spotBaseMint: spotBase.toBase58(),
  });
  save();

  // 1. Spot increments: simulation only, nothing is created.
  const spotIx = async (tick, lot) => {
    const market = o.deriveMarketPda(spotBase, usd);
    return p.methods
      .initializeMarket(new BN(tick), new BN(lot))
      .accountsStrict({
        authority: admin.publicKey,
        adminRecord: o.deriveAdminRecordPda(admin.publicKey),
        market,
        marketFees: o.deriveMarketFeesPda(market),
        baseMint: spotBase,
        quoteMint: usd,
        vaultAuthority: o.deriveVaultAuthorityPda(market),
        baseVault: o.deriveVaultPda(market, spotBase),
        quoteVault: o.deriveVaultPda(market, usd),
        tokenProgram: o.TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  };
  await expectRejected(
    "spot market with tick 1 x lot 1 at 9 decimals",
    [await spotIx(1, 1)],
    admin.publicKey,
    "SpotIncrementsTooFine",
  );
  if (!done("spot market at tick x lot = 10^9")) {
    const boundary = await simulate(
      [await spotIx(10_000, 100_000)],
      admin.publicKey,
    );
    assert.equal(boundary.err, null, boundary.logs.join("\n"));
    report.steps.push({
      label: "spot market at tick x lot = 10^9",
      simulated: "accepted",
    });
    console.log("ok  spot market at tick x lot = 10^9  (simulated: accepted)");
  }

  // Cash for both wallets in the shared asset ledger.
  const adminAta = await getOrCreateAssociatedTokenAccount(
    conn,
    admin,
    usd,
    admin.publicKey,
  );
  const traderAta = await getOrCreateAssociatedTokenAccount(
    conn,
    admin,
    usd,
    trader.publicKey,
  );
  if (!done("shared cash for creator")) {
    await mintTo(conn, admin, usd, adminAta.address, admin, 20_000_000);
    await mintTo(conn, admin, usd, traderAta.address, admin, 5_000_000);
  }
  for (const [who, ata, amount] of [
    [admin, adminAta.address, 20_000_000],
    [trader, traderAta.address, 5_000_000],
  ]) {
    const custody = {
      owner: who.publicKey,
      mint: usd,
      assetBalance: shared.assetBalancePda(who.publicKey, usd),
      vaultAuthority: shared.assetAuthorityPda(usd),
      assetVault: shared.assetVaultPda(usd),
      tokenProgram: o.TOKEN_PROGRAM_ID,
    };
    await send(
      `shared cash for ${who === admin ? "creator" : "trader"}`,
      [
        await p.methods
          .initializeAssetBalance()
          .accountsStrict({
            ...custody,
            systemProgram: SystemProgram.programId,
          })
          .instruction(),
        await p.methods
          .depositAsset(new BN(amount))
          .accountsStrict({
            owner: custody.owner,
            mint: usd,
            assetBalance: custody.assetBalance,
            walletToken: ata,
            vaultAuthority: custody.vaultAuthority,
            assetVault: custody.assetVault,
            tokenProgram: o.TOKEN_PROGRAM_ID,
          })
          .instruction(),
      ],
      [who],
    );
  }

  // 2. Multi-outcome market, created through the app's creation builder.
  const id = crypto.randomBytes(32);
  const name = "Smoke test - multi-outcome lifecycle";
  assert.equal(visibility.visibleMarket("unknown", name), false);
  const terms = {
    resolver: admin.publicKey,
    fallback: null,
    outcomeLabels: LABELS,
    questionHash: [
      ...crypto.createHash("sha256").update(rules.question).digest(),
    ],
    rulesHash: [...rulesHash],
    rulesUri,
    closeTs: new BN(closeTs),
    earliestResolutionTs: null,
    resolutionDelaySeconds: new BN(rules.resolutionDelaySeconds),
    payoutPerContract: new BN(1_000_000),
    priceTick: new BN(10_000),
    quantityLot: new BN(3),
  };
  let market;
  if (resuming) market = new PublicKey(report.market);
  else {
    const plan = await creation.creationTransactions(
      p,
      admin.publicKey,
      id,
      usd,
      terms,
      name,
      "sUSD",
    );
    for (const [i, tx] of plan.uploads.entries())
      await send(`stage terms ${i + 1}/${plan.uploads.length}`, tx, [admin]);
    await send("create multi-outcome market", plan.create, [admin]);
    if (plan.cleanup) await send("close staged terms", plan.cleanup, [admin]);
    market = plan.market;
  }
  report.market = market.toBase58();
  save();
  const manage = {
    authority: admin.publicKey,
    market,
    adminRecord: o.deriveAdminRecordPda(admin.publicKey),
  };
  await send(
    "open market and initialize book",
    [
      await p.methods
        .openMultiOutcomeMarket()
        .accountsStrict(manage)
        .instruction(),
      await p.methods
        .initializeMultiOutcomeBook()
        .accountsStrict({
          ...manage,
          book: m.multiBookPda(market),
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
    ],
    [admin],
  );
  for (const who of [admin, trader])
    await send(
      `position for ${who === admin ? "creator" : "trader"}`,
      [
        await p.methods
          .initializeMultiOutcomePosition()
          .accountsStrict({
            owner: who.publicKey,
            market,
            position: m.multiPositionPda(market, who.publicKey),
            systemProgram: SystemProgram.programId,
          })
          .instruction(),
      ],
      [who],
    );

  const marketVault = o.deriveVaultPda(market, usd);
  const assetVault = shared.assetVaultPda(usd);
  const accounts = m.multiAccounts(p);
  async function conserve(label) {
    const mk = await accounts.multiOutcomeMarket.fetch(market);
    const book = await accounts.multiOutcomeBook.fetch(m.multiBookPda(market));
    const balances = await Promise.all(
      [admin, trader].map((w) =>
        p.account.assetBalance.fetch(shared.assetBalancePda(w.publicKey, usd)),
      ),
    );
    const claims = balances.reduce(
      (sum, b) => sum + BigInt(b.free.toString()) + BigInt(b.locked.toString()),
      0n,
    );
    assert.equal(
      await tokens(marketVault),
      BigInt(mk.backingReserve.toString()),
      `${label}: reserve`,
    );
    assert.equal(
      await tokens(assetVault),
      claims + BigInt(book.accruedCollateralFees.toString()),
      `${label}: shared vault`,
    );
    report.steps.push({
      label: `conservation: ${label}`,
      reserve: mk.backingReserve.toString(),
    });
    save();
  }

  // Creator splits 6 complete sets (6 sUSD).
  await send(
    "creator splits 6 complete sets",
    [
      await p.methods
        .multiOutcomeCompleteSet(new BN(6), true)
        .accountsStrict(m.custody(market, admin.publicKey, usd))
        .instruction(),
    ],
    [admin],
  );
  await conserve("after split");

  const trade = async (label, who, outcome, side, price, quantity) => {
    if (done(label)) return console.log(`skip ${label} (already done)`);
    const mk = await accounts.multiOutcomeMarket.fetch(market);
    const current = await m.readMultiBook(p, market);
    const built = await m.buildMultiTrade(
      p,
      market,
      mk,
      current.book,
      current.rows,
      who.publicKey,
      outcome,
      side,
      new BN(price),
      new BN(quantity),
      feeBps,
    );
    assert.ok(built.remaining.isZero(), `${label}: incomplete plan`);
    await send(label, built.transaction, [who]);
  };
  await trade(
    "creator rests sell 3 Alpha at 0.40",
    admin,
    0,
    "ask",
    400_000,
    3,
  );
  await trade(
    "trader buys 3 Alpha at 0.40 (match)",
    trader,
    0,
    "bid",
    400_000,
    3,
  );
  await conserve("after match");
  await trade("creator rests sell 3 Beta at 0.50", admin, 1, "ask", 500_000, 3);
  const { rows } = await m.readMultiBook(p, market);
  const resting = rows.find((r) => r.account.owner.equals(admin.publicKey));
  if (!done("creator cancels Beta order"))
    assert.ok(resting, "Beta order must rest");
  if (resting)
    await send(
      "creator cancels Beta order",
      [
        await p.methods
          .cancelMultiOutcomeOrder()
          .accountsStrict({
            owner: admin.publicKey,
            market,
            book: m.multiBookPda(market),
            order: resting.publicKey,
            cash: shared.assetBalancePda(admin.publicKey, usd),
            position: m.multiPositionPda(market, admin.publicKey),
            previous: resting.account.previous ?? programId,
            next: resting.account.next ?? programId,
          })
          .instruction(),
      ],
      [admin],
    );
  await conserve("after cancel");

  // Resolution with the per-phase correction deadline (delay 20 s, earliest = close).
  const delay = rules.resolutionDelaySeconds;
  const deadline = closeTs + 2 * delay;
  const propose = async (outcome, correction) =>
    p.methods
      .proposeMultiOutcome(
        { winner: [[outcome]] },
        `${rulesUri}#${correction ? "correction" : "proposal"}`,
        [
          ...crypto
            .createHash("sha256")
            .update(`${outcome}:${correction}:${Date.now()}`)
            .digest(),
        ],
        correction,
      )
      .accountsStrict({
        resolver: admin.publicKey,
        market,
        adminRecord: o.deriveAdminRecordPda(admin.publicKey),
      })
      .instruction();
  const advance = async (action) =>
    p.methods
      .advanceMultiOutcome(action)
      .accountsStrict({ market })
      .instruction();

  console.log(`waiting for close at ${new Date(closeTs * 1000).toISOString()}`);
  await sleepUntil(closeTs);
  await send("freeze at cutoff", [await advance(0)], [admin]);
  await send("propose Beta", [await propose(1, false)], [admin]);
  await sleepUntil(closeTs + 15);
  await send("correct to Alpha", [await propose(0, true)], [admin]);
  await sleepUntil(deadline - 8);
  await send(
    "correct to Alpha again near the deadline",
    [await propose(0, true)],
    [admin],
  );
  const pending = await accounts.multiOutcomeMarket.fetch(market);
  const maturity = pending.proposal.proposedAt.toNumber() + delay;
  assert.ok(
    maturity > deadline,
    "last correction must mature after the deadline",
  );
  await sleepUntil(deadline);
  if (!done("correction at the phase deadline before maturity"))
    assert.ok(
      (await chainNow()) < maturity,
      "deadline check must run before maturity",
    );
  await expectRejected(
    "correction at the phase deadline before maturity",
    [await propose(0, true)],
    admin.publicKey,
    "PredictionCorrectionWindowClosed",
  );
  await sleepUntil(maturity);
  await send(
    "permissionless finalize (signed by trader)",
    [await advance(2)],
    [trader],
  );
  const resolved = await accounts.multiOutcomeMarket.fetch(market);
  // Anchor decodes the tuple as indexable objects or arrays; compare the index.
  assert.equal(Number(resolved.finalOutcome.winner[0][0]), 0, "Alpha must win");

  for (const who of [admin, trader]) {
    const position = await accounts.multiOutcomePosition.fetch(
      m.multiPositionPda(market, who.publicKey),
    );
    await send(
      `${who === admin ? "creator" : "trader"} redeems`,
      [
        await p.methods
          .redeemMultiOutcome(position.free)
          .accountsStrict(m.custody(market, who.publicKey, usd))
          .instruction(),
      ],
      [who],
    );
  }
  await conserve("after redemption");
  assert.equal(
    (await accounts.multiOutcomeMarket.fetch(market)).backingReserve.toString(),
    "0",
  );

  // Cleanup: fees, cash, tokens and SOL.
  const book = await accounts.multiOutcomeBook.fetch(m.multiBookPda(market));
  if (!book.accruedCollateralFees.isZero())
    await send(
      "withdraw earned fees",
      [
        await p.methods
          .withdrawMultiOutcomeFees(book.accruedCollateralFees)
          .accountsStrict({
            superAdmin: admin.publicKey,
            protocolConfig: o.deriveProtocolConfigPda(),
            market,
            book: m.multiBookPda(market),
            mint: usd,
            destination: adminAta.address,
            vaultAuthority: shared.assetAuthorityPda(usd),
            assetVault,
            tokenProgram: o.TOKEN_PROGRAM_ID,
          })
          .instruction(),
      ],
      [admin],
    );
  for (const [who, ata] of [
    [admin, adminAta.address],
    [trader, traderAta.address],
  ]) {
    const balance = await p.account.assetBalance.fetch(
      shared.assetBalancePda(who.publicKey, usd),
    );
    if (!balance.free.isZero())
      await send(
        `${who === admin ? "creator" : "trader"} withdraws cash`,
        [
          await p.methods
            .withdrawAsset(balance.free)
            .accountsStrict({
              owner: who.publicKey,
              mint: usd,
              assetBalance: shared.assetBalancePda(who.publicKey, usd),
              walletToken: ata,
              vaultAuthority: shared.assetAuthorityPda(usd),
              assetVault,
              tokenProgram: o.TOKEN_PROGRAM_ID,
            })
            .instruction(),
        ],
        [who],
      );
  }
  assert.equal(await tokens(assetVault), 0n, "shared vault must be empty");
  assert.equal(await tokens(marketVault), 0n, "market vault must be empty");
  const finalAmounts = {
    creator: (await tokens(adminAta.address)).toString(),
    trader: (await tokens(traderAta.address)).toString(),
  };
  report.finalWalletTokens = finalAmounts;
  for (const [who, ata] of [
    [admin, adminAta.address],
    [trader, traderAta.address],
  ]) {
    const amount = await tokens(ata);
    if (amount > 0n) await burn(conn, admin, ata, usd, who, amount);
    await closeAccount(conn, admin, ata, admin.publicKey, who);
  }
  const lamports = await conn.getBalance(trader.publicKey);
  if (lamports > 5_000)
    await send(
      "return trader SOL",
      [
        SystemProgram.transfer({
          fromPubkey: trader.publicKey,
          toPubkey: admin.publicKey,
          lamports: lamports - 5_000,
        }),
      ],
      [trader],
    );
  report.completedAt = new Date().toISOString();
  report.result = "passed";
  save();
  console.log(
    `\nSmoke test passed. Report: ${path.relative(root, reportFile)}`,
  );
  // Confirmation websockets keep the event loop alive after success.
  process.exit(0);
}

process.on("unhandledRejection", (error) => {
  report.result = "failed";
  report.error = String(error?.stack ?? error);
  save();
  console.error(error);
  process.exit(1);
});
main().catch((error) => {
  report.result = "failed";
  report.error = String(error?.stack ?? error);
  save();
  console.error(error);
  process.exit(1);
});
