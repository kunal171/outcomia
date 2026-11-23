/** Devnet demo markets for presentations: binary and multi-outcome markets on
 * current crypto, macro and sports questions, seeded with resting bids and one
 * small trade each so books, prices and charts are populated.
 *
 *   node scripts/devnet-demo-markets.mjs rules          # write rules JSON
 *   RULES_REF=<commit> node scripts/devnet-demo-markets.mjs seed
 *
 * Collateral is a valueless devnet test USDC (6 decimals) minted by the CLI
 * wallet (super-admin), which is also creator and resolver. Maker and taker
 * wallets are generated and funded from the CLI wallet; their keys stay under
 * ignored target/. Rules documents live in docs/devnet/demo-markets and are
 * referenced by commit, so the on-chain rules hash is publicly verifiable.
 * Re-running resumes from the recorded steps.
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
const rulesDir = path.join(root, "docs/devnet/demo-markets");
const reportFile = path.join(root, "docs/devnet/demo-markets-result.json");
const privateDir = path.join(
  root,
  "target/deploy-history/2026-11-23-demo-markets",
);
fs.mkdirSync(privateDir, { recursive: true });

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

const UNIT = 1_000_000; // test USDC has 6 decimals; one contract pays 1 USDC
const TICK = 10_000; // 0.01 USDC
const price = (p) => Math.round(p * 100) * TICK;

// ---------------------------------------------------------------------------
// Market slate. Prices reflect public reporting on 23 November 2026:
// BTC ~$61k (≈$74k on 12 Nov), ETH ~$1.82k, SOL ~$70; Fed funds 3.75–4.00%
// with markets pricing a December hike; Arsenal top of the Premier League on
// 28 pts (Brighton, Man City 22, Liverpool 21) hosting Man City on 28 Nov;
// Bills 9-1; 76ers, Spurs and Lakers 14-3; Abu Dhabi GP race 6 Dec 13:00 UTC.
// `p` is the fair YES / outcome probability used to place bids around.
// ---------------------------------------------------------------------------
const CRYPTO =
  "CoinGecko daily USD price page for the asset (coingecko.com), cross-checked with Coinbase and Kraken spot prices.";
const binary = [
  {
    slug: "btc-80k-before-christmas",
    name: "Bitcoin above $80k before Christmas?",
    question:
      "Will Bitcoin (BTC) trade at or above $80,000 at any time before 25 December 2026 00:00 UTC?",
    description:
      "BTC fell from about $74,000 on 12 November to about $61,000 on 23 November 2026.",
    source: CRYPTO,
    yes: "Resolve YES if any 1-minute BTC/USD trade on Coinbase or Kraken prints at or above $80,000.00 between market creation and 24 December 2026 23:59:59 UTC.",
    no: "Resolve NO if no qualifying trade prints at or above $80,000.00 before 25 December 2026 00:00 UTC.",
    close: "2026-12-24T23:59:00Z",
    resolve: "2026-12-25T00:30:00Z",
    p: 0.07,
  },
  {
    slug: "btc-end-2026-above-60k",
    name: "Bitcoin ends 2026 above $60k?",
    question:
      "Will Bitcoin's CoinGecko daily close for 31 December 2026 be above $60,000?",
    description:
      "BTC traded near $61,000 on 23 November 2026 after a sharp November drawdown.",
    source: CRYPTO,
    yes: "Resolve YES if CoinGecko's BTC/USD daily close for 31 December 2026 (UTC) is above $60,000.00.",
    no: "Resolve NO if that daily close is $60,000.00 or below.",
    close: "2026-12-31T22:00:00Z",
    resolve: "2027-01-01T01:00:00Z",
    p: 0.52,
  },
  {
    slug: "eth-2500-before-new-year",
    name: "Ethereum above $2,500 before 2027?",
    question:
      "Will Ethereum (ETH) trade at or above $2,500 at any time before 1 January 2027 00:00 UTC?",
    description: "ETH traded near $1,820 on 22 November 2026.",
    source: CRYPTO,
    yes: "Resolve YES if any 1-minute ETH/USD trade on Coinbase or Kraken prints at or above $2,500.00 before 1 January 2027 00:00 UTC.",
    no: "Resolve NO if no qualifying trade prints at or above $2,500.00 in that period.",
    close: "2026-12-31T22:00:00Z",
    resolve: "2027-01-01T00:30:00Z",
    p: 0.09,
  },
  {
    slug: "sol-below-50-before-new-year",
    name: "Solana below $50 before 2027?",
    question:
      "Will Solana (SOL) trade at or below $50 at any time before 1 January 2027 00:00 UTC?",
    description:
      "SOL traded near $70 on 22 November 2026, its lowest level since June.",
    source: CRYPTO,
    yes: "Resolve YES if any 1-minute SOL/USD trade on Coinbase or Kraken prints at or below $50.00 before 1 January 2027 00:00 UTC.",
    no: "Resolve NO if no qualifying trade prints at or below $50.00 in that period.",
    close: "2026-12-31T22:00:00Z",
    resolve: "2027-01-01T00:30:00Z",
    p: 0.14,
  },
  {
    slug: "fed-hike-december-2026",
    name: "Fed raises rates on 9 December?",
    question:
      "Will the Federal Reserve raise the federal funds target range at its 8–9 December 2026 FOMC meeting?",
    description:
      "The target range is 3.75–4.00%. Futures markets price a December hike as likely.",
    source:
      "Federal Reserve FOMC statement published at federalreserve.gov on 9 December 2026.",
    yes: "Resolve YES if the FOMC statement raises the upper bound of the target range above 4.00%.",
    no: "Resolve NO if the target range is held or lowered.",
    close: "2026-12-09T18:00:00Z",
    resolve: "2026-12-09T19:30:00Z",
    p: 0.84,
  },
  {
    slug: "arsenal-beat-man-city-28-nov",
    name: "Arsenal beat Man City on 28 November?",
    question:
      "Will Arsenal beat Manchester City in their Premier League match at the Emirates Stadium on 28 November 2026?",
    description:
      "Leaders Arsenal (28 pts) host third-placed Manchester City (22 pts).",
    source: "Official Premier League match result at premierleague.com.",
    yes: "Resolve YES if Arsenal win the match in regulation time (including stoppage time).",
    no: "Resolve NO if the match ends in a draw or a Manchester City win.",
    close: "2026-11-28T12:00:00Z",
    resolve: "2026-11-28T21:00:00Z",
    p: 0.46,
  },
  {
    slug: "arsenal-top-on-christmas",
    name: "Arsenal top of the Premier League at Christmas?",
    question:
      "Will Arsenal be first in the Premier League table on 25 December 2026 at 12:00 UTC?",
    description: "Arsenal lead by six points after 11 matches.",
    source: "Official Premier League table at premierleague.com.",
    yes: "Resolve YES if Arsenal are first in the official table at 25 December 2026 12:00 UTC.",
    no: "Resolve NO if any other club is first at that time.",
    close: "2026-12-24T23:59:00Z",
    resolve: "2026-12-25T12:30:00Z",
    p: 0.71,
  },
  {
    slug: "bills-best-record-2026",
    name: "Bills finish with the NFL's best record?",
    question:
      "Will the Buffalo Bills finish the 2026 NFL regular season with the league's best win-loss record (sole or tied)?",
    description: "Buffalo were 9-1 after Week 12 of the 2026 season.",
    source: "Final 2026 regular-season standings at nfl.com.",
    yes: "Resolve YES if no team finishes with a better winning percentage than Buffalo (ties count as YES).",
    no: "Resolve NO if any team finishes with a better winning percentage.",
    close: "2027-01-03T17:00:00Z",
    resolve: "2027-01-05T12:00:00Z",
    p: 0.34,
  },
  {
    slug: "verstappen-wins-abu-dhabi",
    name: "Verstappen wins the Abu Dhabi GP?",
    question:
      "Will Max Verstappen win the 2026 Abu Dhabi Grand Prix on 6 December 2026?",
    description:
      "The season finale at Yas Marina; Kimi Antonelli has already won the 2026 title.",
    source: "Official race classification at formula1.com.",
    yes: "Resolve YES if Max Verstappen is classified first in the official race result.",
    no: "Resolve NO if any other driver is classified first.",
    close: "2026-12-06T12:00:00Z",
    resolve: "2026-12-06T17:00:00Z",
    p: 0.24,
  },
];

const multi = [
  {
    slug: "btc-price-end-2026",
    name: "Bitcoin price on 31 December 2026",
    question:
      "Which range will Bitcoin's CoinGecko daily close for 31 December 2026 fall in?",
    description: "BTC traded near $61,000 on 23 November 2026.",
    source: CRYPTO,
    outcomes: [
      ["Below $50k", "Daily close below $50,000.00."],
      [
        "$50k-$60k",
        "Daily close from $50,000.00 up to and including $60,000.00.",
      ],
      [
        "$60k-$70k",
        "Daily close above $60,000.00 up to and including $70,000.00.",
      ],
      [
        "$70k-$80k",
        "Daily close above $70,000.00 up to and including $80,000.00.",
      ],
      ["Above $80k", "Daily close above $80,000.00."],
    ],
    close: "2026-12-31T22:00:00Z",
    resolve: "2027-01-01T01:00:00Z",
    p: [0.1, 0.32, 0.36, 0.15, 0.07],
  },
  {
    slug: "fed-decision-december-2026",
    name: "Fed decision on 9 December 2026",
    question:
      "What will the Federal Reserve decide for the federal funds target range on 9 December 2026?",
    description: "The current target range is 3.75–4.00%.",
    source:
      "Federal Reserve FOMC statement at federalreserve.gov on 9 December 2026.",
    outcomes: [
      [
        "Hike 25 bp",
        "The upper bound rises by exactly 0.25 percentage points.",
      ],
      [
        "Hike 50 bp+",
        "The upper bound rises by 0.50 percentage points or more.",
      ],
      ["Hold", "The target range is unchanged."],
      ["Cut", "The upper bound is lowered by any amount."],
    ],
    close: "2026-12-09T18:00:00Z",
    resolve: "2026-12-09T19:30:00Z",
    p: [0.72, 0.12, 0.14, 0.02],
  },
  {
    slug: "premier-league-leader-christmas",
    name: "Premier League leader at Christmas",
    question:
      "Which club will be first in the Premier League table on 25 December 2026 at 12:00 UTC?",
    description:
      "Arsenal 28 pts; Brighton and Manchester City 22; Liverpool 21 after 11 matches.",
    source: "Official Premier League table at premierleague.com.",
    outcomes: [
      ["Arsenal", "Arsenal are first."],
      ["Manchester City", "Manchester City are first."],
      ["Brighton", "Brighton & Hove Albion are first."],
      ["Liverpool", "Liverpool are first."],
      ["Any other club", "Any other club is first."],
    ],
    close: "2026-12-24T23:59:00Z",
    resolve: "2026-12-25T12:30:00Z",
    p: [0.71, 0.15, 0.05, 0.06, 0.03],
  },
  {
    slug: "arsenal-man-city-result",
    name: "Arsenal vs Man City result, 28 November",
    question:
      "What will be the result of Arsenal vs Manchester City in the Premier League on 28 November 2026?",
    description:
      "Leaders Arsenal host Manchester City at the Emirates Stadium.",
    source: "Official Premier League match result at premierleague.com.",
    outcomes: [
      ["Arsenal win", "Arsenal win in regulation time."],
      ["Draw", "The match ends level."],
      ["Man City win", "Manchester City win in regulation time."],
    ],
    close: "2026-11-28T12:00:00Z",
    resolve: "2026-11-28T21:00:00Z",
    p: [0.46, 0.27, 0.27],
  },
  {
    slug: "nba-best-record-new-year",
    name: "NBA best record on 31 December",
    question:
      "Which team will have the NBA's best win percentage after all games on 31 December 2026 (US Eastern)?",
    description:
      "The 76ers, Spurs and Lakers were each 14-3 in late November 2026.",
    source: "NBA league standings at nba.com on 1 January 2027.",
    outcomes: [
      ["76ers", "Philadelphia 76ers have the best percentage."],
      ["Spurs", "San Antonio Spurs have the best percentage."],
      ["Lakers", "Los Angeles Lakers have the best percentage."],
      ["Any other team", "Another team has the best percentage."],
    ],
    close: "2026-12-31T23:00:00Z",
    resolve: "2027-01-01T12:00:00Z",
    p: [0.26, 0.27, 0.22, 0.25],
  },
  // Second multi-outcome slate (added 23 November 2026).
  {
    slug: "sol-price-end-2026",
    name: "Solana price on 31 December 2026",
    question:
      "Which range will Solana's CoinGecko daily close for 31 December 2026 fall in?",
    description: "SOL traded near $70 on 23 November 2026.",
    source: CRYPTO,
    outcomes: [
      ["Below $50", "Daily close below $50.00."],
      ["$50-$70", "Daily close from $50.00 up to and including $70.00."],
      ["$70-$90", "Daily close above $70.00 up to and including $90.00."],
      ["Above $90", "Daily close above $90.00."],
    ],
    close: "2026-12-31T22:00:00Z",
    resolve: "2027-01-01T01:00:00Z",
    p: [0.15, 0.4, 0.33, 0.12],
  },
  {
    slug: "best-crypto-december-2026",
    name: "Best December return: BTC, ETH or SOL?",
    question:
      "Which of Bitcoin, Ethereum and Solana will have the highest percentage change from its 30 November 2026 to its 31 December 2026 CoinGecko daily close?",
    description:
      "BTC near $61,000, ETH near $1,820 and SOL near $70 on 23 November 2026.",
    source: CRYPTO,
    outcomes: [
      ["Bitcoin", "BTC has the highest percentage change."],
      ["Ethereum", "ETH has the highest percentage change."],
      ["Solana", "SOL has the highest percentage change."],
    ],
    close: "2026-12-31T22:00:00Z",
    resolve: "2027-01-01T01:00:00Z",
    p: [0.36, 0.31, 0.33],
  },
  {
    slug: "bills-regular-season-wins",
    name: "Bills regular-season wins",
    question:
      "How many regular-season games will the Buffalo Bills win in the 2026 NFL season?",
    description:
      "The Bills were 9-1 in late November 2026 with seven games left.",
    source:
      "Official NFL standings at nfl.com after the final regular-season week.",
    outcomes: [
      ["12 or fewer", "The Bills finish with 12 or fewer wins."],
      ["13 wins", "The Bills finish with exactly 13 wins."],
      ["14 wins", "The Bills finish with exactly 14 wins."],
      ["15 or more", "The Bills finish with 15 or more wins."],
    ],
    close: "2027-01-09T17:00:00Z",
    resolve: "2027-01-11T12:00:00Z",
    p: [0.2, 0.25, 0.27, 0.28],
  },
  {
    slug: "liverpool-place-christmas",
    name: "Liverpool's place at Christmas",
    question:
      "Where will Liverpool be in the Premier League table on 25 December 2026 at 12:00 UTC?",
    description:
      "Liverpool had 21 points after 11 matches, seven behind leaders Arsenal.",
    source: "Official Premier League table at premierleague.com.",
    outcomes: [
      ["1st-2nd", "Liverpool are first or second."],
      ["3rd-4th", "Liverpool are third or fourth."],
      ["5th-8th", "Liverpool are fifth to eighth."],
      ["9th or lower", "Liverpool are ninth or lower."],
    ],
    close: "2026-12-24T23:59:00Z",
    resolve: "2026-12-25T12:30:00Z",
    p: [0.12, 0.38, 0.38, 0.12],
  },
  {
    slug: "arsenal-city-total-goals",
    name: "Arsenal vs Man City total goals",
    question:
      "How many goals will be scored in Arsenal vs Manchester City in the Premier League on 28 November 2026?",
    description: "Total goals in regulation time, including stoppage time.",
    source: "Official Premier League match result at premierleague.com.",
    outcomes: [
      ["0-1 goals", "Zero or one goal is scored."],
      ["2 goals", "Exactly two goals are scored."],
      ["3 goals", "Exactly three goals are scored."],
      ["4+ goals", "Four or more goals are scored."],
    ],
    close: "2026-11-28T12:00:00Z",
    resolve: "2026-11-28T21:00:00Z",
    p: [0.25, 0.28, 0.24, 0.23],
  },
];
// Ties at the top of an outcome-based market resolve to the outcome listed first.
const TIE_RULE =
  "If teams or clubs are level, use the official tiebreakers of the named source; if still level, resolve to the first tied outcome in market order.";

for (const d of [...binary, ...multi]) {
  assert.ok(/^[\x20-\x7e]{1,64}$/.test(d.name), `name: ${d.name}`);
  assert.ok(visibility.visibleMarket("x", d.name), `hidden name: ${d.name}`);
}
for (const d of multi) {
  const sum = d.p.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 0.011, `${d.slug} probabilities sum ${sum}`);
}

// ---------------------------------------------------------------------------
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

function rulesDocument(d, outcomes) {
  const draft = {
    ...draftLib.initialPredictionRulesDraft(),
    question: d.question,
    description: d.description,
    resolutionSource: d.source,
    closeTime: d.close,
    earliestResolutionTime: d.resolve,
    resolutionDelaySeconds: "3600",
  };
  if (!outcomes) {
    draft.yesCriteria = d.yes;
    draft.noCriteria = d.no;
  } else {
    draft.conflictingEvidencePolicy = `${draft.conflictingEvidencePolicy} ${TIE_RULE}`;
  }
  return draftLib.serializePredictionRulesDraft(
    draft,
    admin.publicKey.toBase58(),
    outcomes,
  );
}

function writeRules() {
  fs.mkdirSync(rulesDir, { recursive: true });
  for (const d of binary)
    fs.writeFileSync(path.join(rulesDir, `${d.slug}.json`), rulesDocument(d));
  for (const d of multi)
    fs.writeFileSync(
      path.join(rulesDir, `${d.slug}.json`),
      rulesDocument(
        d,
        d.outcomes.map(([label, criteria]) => ({ label, criteria })),
      ),
    );
  console.log(
    `wrote ${binary.length + multi.length} rules documents to ${rulesDir}`,
  );
}

// ---------------------------------------------------------------------------
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
  const programFor = (kp) =>
    new Program(
      idl,
      new AnchorProvider(conn, new Wallet(kp), { commitment: "confirmed" }),
    );
  const P = programFor(admin);

  const report = fs.existsSync(reportFile)
    ? JSON.parse(fs.readFileSync(reportFile, "utf8"))
    : {
        program: idl.address,
        startedAt: new Date().toISOString(),
        rulesRef: ref,
        markets: {},
        steps: [],
      };
  report.rulesRef = ref;
  const save = () =>
    fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  const done = (label) => report.steps.some((s) => s.label === label);
  async function send(label, ixs, signers) {
    if (done(label)) return console.log(`skip ${label}`);
    const tx = ixs instanceof Transaction ? ixs : new Transaction().add(...ixs);
    let signature;
    try {
      signature = await sendAndConfirmTransaction(conn, tx, signers, {
        commitment: "confirmed",
      });
    } catch (cause) {
      // A transaction can land after the client's blockhash expires. Never
      // resend a step that already succeeded on chain.
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
  const feeBps = protocol.takerFeeBps;

  // Wallets: four makers rest bids, one taker trades once per market.
  const walletFile = path.join(privateDir, "wallets.json");
  const secrets = fs.existsSync(walletFile)
    ? JSON.parse(fs.readFileSync(walletFile, "utf8"))
    : Array.from({ length: 5 }, () => [...Keypair.generate().secretKey]);
  fs.writeFileSync(walletFile, JSON.stringify(secrets));
  const [m1, m2, m3, m4, taker] = secrets.map((s) =>
    Keypair.fromSecretKey(Uint8Array.from(s)),
  );
  const makers = [m1, m2, m3, m4];
  report.wallets = {
    makers: makers.map((k) => k.publicKey.toBase58()),
    taker: taker.publicKey.toBase58(),
  };
  save();

  const usd = report.collateralMint
    ? new PublicKey(report.collateralMint)
    : await spl.createMint(conn, admin, admin.publicKey, null, 6);
  report.collateralMint = usd.toBase58();
  save();

  for (const [i, kp] of [...makers, taker].entries()) {
    const name = i < 4 ? `maker ${i + 1}` : "taker";
    await send(
      `fund ${name} SOL`,
      [
        SystemProgram.transfer({
          fromPubkey: admin.publicKey,
          toPubkey: kp.publicKey,
          lamports: 600_000_000,
        }),
      ],
      [admin],
    );
    const amount = i < 4 ? 40_000 * UNIT : 5_000 * UNIT;
    const ata = (
      await spl.getOrCreateAssociatedTokenAccount(
        conn,
        admin,
        usd,
        kp.publicKey,
      )
    ).address;
    if (!done(`deposit ${name} USDC`))
      await spl.mintTo(conn, admin, usd, ata, admin, amount);
    await send(
      `deposit ${name} USDC`,
      [
        await P.methods
          .initializeAssetBalance()
          .accountsStrict({
            owner: kp.publicKey,
            mint: usd,
            assetBalance: sh.assetBalancePda(kp.publicKey, usd),
            vaultAuthority: sh.assetAuthorityPda(usd),
            assetVault: sh.assetVaultPda(usd),
            tokenProgram: o.TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .instruction(),
        await P.methods
          .depositAsset(new BN(amount))
          .accountsStrict({
            owner: kp.publicKey,
            mint: usd,
            assetBalance: sh.assetBalancePda(kp.publicKey, usd),
            walletToken: ata,
            vaultAuthority: sh.assetAuthorityPda(usd),
            assetVault: sh.assetVaultPda(usd),
            tokenProgram: o.TOKEN_PROGRAM_ID,
          })
          .instruction(),
      ],
      [kp],
    );
  }

  const rulesFor = async (d) => {
    const bytes = fs.readFileSync(path.join(rulesDir, `${d.slug}.json`));
    const uri = `https://raw.githubusercontent.com/kunal171/outcomia/${ref}/docs/devnet/demo-markets/${d.slug}.json`;
    const remote = Buffer.from(await (await fetch(uri)).arrayBuffer());
    assert.ok(
      remote.equals(bytes),
      `${d.slug}: published rules differ from the local file`,
    );
    const parsed = d.outcomes
      ? await pr.parseMultiOutcomeRules(
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
          d.outcomes.map(([l]) => l),
        )
      : await pr.parsePredictionRules(
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
        );
    return { uri, parsed };
  };
  const manage = (market) => ({
    authority: admin.publicKey,
    market,
    adminRecord: o.deriveAdminRecordPda(admin.publicKey),
  });

  // ---- Binary markets ------------------------------------------------------
  for (const d of binary) {
    const rec = (report.markets[d.slug] ??= {
      kind: "binary",
      name: d.name,
      id: crypto.randomBytes(32).toString("hex"),
    });
    save();
    const id = Buffer.from(rec.id, "hex");
    const market = pr.derivePredictionMarketPda(id);
    rec.address = market.toBase58();
    save();
    if (!done(`${d.slug}: create`)) {
      const { uri, parsed } = await rulesFor(d);
      await send(
        `${d.slug}: create`,
        [
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
              collateralMint: usd,
              vaultAuthority: o.deriveVaultAuthorityPda(market),
              collateralVault: o.deriveVaultPda(market, usd),
              marketMetadata: o.deriveMarketMetadataPda(market),
              marketFees: o.deriveMarketFeesPda(market),
              orderBook: pr.derivePredictionBookPda(market),
              tokenProgram: o.TOKEN_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            })
            .instruction(),
        ],
        [admin],
      );
    }
    await send(
      `${d.slug}: open with shared book`,
      [
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
      ],
      [admin],
    );
    for (const [i, kp] of [...makers, taker].entries())
      await send(
        `${d.slug}: position ${i}`,
        [
          await P.methods
            .initializePredictionPosition()
            .accountsStrict({
              owner: kp.publicKey,
              market,
              position: pr.derivePredictionPositionPda(market, kp.publicKey),
              systemProgram: SystemProgram.programId,
            })
            .instruction(),
        ],
        [kp],
      );
    const trade = async (label, kp, outcome, side, px, qty, complement) => {
      if (done(label)) return console.log(`skip ${label}`);
      const snap = await sh.readSharedBook(P, market);
      const plan = await sh.buildSharedTrade(
        programFor(kp),
        snap,
        kp.publicKey,
        outcome,
        side,
        new BN(px),
        new BN(qty),
        [],
        complement,
      );
      assert.ok(plan.remaining.isZero(), `${label}: ${plan.stopReason}`);
      await send(label, plan.instructions, [kp]);
    };
    // Ladder: YES bids from makers 1–2 and NO bids from makers 3–4, below fair value.
    const yes = d.p,
      no = 1 - d.p;
    const ladder = [
      [m1, "yes", yes - 0.02, 120],
      [m2, "yes", yes - 0.04, 260],
      [m1, "yes", yes - 0.07, 400],
      [m3, "no", no - 0.02, 140],
      [m4, "no", no - 0.04, 240],
      [m3, "no", no - 0.07, 380],
    ];
    for (const [kp, outcome, p, qty] of ladder) {
      if (p < 0.01) continue;
      await trade(
        `${d.slug}: bid ${outcome.toUpperCase()} ${p.toFixed(2)} x${qty}`,
        kp,
        outcome,
        "bid",
        price(p),
        qty,
        false,
      );
    }
    // One taker buy of YES through the best NO bid (complement mint) sets a last price.
    const fill = Math.min(0.99, yes + 0.02);
    await trade(
      `${d.slug}: taker buys YES ${fill.toFixed(2)} x25`,
      taker,
      "yes",
      "bid",
      price(fill),
      25,
      true,
    );
  }

  // ---- Multi-outcome markets ------------------------------------------------
  for (const d of multi) {
    const rec = (report.markets[d.slug] ??= { kind: "multi", name: d.name });
    let market = rec.address ? new PublicKey(rec.address) : null;
    const n = d.outcomes.length;
    const lot = UNIT % n === 0 ? 1 : n;
    if (!market) {
      const { uri, parsed } = await rulesFor(d);
      const plan = await creation.creationTransactions(
        P,
        admin.publicKey,
        crypto.randomBytes(32),
        usd,
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
          quantityLot: new BN(lot),
        },
        d.name,
        // The first five multi-outcome markets were created as "USDC" and are
        // relabelled in the app (lib/collateral-display.ts).
        "outcomia-tUSDC",
      );
      for (const [i, tx] of plan.uploads.entries())
        await send(`${d.slug}: stage terms ${i + 1}`, tx, [admin]);
      await send(`${d.slug}: create`, plan.create, [admin]);
      if (plan.cleanup)
        await send(`${d.slug}: close staged terms`, plan.cleanup, [admin]);
      market = plan.market;
      rec.address = market.toBase58();
      rec.rulesRef = ref;
      save();
    }
    await send(
      `${d.slug}: open with book`,
      [
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
      ],
      [admin],
    );
    for (const [i, kp] of [...makers, taker].entries())
      await send(
        `${d.slug}: position ${i}`,
        [
          await P.methods
            .initializeMultiOutcomePosition()
            .accountsStrict({
              owner: kp.publicKey,
              market,
              position: m.multiPositionPda(market, kp.publicKey),
              systemProgram: SystemProgram.programId,
            })
            .instruction(),
        ],
        [kp],
      );
    const trade = async (label, kp, outcome, side, px, qty, complement) => {
      if (done(label)) return console.log(`skip ${label}`);
      const mk = await m.multiAccounts(P).multiOutcomeMarket.fetch(market);
      const b = await m.readMultiBook(P, market);
      const plan = await m.buildMultiTrade(
        programFor(kp),
        market,
        mk,
        b.book,
        b.rows,
        kp.publicKey,
        outcome,
        side,
        new BN(px),
        new BN(qty),
        feeBps,
        complement,
        [],
        null,
      );
      assert.ok(plan.remaining.isZero(), `${label}: incomplete`);
      await send(label, plan.transaction, [kp]);
    };
    // Two bids per outcome from alternating makers; quantities follow the lot.
    const q = (base) => Math.ceil(base / lot) * lot;
    for (const [i, [label]] of d.outcomes.entries()) {
      const p = d.p[i];
      // Every outcome gets a best bid (at least 0.01) so full sets can always mint.
      const best = Math.max(0.01, p - 0.02);
      await trade(
        `${d.slug}: bid ${label} ${best.toFixed(2)}`,
        makers[i % 4],
        i,
        "bid",
        price(best),
        q(150),
        false,
      );
      if (p - 0.05 >= 0.01)
        await trade(
          `${d.slug}: bid ${label} ${(p - 0.05).toFixed(2)}`,
          makers[(i + 1) % 4],
          i,
          "bid",
          price(p - 0.05),
          q(300),
          false,
        );
    }
    // The taker buys the favourite through the other outcomes' best bids (full-set mint).
    const fav = d.p.indexOf(Math.max(...d.p));
    const others = d.p.reduce(
      (s, p, i) => (i === fav ? s : s + Math.max(0.01, p - 0.02)),
      0,
    );
    const fill = Math.min(0.99, Math.max(d.p[fav] + 0.02, 1 - others + 0.01));
    await trade(
      `${d.slug}: taker buys ${d.outcomes[fav][0]} ${fill.toFixed(2)}`,
      taker,
      fav,
      "bid",
      price(fill),
      q(15),
      true,
    );
  }
  report.finishedAt = new Date().toISOString();
  save();
  console.log("done");
}

const mode = process.argv[2];
if (mode === "rules") writeRules();
else if (mode === "seed") await seed();
else throw new Error("Usage: devnet-demo-markets.mjs rules|seed");
