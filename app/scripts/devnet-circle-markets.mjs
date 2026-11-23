/** Devnet demo markets on Circle's devnet USDC
 * (4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU).
 *
 *   node scripts/devnet-circle-markets.mjs rules
 *   RULES_REF=<commit> node scripts/devnet-circle-markets.mjs seed
 *
 * Circle devnet USDC only comes from Circle's faucet, so the CLI wallet
 * (super-admin, creator and resolver) is the only maker: it deposits what it
 * holds and rests one-lot YES and NO bids below fair value in every market.
 * More liquidity can be added after topping the wallet up at
 * faucet.circle.com. Rules live in docs/devnet/circle-markets and are pinned
 * by commit. Re-running resumes from the recorded steps.
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
  sendAndConfirmTransaction,
} = require("@solana/web3.js");
const spl = require("@solana/spl-token");

const root = fileURLToPath(new URL("../../", import.meta.url));
const rulesDir = path.join(root, "docs/devnet/circle-markets");
const reportFile = path.join(root, "docs/devnet/circle-markets-result.json");
const USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

const m = loadTypeScript(new URL("../lib/multi-outcome.ts", import.meta.url));
const creation = loadTypeScript(
  new URL("../lib/multi-outcome-creation.ts", import.meta.url),
);
const sh = loadTypeScript(new URL("../lib/shared.ts", import.meta.url));
const o = loadTypeScript(new URL("../lib/outcomia.ts", import.meta.url));
const pr = loadTypeScript(new URL("../lib/prediction.ts", import.meta.url));
const draftLib = loadTypeScript(
  new URL("../lib/prediction-rules-draft.ts", import.meta.url),
);
const visibility = loadTypeScript(
  new URL("../lib/market-visibility.ts", import.meta.url),
);

const UNIT = 1_000_000;
const TICK = 10_000;
const price = (p) => Math.round(p * 100) * TICK;
const CRYPTO =
  "CoinGecko daily USD price page for the asset (coingecko.com), cross-checked with Coinbase and Kraken spot prices.";

// Prices reflect public reporting on 23 November 2026 (see demo-markets).
const binary = [
  {
    slug: "btc-below-50k-before-2027",
    name: "Bitcoin below $50k before 2027?",
    question:
      "Will Bitcoin (BTC) trade at or below $50,000 at any time before 1 January 2027 00:00 UTC?",
    description:
      "BTC dipped to about $55,250 in November 2026 and traded near $61,000 on 23 November.",
    source: CRYPTO,
    yes: "Resolve YES if any 1-minute BTC/USD trade on Coinbase or Kraken prints at or below $50,000.00 before 1 January 2027 00:00 UTC.",
    no: "Resolve NO if no qualifying trade prints at or below $50,000.00 in that period.",
    close: "2026-12-31T22:00:00Z",
    resolve: "2027-01-01T00:30:00Z",
    p: 0.18,
  },
  {
    slug: "eth-below-1500-before-2027",
    name: "Ethereum below $1,500 before 2027?",
    question:
      "Will Ethereum (ETH) trade at or below $1,500 at any time before 1 January 2027 00:00 UTC?",
    description: "ETH traded near $1,820 on 22 November 2026.",
    source: CRYPTO,
    yes: "Resolve YES if any 1-minute ETH/USD trade on Coinbase or Kraken prints at or below $1,500.00 before 1 January 2027 00:00 UTC.",
    no: "Resolve NO if no qualifying trade prints at or below $1,500.00 in that period.",
    close: "2026-12-31T22:00:00Z",
    resolve: "2027-01-01T00:30:00Z",
    p: 0.21,
  },
  {
    slug: "sol-above-100-before-2027",
    name: "Solana above $100 before 2027?",
    question:
      "Will Solana (SOL) trade at or above $100 at any time before 1 January 2027 00:00 UTC?",
    description: "SOL traded near $70 on 22 November 2026.",
    source: CRYPTO,
    yes: "Resolve YES if any 1-minute SOL/USD trade on Coinbase or Kraken prints at or above $100.00 before 1 January 2027 00:00 UTC.",
    no: "Resolve NO if no qualifying trade prints at or above $100.00 in that period.",
    close: "2026-12-31T22:00:00Z",
    resolve: "2027-01-01T00:30:00Z",
    p: 0.08,
  },
  {
    slug: "fed-hike-50bp-december",
    name: "Fed hikes 50 bp or more on 9 December?",
    question:
      "Will the FOMC raise the federal funds target range by 0.50 percentage points or more on 9 December 2026?",
    description:
      "The target range is 3.75–4.00%; FOMC minutes mentioned a hike above 25 bp as a possibility.",
    source:
      "Federal Reserve FOMC statement published at federalreserve.gov on 9 December 2026.",
    yes: "Resolve YES if the upper bound of the target range rises by 0.50 percentage points or more.",
    no: "Resolve NO if it rises by less than 0.50 percentage points, is held or is lowered.",
    close: "2026-12-09T18:00:00Z",
    resolve: "2026-12-09T19:30:00Z",
    p: 0.12,
  },
  {
    slug: "man-city-beat-chelsea-12-dec",
    name: "Man City beat Chelsea on 12 December?",
    question:
      "Will Manchester City beat Chelsea in their Premier League match on 12 December 2026?",
    description: "Manchester City host Chelsea in the Premier League.",
    source: "Official Premier League match result at premierleague.com.",
    yes: "Resolve YES if Manchester City win the match in regulation time.",
    no: "Resolve NO if the match ends in a draw or a Chelsea win.",
    close: "2026-12-12T11:00:00Z",
    resolve: "2026-12-13T09:00:00Z",
    p: 0.55,
  },
  {
    slug: "arsenal-beat-man-utd-19-dec",
    name: "Arsenal beat Man United on 19 December?",
    question:
      "Will Arsenal beat Manchester United in their Premier League match at the Emirates Stadium on 19 December 2026?",
    description:
      "Arsenal lead the table; Manchester United appointed Mauricio Pochettino on 18 November 2026.",
    source: "Official Premier League match result at premierleague.com.",
    yes: "Resolve YES if Arsenal win the match in regulation time.",
    no: "Resolve NO if the match ends in a draw or a Manchester United win.",
    close: "2026-12-19T11:00:00Z",
    resolve: "2026-12-20T09:00:00Z",
    p: 0.6,
  },
  {
    slug: "spurs-top-west-new-year",
    name: "Spurs top the West on 31 December?",
    question:
      "Will the San Antonio Spurs have the best win percentage in the NBA Western Conference after all games on 31 December 2026 (US Eastern)?",
    description: "The Spurs and Lakers were both 14-3 in late November 2026.",
    source: "NBA Western Conference standings at nba.com on 1 January 2027.",
    yes: "Resolve YES if the Spurs are first in the Western Conference by win percentage (ties resolved by official NBA tiebreakers).",
    no: "Resolve NO if any other Western Conference team is first.",
    close: "2026-12-31T23:00:00Z",
    resolve: "2027-01-01T12:00:00Z",
    p: 0.38,
  },
  {
    slug: "antonelli-wins-abu-dhabi",
    name: "Antonelli wins the Abu Dhabi GP?",
    question:
      "Will Kimi Antonelli win the 2026 Abu Dhabi Grand Prix on 6 December 2026?",
    description:
      "Antonelli clinched the 2026 drivers' title at the Mexico City Grand Prix.",
    source: "Official race classification at formula1.com.",
    yes: "Resolve YES if Kimi Antonelli is classified first in the official race result.",
    no: "Resolve NO if any other driver is classified first.",
    close: "2026-12-06T12:00:00Z",
    resolve: "2026-12-06T17:00:00Z",
    p: 0.3,
  },
];

const multi = [
  {
    slug: "abu-dhabi-gp-winner",
    name: "Abu Dhabi GP winner, 6 December",
    question: "Who will win the 2026 Abu Dhabi Grand Prix on 6 December 2026?",
    description: "Season finale at Yas Marina; Antonelli is already champion.",
    source: "Official race classification at formula1.com.",
    outcomes: [
      ["Antonelli", "Kimi Antonelli is classified first."],
      ["Verstappen", "Max Verstappen is classified first."],
      ["Russell", "George Russell is classified first."],
      ["Any other driver", "Any other driver is classified first."],
    ],
    close: "2026-12-06T12:00:00Z",
    resolve: "2026-12-06T17:00:00Z",
    p: [0.3, 0.24, 0.16, 0.3],
  },
  {
    slug: "eth-price-end-2026",
    name: "Ethereum price on 31 December 2026",
    question:
      "Which range will Ethereum's CoinGecko daily close for 31 December 2026 fall in?",
    description: "ETH traded near $1,820 on 22 November 2026.",
    source: CRYPTO,
    outcomes: [
      ["Below $1,500", "Daily close below $1,500.00."],
      [
        "$1,500-$2,000",
        "Daily close from $1,500.00 up to and including $2,000.00.",
      ],
      [
        "$2,000-$2,500",
        "Daily close above $2,000.00 up to and including $2,500.00.",
      ],
      ["Above $2,500", "Daily close above $2,500.00."],
    ],
    close: "2026-12-31T22:00:00Z",
    resolve: "2027-01-01T01:00:00Z",
    p: [0.2, 0.5, 0.22, 0.08],
  },
];
for (const d of [...binary, ...multi]) {
  assert.ok(/^[\x20-\x7e]{1,64}$/.test(d.name), d.name);
  assert.ok(visibility.visibleMarket("x", d.name), d.name);
}
for (const d of multi)
  assert.ok(
    UNIT % d.outcomes.length === 0,
    `${d.slug}: lot 1 needs exact refunds`,
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

function rulesDocument(d) {
  const draft = {
    ...draftLib.initialPredictionRulesDraft(),
    question: d.question,
    description: d.description,
    resolutionSource: d.source,
    closeTime: d.close,
    earliestResolutionTime: d.resolve,
    resolutionDelaySeconds: "3600",
    ...(d.outcomes ? {} : { yesCriteria: d.yes, noCriteria: d.no }),
  };
  return draftLib.serializePredictionRulesDraft(
    draft,
    admin.publicKey.toBase58(),
    d.outcomes?.map(([label, criteria]) => ({ label, criteria })),
  );
}

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

async function seed() {
  const ref = process.env.RULES_REF;
  assert.ok(
    /^[0-9a-f]{40}$/.test(ref ?? ""),
    "Set RULES_REF to the pushed commit containing the rules",
  );
  const conn = new Connection(process.env.SOLANA_RPC_URL || rpc, "confirmed");
  const idl = JSON.parse(
    fs.readFileSync(new URL("../idl/outcomia.json", import.meta.url), "utf8"),
  );
  const P = new Program(
    idl,
    new AnchorProvider(conn, new Wallet(admin), { commitment: "confirmed" }),
  );
  const report = fs.existsSync(reportFile)
    ? JSON.parse(fs.readFileSync(reportFile, "utf8"))
    : {
        program: idl.address,
        collateralMint: USDC.toBase58(),
        startedAt: new Date().toISOString(),
        markets: {},
        steps: [],
      };
  report.rulesRef = ref;
  const save = () =>
    fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  const done = (label) => report.steps.some((s) => s.label === label);
  async function send(label, ixs) {
    if (done(label)) return console.log(`skip ${label}`);
    const tx = ixs instanceof Transaction ? ixs : new Transaction().add(...ixs);
    let signature;
    try {
      signature = await sendAndConfirmTransaction(conn, tx, [admin], {
        commitment: "confirmed",
      });
    } catch (cause) {
      const sent = cause?.signature;
      const status = sent
        ? (
            await conn.getSignatureStatus(sent, {
              searchTransactionHistory: true,
            })
          ).value
        : null;
      if (!status || status.err) throw cause;
      signature = sent;
    }
    report.steps.push({ label, signature });
    save();
    console.log(`ok  ${label}`);
  }
  const protocol = await P.account.protocolConfig.fetch(
    o.deriveProtocolConfigPda(),
  );
  assert.ok(
    protocol.superAdmin.equals(admin.publicKey),
    "CLI wallet must be super-admin",
  );

  // Deposit every Circle devnet USDC the wallet holds into its Outcomia balance.
  const ata = spl.getAssociatedTokenAddressSync(USDC, admin.publicKey);
  const held = (await spl.getAccount(conn, ata)).amount;
  const balancePda = sh.assetBalancePda(admin.publicKey, USDC);
  const custody = {
    vaultAuthority: sh.assetAuthorityPda(USDC),
    assetVault: sh.assetVaultPda(USDC),
    tokenProgram: o.TOKEN_PROGRAM_ID,
  };
  if (!(await conn.getAccountInfo(balancePda)))
    await send("initialize USDC balance", [
      await P.methods
        .initializeAssetBalance()
        .accountsStrict({
          owner: admin.publicKey,
          mint: USDC,
          assetBalance: balancePda,
          ...custody,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
    ]);
  if (held > 0n)
    await send(`deposit ${held} USDC atoms`, [
      await P.methods
        .depositAsset(new BN(held.toString()))
        .accountsStrict({
          owner: admin.publicKey,
          mint: USDC,
          assetBalance: balancePda,
          walletToken: ata,
          ...custody,
        })
        .instruction(),
    ]);

  const rulesFor = async (d) => {
    const bytes = fs.readFileSync(path.join(rulesDir, `${d.slug}.json`));
    const uri = `https://raw.githubusercontent.com/kunal171/outcomia/${ref}/docs/devnet/circle-markets/${d.slug}.json`;
    const remote = Buffer.from(await (await fetch(uri)).arrayBuffer());
    assert.ok(
      remote.equals(bytes),
      `${d.slug}: published rules differ from the local file`,
    );
    const ab = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.length,
    );
    return {
      uri,
      parsed: d.outcomes
        ? await pr.parseMultiOutcomeRules(
            ab,
            d.outcomes.map(([l]) => l),
          )
        : await pr.parsePredictionRules(ab),
    };
  };
  const manage = (market) => ({
    authority: admin.publicKey,
    market,
    adminRecord: o.deriveAdminRecordPda(admin.publicKey),
  });

  for (const d of binary) {
    const rec = (report.markets[d.slug] ??= {
      kind: "binary",
      name: d.name,
      id: crypto.randomBytes(32).toString("hex"),
    });
    const id = Buffer.from(rec.id, "hex");
    const market = pr.derivePredictionMarketPda(id);
    rec.address = market.toBase58();
    save();
    if (!done(`${d.slug}: create`)) {
      const { uri, parsed } = await rulesFor(d);
      await send(`${d.slug}: create`, [
        await P.methods
          .initializePredictionMarket(
            [...id],
            {
              resolver: parsed.resolver,
              fallback: null,
              closeTs: parsed.closeTs,
              earliestResolutionTs: parsed.earliestResolutionTs,
              resolutionDelaySeconds: parsed.resolutionDelaySeconds,
              payoutPerContract: new BN(UNIT),
              priceTick: new BN(TICK),
              rulesUri: uri,
              questionHash: parsed.questionHash,
              rulesHash: parsed.rulesHash,
            },
            d.name,
            "USDC",
          )
          .accountsPartial({
            authority: admin.publicKey,
            adminRecord: o.deriveAdminRecordPda(admin.publicKey),
            market,
            collateralMint: USDC,
            vaultAuthority: o.deriveVaultAuthorityPda(market),
            collateralVault: o.deriveVaultPda(market, USDC),
            marketMetadata: o.deriveMarketMetadataPda(market),
            marketFees: o.deriveMarketFeesPda(market),
            orderBook: pr.derivePredictionBookPda(market),
            tokenProgram: o.TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .instruction(),
      ]);
    }
    await send(`${d.slug}: open with shared book`, [
      await P.methods
        .openPredictionMarket()
        .accountsStrict(manage(market))
        .instruction(),
      await P.methods
        .initializeSharedBook({ prediction: {} })
        .accountsStrict({
          ...manage(market),
          book: sh.sharedBookPda(market),
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
      await P.methods
        .initializePredictionPosition()
        .accountsStrict({
          owner: admin.publicKey,
          market,
          position: pr.derivePredictionPositionPda(market, admin.publicKey),
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
    ]);
    for (const [outcome, p] of [
      ["yes", d.p - 0.02],
      ["no", 1 - d.p - 0.02],
    ]) {
      const label = `${d.slug}: bid ${outcome.toUpperCase()} ${p.toFixed(2)} x1`;
      if (done(label)) continue;
      const plan = await sh.buildSharedTrade(
        P,
        await sh.readSharedBook(P, market),
        admin.publicKey,
        outcome,
        "bid",
        new BN(price(p)),
        new BN(1),
        [],
        false,
      );
      assert.ok(plan.remaining.isZero(), `${label}: ${plan.stopReason}`);
      await send(label, plan.instructions);
    }
  }

  for (const d of multi) {
    const rec = (report.markets[d.slug] ??= { kind: "multi", name: d.name });
    let market = rec.address ? new PublicKey(rec.address) : null;
    if (!market) {
      const { uri, parsed } = await rulesFor(d);
      const plan = await creation.creationTransactions(
        P,
        admin.publicKey,
        crypto.randomBytes(32),
        USDC,
        {
          resolver: parsed.resolver,
          fallback: null,
          outcomeLabels: d.outcomes.map(([l]) => l),
          questionHash: parsed.questionHash,
          rulesHash: parsed.rulesHash,
          rulesUri: uri,
          closeTs: parsed.closeTs,
          earliestResolutionTs: parsed.earliestResolutionTs,
          resolutionDelaySeconds: parsed.resolutionDelaySeconds,
          payoutPerContract: new BN(UNIT),
          priceTick: new BN(TICK),
          quantityLot: new BN(1),
        },
        d.name,
        "USDC",
      );
      for (const [i, tx] of plan.uploads.entries())
        await send(`${d.slug}: stage terms ${i + 1}`, tx);
      await send(`${d.slug}: create`, plan.create);
      if (plan.cleanup)
        await send(`${d.slug}: close staged terms`, plan.cleanup);
      market = plan.market;
      rec.address = market.toBase58();
      save();
    }
    await send(`${d.slug}: open with book`, [
      await P.methods
        .openMultiOutcomeMarket()
        .accountsStrict(manage(market))
        .instruction(),
      await P.methods
        .initializeMultiOutcomeBook()
        .accountsStrict({
          ...manage(market),
          book: m.multiBookPda(market),
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
      await P.methods
        .initializeMultiOutcomePosition()
        .accountsStrict({
          owner: admin.publicKey,
          market,
          position: m.multiPositionPda(market, admin.publicKey),
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
    ]);
    for (const [i, [label]] of d.outcomes.entries()) {
      const p = Math.max(0.01, d.p[i] - 0.03);
      const step = `${d.slug}: bid ${label} ${p.toFixed(2)} x1`;
      if (done(step)) continue;
      const mk = await m.multiAccounts(P).multiOutcomeMarket.fetch(market);
      const b = await m.readMultiBook(P, market);
      const plan = await m.buildMultiTrade(
        P,
        market,
        mk,
        b.book,
        b.rows,
        admin.publicKey,
        i,
        "bid",
        new BN(price(p)),
        new BN(1),
        protocol.takerFeeBps,
        false,
        [],
        null,
      );
      assert.ok(plan.remaining.isZero(), `${step}: incomplete`);
      await send(step, plan.transaction);
    }
  }
  report.finishedAt = new Date().toISOString();
  save();
  console.log("done");
}

const mode = process.argv[2];
if (mode === "rules") {
  fs.mkdirSync(rulesDir, { recursive: true });
  for (const d of [...binary, ...multi])
    fs.writeFileSync(path.join(rulesDir, `${d.slug}.json`), rulesDocument(d));
  console.log(
    `wrote ${binary.length + multi.length} rules documents to ${rulesDir}`,
  );
} else if (mode === "seed") await seed();
else throw new Error("Usage: devnet-circle-markets.mjs rules|seed");
