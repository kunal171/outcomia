/** Devnet smoke test for complementary matching after the 21 November upgrade.
 *
 *   node scripts/devnet-complement-smoke.mjs
 *
 * Uses a fresh valueless mint and a temporary trader wallet against the CLI
 * wallet (super-admin/admin) on hidden "Smoke test - ..." markets:
 *  1. Binary: a resting NO bid lets a YES buyer mint through the complement;
 *     a resting NO ask lets a YES seller merge.
 *  2. Multi-outcome (3 outcomes): one maker holds the best bid on both other
 *     outcomes and a buyer mints a full set (exercises account deduplication).
 *  3. A frozen market lookup table is created on devnet and a full-set merge
 *     is sent as a v0 transaction through it.
 * Supplies, backing and real reserve tokens are checked after every fill.
 * Keys stay under ignored target/; the public report has only addresses,
 * amounts and signatures. The temporary wallet's cash and SOL are returned.
 * Re-running after a failure resumes from the recorded steps.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
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
const spl = require("@solana/spl-token");

const root = fileURLToPath(new URL("../../", import.meta.url));
const reportFile = path.join(root, "docs/devnet/complement-smoke-result.json");
const privateDir = path.join(
  root,
  "target/deploy-history/2026-11-21-complementary-matching",
);
const traderFile = path.join(privateDir, "smoke-trader.json");
fs.mkdirSync(privateDir, { recursive: true });

const m = loadTypeScript(new URL("../lib/multi-outcome.ts", import.meta.url));
const creation = loadTypeScript(
  new URL("../lib/multi-outcome-creation.ts", import.meta.url),
);
const sh = loadTypeScript(new URL("../lib/shared.ts", import.meta.url));
const o = loadTypeScript(new URL("../lib/outcomia.ts", import.meta.url));
const pr = loadTypeScript(new URL("../lib/prediction.ts", import.meta.url));
const tables = loadTypeScript(
  new URL("../lib/market-lookup-table.ts", import.meta.url),
);
const visibility = loadTypeScript(
  new URL("../lib/market-visibility.ts", import.meta.url),
);

// Helius from the local env (never logged); the public endpoint rate-limits scans.
const rpc = (() => {
  const vars = {};
  const file = path.join(root, "app/.env");
  if (fs.existsSync(file))
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const match = line.match(/^(HELIUS_RPC_URL|HELIUS_API_KEY)=(.*)$/);
      if (match)
        vars[match[1]] = match[2].trim().replace(/^(["'])(.*)\1$/, "$2");
    }
  if (!vars.HELIUS_RPC_URL) return "https://api.devnet.solana.com";
  const url = new URL(vars.HELIUS_RPC_URL);
  if (vars.HELIUS_API_KEY && !url.searchParams.has("api-key"))
    url.searchParams.set("api-key", vars.HELIUS_API_KEY);
  return url.toString();
})();
const conn = new Connection(process.env.SOLANA_RPC_URL || rpc, "confirmed");
const idl = JSON.parse(
  fs.readFileSync(new URL("../idl/outcomia.json", import.meta.url), "utf8"),
);
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
const programFor = (kp) =>
  new Program(
    idl,
    new AnchorProvider(conn, new Wallet(kp), { commitment: "confirmed" }),
  );
const P = programFor(admin);

const previous = fs.existsSync(reportFile)
  ? JSON.parse(fs.readFileSync(reportFile, "utf8"))
  : null;
const resuming = previous?.result === "failed";
const report = resuming
  ? {
      ...previous,
      result: undefined,
      error: undefined,
      resumedAt: new Date().toISOString(),
    }
  : { program: idl.address, startedAt: new Date().toISOString(), steps: [] };
const save = () =>
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
const done = (label) => report.steps.some((s) => s.label === label);
async function send(label, tx, signers) {
  if (done(label)) return console.log(`skip ${label}`);
  const t = tx instanceof Transaction ? tx : new Transaction().add(...tx);
  const signature = await sendAndConfirmTransaction(conn, t, signers, {
    commitment: "confirmed",
  });
  report.steps.push({ label, signature });
  save();
  console.log(`ok  ${label}  ${signature}`);
}
async function sendV0(label, instructions, table, signer) {
  if (done(label)) return console.log(`skip ${label}`);
  const { blockhash, lastValidBlockHeight } =
    await conn.getLatestBlockhash("confirmed");
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: signer.publicKey,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message([table]),
  );
  const bytes = tx.serialize().length;
  assert.ok(bytes <= 1232, `v0 transaction is ${bytes} bytes`);
  tx.sign([signer]);
  const signature = await conn.sendRawTransaction(tx.serialize());
  const result = await conn.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    "confirmed",
  );
  assert.equal(result.value.err, null);
  report.steps.push({ label, signature, version: 0, bytes });
  save();
  console.log(`ok  ${label}  ${signature} (v0, ${bytes} bytes)`);
}
const tokens = async (address) => (await spl.getAccount(conn, address)).amount;

async function main() {
  const protocol = await P.account.protocolConfig.fetch(
    o.deriveProtocolConfigPda(),
  );
  assert.ok(
    protocol.superAdmin.equals(admin.publicKey),
    "CLI wallet must be super-admin",
  );
  const feeBps = protocol.takerFeeBps;

  const trader = resuming
    ? Keypair.fromSecretKey(
        Uint8Array.from(JSON.parse(fs.readFileSync(traderFile, "utf8"))),
      )
    : Keypair.generate();
  if (!resuming)
    fs.writeFileSync(traderFile, JSON.stringify([...trader.secretKey]));
  report.trader = trader.publicKey.toBase58();
  await send(
    "fund temporary trader",
    [
      SystemProgram.transfer({
        fromPubkey: admin.publicKey,
        toPubkey: trader.publicKey,
        lamports: 150_000_000,
      }),
    ],
    [admin],
  );
  const usd = report.collateralMint
    ? new PublicKey(report.collateralMint)
    : await spl.createMint(conn, admin, admin.publicKey, null, 6);
  report.collateralMint = usd.toBase58();
  save();

  const ata = {};
  for (const [name, kp, amount] of [
    ["admin", admin, 30_000_000],
    ["trader", trader, 20_000_000],
  ]) {
    ata[name] = (
      await spl.getOrCreateAssociatedTokenAccount(
        conn,
        admin,
        usd,
        kp.publicKey,
      )
    ).address;
    if (!done(`cash for ${name}`))
      await spl.mintTo(conn, admin, usd, ata[name], admin, amount);
    const c = {
      owner: kp.publicKey,
      mint: usd,
      assetBalance: sh.assetBalancePda(kp.publicKey, usd),
      vaultAuthority: sh.assetAuthorityPda(usd),
      assetVault: sh.assetVaultPda(usd),
      tokenProgram: o.TOKEN_PROGRAM_ID,
    };
    await send(
      `cash for ${name}`,
      [
        await P.methods
          .initializeAssetBalance()
          .accountsStrict({ ...c, systemProgram: SystemProgram.programId })
          .instruction(),
        await P.methods
          .depositAsset(new BN(amount))
          .accountsStrict({
            owner: c.owner,
            mint: usd,
            assetBalance: c.assetBalance,
            walletToken: ata[name],
            vaultAuthority: c.vaultAuthority,
            assetVault: c.assetVault,
            tokenProgram: o.TOKEN_PROGRAM_ID,
          })
          .instruction(),
      ],
      [kp],
    );
  }
  const now =
    (await conn.getBlockTime(await conn.getSlot())) ??
    Math.floor(Date.now() / 1000);
  const rules = {
    uri: "https://raw.githubusercontent.com/kunal171/outcomia/ce636ba/docs/complementary-matching.md",
    hash: crypto
      .createHash("sha256")
      .update(
        fs.readFileSync(path.join(root, "docs/complementary-matching.md")),
      )
      .digest(),
  };

  // ---- 1. Binary complement (shared book) --------------------------------
  const binName = "Smoke test - binary complement";
  assert.equal(visibility.visibleMarket("x", binName), false);
  const binId = report.binaryId
    ? Buffer.from(report.binaryId, "hex")
    : crypto.randomBytes(32);
  report.binaryId = binId.toString("hex");
  const bin = pr.derivePredictionMarketPda(binId);
  report.binaryMarket = bin.toBase58();
  save();
  await send(
    "create binary market",
    [
      await P.methods
        .initializePredictionMarket(
          [...binId],
          {
            resolver: admin.publicKey,
            fallback: null,
            closeTs: new BN(now + 7 * 86_400),
            earliestResolutionTs: null,
            resolutionDelaySeconds: new BN(3_600),
            payoutPerContract: new BN(1_000_000),
            priceTick: new BN(10_000),
            rulesUri: rules.uri,
            questionHash: [
              ...crypto.createHash("sha256").update(binName).digest(),
            ],
            rulesHash: [...rules.hash],
          },
          binName,
          "sUSD",
        )
        .accountsPartial({
          authority: admin.publicKey,
          adminRecord: o.deriveAdminRecordPda(admin.publicKey),
          market: bin,
          collateralMint: usd,
          vaultAuthority: o.deriveVaultAuthorityPda(bin),
          collateralVault: o.deriveVaultPda(bin, usd),
          marketMetadata: o.deriveMarketMetadataPda(bin),
          marketFees: o.deriveMarketFeesPda(bin),
          orderBook: pr.derivePredictionBookPda(bin),
          tokenProgram: o.TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
    ],
    [admin],
  );
  const manageBin = {
    authority: admin.publicKey,
    market: bin,
    adminRecord: o.deriveAdminRecordPda(admin.publicKey),
  };
  await send(
    "open binary market with shared book",
    [
      await P.methods
        .openPredictionMarket()
        .accountsStrict(manageBin)
        .instruction(),
      await P.methods
        .initializeSharedBook({ prediction: {} })
        .accountsStrict({
          ...manageBin,
          book: sh.sharedBookPda(bin),
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
    ],
    [admin],
  );
  for (const [name, kp] of [
    ["admin", admin],
    ["trader", trader],
  ])
    await send(
      `binary position for ${name}`,
      [
        await P.methods
          .initializePredictionPosition()
          .accountsStrict({
            owner: kp.publicKey,
            market: bin,
            position: pr.derivePredictionPositionPda(bin, kp.publicKey),
            systemProgram: SystemProgram.programId,
          })
          .instruction(),
      ],
      [kp],
    );
  const binTrade = async (label, kp, outcome, side, price, qty, complement) => {
    if (done(label)) return console.log(`skip ${label}`);
    const snap = await sh.readSharedBook(P, bin);
    const plan = await sh.buildSharedTrade(
      programFor(kp),
      snap,
      kp.publicKey,
      outcome,
      side,
      new BN(price),
      new BN(qty),
      [],
      complement,
    );
    assert.ok(plan.remaining.isZero(), `${label}: ${plan.stopReason}`);
    report.steps.push({
      label: `${label} plan`,
      instructions: plan.instructions.map(
        (i) => P.coder.instruction.decode(i.data).name,
      ),
    });
    await send(label, plan.instructions, [kp]);
  };
  const reserveBin = o.deriveVaultPda(bin, usd);
  const checkBinary = async (label, supply) => {
    const mk = await P.account.predictionMarket.fetch(bin);
    assert.equal(mk.yesSupply.toNumber(), supply);
    assert.equal(mk.noSupply.toNumber(), supply);
    assert.equal(mk.backingReserve.toNumber(), supply * 1_000_000);
    assert.equal(await tokens(reserveBin), BigInt(supply * 1_000_000));
    report.steps.push({ label: `check: ${label}`, supply });
    save();
  };
  await binTrade(
    "admin rests NO bid 0.40 x3",
    admin,
    "no",
    "bid",
    400_000,
    3,
    false,
  );
  await binTrade(
    "trader buys YES 0.65 x2 (complement mint)",
    trader,
    "yes",
    "bid",
    650_000,
    2,
    true,
  );
  await checkBinary("after binary mint", 2);
  // Above the admin's own remaining NO bid (0.40), so it does not self-cross.
  await binTrade(
    "admin rests NO ask 0.45 x1",
    admin,
    "no",
    "ask",
    450_000,
    1,
    false,
  );
  // Selling YES at 0.50 or better merges against it at 1 - 0.45 = 0.55.
  await binTrade(
    "trader sells YES 0.50 x1 (complement merge)",
    trader,
    "yes",
    "ask",
    500_000,
    1,
    true,
  );
  await checkBinary("after binary merge", 1);

  // ---- 2. Multi-outcome full set ----------------------------------------
  const multiName = "Smoke test - multi-outcome full set";
  assert.equal(visibility.visibleMarket("x", multiName), false);
  let multi;
  if (report.multiMarket) multi = new PublicKey(report.multiMarket);
  else {
    const plan = await creation.creationTransactions(
      P,
      admin.publicKey,
      crypto.randomBytes(32),
      usd,
      {
        resolver: admin.publicKey,
        fallback: null,
        outcomeLabels: ["Alpha", "Beta", "Gamma"],
        questionHash: [
          ...crypto.createHash("sha256").update(multiName).digest(),
        ],
        rulesHash: [...rules.hash],
        rulesUri: rules.uri,
        closeTs: new BN(now + 7 * 86_400),
        earliestResolutionTs: null,
        resolutionDelaySeconds: new BN(3_600),
        payoutPerContract: new BN(1_000_000),
        priceTick: new BN(10_000),
        quantityLot: new BN(3),
      },
      multiName,
      "sUSD",
    );
    for (const [i, tx] of plan.uploads.entries())
      await send(`stage multi terms ${i + 1}`, tx, [admin]);
    await send("create multi-outcome market", plan.create, [admin]);
    if (plan.cleanup) await send("close staged terms", plan.cleanup, [admin]);
    multi = plan.market;
    report.multiMarket = multi.toBase58();
    save();
  }
  const manageMulti = {
    authority: admin.publicKey,
    market: multi,
    adminRecord: o.deriveAdminRecordPda(admin.publicKey),
  };
  await send(
    "open multi-outcome market and book",
    [
      await P.methods
        .openMultiOutcomeMarket()
        .accountsStrict(manageMulti)
        .instruction(),
      await P.methods
        .initializeMultiOutcomeBook()
        .accountsStrict({
          ...manageMulti,
          book: m.multiBookPda(multi),
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
    ],
    [admin],
  );
  for (const [name, kp] of [
    ["admin", admin],
    ["trader", trader],
  ])
    await send(
      `multi position for ${name}`,
      [
        await P.methods
          .initializeMultiOutcomePosition()
          .accountsStrict({
            owner: kp.publicKey,
            market: multi,
            position: m.multiPositionPda(multi, kp.publicKey),
            systemProgram: SystemProgram.programId,
          })
          .instruction(),
      ],
      [kp],
    );
  const multiPlan = async (
    kp,
    outcome,
    side,
    price,
    qty,
    complement,
    table = null,
  ) => {
    const mk = await m.multiAccounts(P).multiOutcomeMarket.fetch(multi);
    const b = await m.readMultiBook(P, multi);
    return m.buildMultiTrade(
      programFor(kp),
      multi,
      mk,
      b.book,
      b.rows,
      kp.publicKey,
      outcome,
      side,
      new BN(price),
      new BN(qty),
      feeBps,
      complement,
      [],
      table,
    );
  };
  const multiTrade = async (
    label,
    kp,
    outcome,
    side,
    price,
    qty,
    complement,
  ) => {
    if (done(label)) return console.log(`skip ${label}`);
    const plan = await multiPlan(kp, outcome, side, price, qty, complement);
    assert.ok(plan.remaining.isZero());
    await send(label, plan.transaction, [kp]);
  };
  const reserveMulti = o.deriveVaultPda(multi, usd);
  const checkMulti = async (label, supply) => {
    const mk = await m.multiAccounts(P).multiOutcomeMarket.fetch(multi);
    assert.deepEqual(
      mk.supplies.slice(0, 3).map((s) => s.toNumber()),
      [supply, supply, supply],
    );
    assert.equal(mk.backingReserve.toNumber(), supply * 1_000_000);
    assert.equal(await tokens(reserveMulti), BigInt(supply * 1_000_000));
    report.steps.push({ label: `check: ${label}`, supply });
    save();
  };
  // One maker holds both other legs: its cash and position repeat in the instruction.
  await multiTrade(
    "admin rests Beta bid 0.30 x3",
    admin,
    1,
    "bid",
    300_000,
    3,
    false,
  );
  await multiTrade(
    "admin rests Gamma bid 0.25 x3",
    admin,
    2,
    "bid",
    250_000,
    3,
    false,
  );
  await multiTrade(
    "trader buys Alpha 0.50 x3 (full-set mint)",
    trader,
    0,
    "bid",
    500_000,
    3,
    true,
  );
  await checkMulti("after full-set mint", 3);

  // ---- 3. Lookup table + v0 full-set merge -----------------------------
  let table = await tables.findMarketTable(conn, multi, usd);
  if (!table) {
    const slot = await conn.getSlot("finalized");
    const created = tables.createMarketTableInstructions(
      admin.publicKey,
      multi,
      usd,
      slot,
    );
    report.lookupTable = created.table.toBase58();
    await send(
      "create, fill and freeze market lookup table",
      created.instructions,
      [admin],
    );
    for (let i = 0; !table && i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      table = await tables.findMarketTable(conn, multi, usd);
    }
  }
  assert.ok(table, "lookup table discovered");
  assert.equal(table.state.authority, undefined, "lookup table is frozen");
  report.lookupTable = table.key.toBase58();
  save();
  await multiTrade(
    "admin rests Beta ask 0.40 x3",
    admin,
    1,
    "ask",
    400_000,
    3,
    false,
  );
  await multiTrade(
    "admin rests Gamma ask 0.35 x3",
    admin,
    2,
    "ask",
    350_000,
    3,
    false,
  );
  if (!done("trader sells Alpha 0.20 x3 (full-set merge, v0)")) {
    const plan = await multiPlan(trader, 0, "ask", 200_000, 3, true, table);
    assert.ok(plan.remaining.isZero());
    assert.equal(
      P.coder.instruction.decode(plan.transaction.instructions[0].data).name,
      "matchMultiOutcomeComplement",
    );
    // A three-outcome set fits a legacy packet; send it as v0 anyway to prove
    // the table path on devnet.
    await sendV0(
      "trader sells Alpha 0.20 x3 (full-set merge, v0)",
      plan.transaction.instructions,
      table,
      trader,
    );
  }
  await checkMulti("after v0 full-set merge", 0);

  // ---- Cleanup: return the trader's cash and SOL ------------------------
  const traderCash = await P.account.assetBalance.fetch(
    sh.assetBalancePda(trader.publicKey, usd),
  );
  if (!traderCash.free.isZero())
    await send(
      "trader withdraws cash",
      [
        await P.methods
          .withdrawAsset(traderCash.free)
          .accountsStrict({
            owner: trader.publicKey,
            mint: usd,
            assetBalance: sh.assetBalancePda(trader.publicKey, usd),
            walletToken: ata.trader,
            vaultAuthority: sh.assetAuthorityPda(usd),
            assetVault: sh.assetVaultPda(usd),
            tokenProgram: o.TOKEN_PROGRAM_ID,
          })
          .instruction(),
      ],
      [trader],
    );
  const traderTokens = await tokens(ata.trader);
  if (traderTokens > 0n)
    await spl.burn(conn, trader, ata.trader, usd, trader, traderTokens);
  if (!done("trader token account closed")) {
    await spl.closeAccount(conn, trader, ata.trader, admin.publicKey, trader);
    report.steps.push({ label: "trader token account closed" });
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
  console.log("\nComplement smoke test passed.");
  process.exit(0);
}

const fail = (error) => {
  report.result = "failed";
  report.error = String(error?.stack ?? error);
  save();
  console.error(error);
  process.exit(1);
};
process.on("unhandledRejection", fail);
main().catch(fail);
