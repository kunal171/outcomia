/** Devnet showcase and live check of Creator Clubs CC1 (public and open clubs).
 *
 *   node scripts/devnet-public-clubs.mjs rules
 *   RULES_REF=<commit> node scripts/devnet-public-clubs.mjs seed
 *
 * The CLI wallet (~/.config/solana/id.json, the protocol super-admin) owns
 * three clubs:
 *   - "Crypto Forecasters": Public (request and approve), verified, with a
 *     members-only market on its topic;
 *   - "Matchday Predictors": Open (join directly), verified;
 *   - "Outcomia Founders": private (invite-only, no listing).
 * Members are the four demo-market makers, which already hold
 * outcomia-tUSDC shared balances. Steps are recorded in
 * docs/devnet/public-clubs-result.json and skipped on a rerun, so an
 * interrupted run resumes without repeating anything. Expired-request
 * cleanup needs the 7-day TTL to pass, so it is covered by the LiteSVM
 * tests rather than here. */
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
  Transaction,
  sendAndConfirmTransaction,
} = require("@solana/web3.js");

const root = fileURLToPath(new URL("../../", import.meta.url));
const rulesDir = path.join(root, "docs/devnet/public-clubs");
const reportFile = path.join(root, "docs/devnet/public-clubs-result.json");
const makersFile = path.join(
  root,
  "target/deploy-history/2026-11-23-demo-markets/wallets.json",
);

const c = loadTypeScript(new URL("../lib/clubs.ts", import.meta.url));
const sh = loadTypeScript(new URL("../lib/shared.ts", import.meta.url));
const pr = loadTypeScript(new URL("../lib/prediction.ts", import.meta.url));
const draftLib = loadTypeScript(
  new URL("../lib/prediction-rules-draft.ts", import.meta.url),
);

/** outcomia-tUSDC, the app's test collateral (6 decimals). */
const TEST_USDC = new PublicKey("FUU2RPtv519UtUD2apwBRUM8BT2x2Kew71AxRRLMCAbd");
const UNIT = 1_000_000;
const TICK = 10_000;
const price = (p) => Math.round(p * 100) * TICK;

const CLUBS = {
  crypto: {
    name: "Crypto Forecasters",
    listing: {
      open: false,
      topic: "Crypto",
      description:
        "Members forecast crypto prices and on-chain milestones. Request to join with a note; admins review every request.",
    },
  },
  sports: {
    name: "Matchday Predictors",
    listing: {
      open: true,
      topic: "Sports",
      description:
        "Football, F1 and NFL calls for fans. Anyone can join and trade the club's markets.",
    },
  },
  founders: { name: "Outcomia Founders", listing: null },
};

const MARKET = {
  slug: "crypto-forecasters-sol-above-80-end-2026",
  name: "Solana at or above $80 at the end of 2026?",
  question:
    "Will the SOL/USD price be at or above $80.00 at 31 December 2026 23:59 UTC?",
  description:
    "Members-only market of the Crypto Forecasters club. SOL traded near $70 on 22 November 2026.",
  source:
    "CoinGecko daily USD price page for the asset (coingecko.com), cross-checked with Coinbase and Kraken spot prices.",
  yes: "Resolve YES if the last SOL/USD trade on Coinbase at or before 31 December 2026 23:59 UTC is at or above $80.00 (Kraken if Coinbase is unavailable).",
  no: "Resolve NO if that price is below $80.00.",
  close: "2026-12-31T22:00:00Z",
  resolve: "2027-01-01T00:30:00Z",
  p: 0.3,
};

for (const { name } of Object.values(CLUBS))
  assert.equal(c.clubNameIssue(name), null, name);
for (const { listing } of Object.values(CLUBS))
  if (listing)
    assert.equal(c.clubListingIssue(listing.topic, listing.description), null);

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

function rulesDocument() {
  return draftLib.serializePredictionRulesDraft(
    {
      ...draftLib.initialPredictionRulesDraft(),
      question: MARKET.question,
      description: MARKET.description,
      resolutionSource: MARKET.source,
      closeTime: MARKET.close,
      earliestResolutionTime: MARKET.resolve,
      resolutionDelaySeconds: "3600",
      yesCriteria: MARKET.yes,
      noCriteria: MARKET.no,
    },
    admin.publicKey.toBase58(),
  );
}

function writeRules() {
  fs.mkdirSync(rulesDir, { recursive: true });
  fs.writeFileSync(path.join(rulesDir, `${MARKET.slug}.json`), rulesDocument());
  console.log(`wrote ${MARKET.slug}.json to ${rulesDir}`);
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
        owner: admin.publicKey.toBase58(),
        clubs: {},
        steps: [],
        checks: [],
      };
  report.rulesRef = ref;
  const save = () =>
    fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  const done = (label) => report.steps.some((s) => s.label === label);
  async function send(label, ixs, signers) {
    if (done(label)) return console.log(`skip ${label}`);
    const tx = new Transaction().add(...ixs);
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
  const check = (text) => {
    if (!report.checks.includes(text)) report.checks.push(text);
    save();
    console.log(`chk ${text}`);
  };

  const protocol = await P.account.protocolConfig.fetch(
    PublicKey.findProgramAddressSync(
      [Buffer.from("protocol_config")],
      new PublicKey(idl.address),
    )[0],
  );
  assert.ok(
    protocol.superAdmin.equals(admin.publicKey),
    "CLI wallet must be super-admin",
  );

  const [m1, m2, m3, m4] = JSON.parse(fs.readFileSync(makersFile, "utf8"))
    .slice(0, 4)
    .map((s) => Keypair.fromSecretKey(Uint8Array.from(s)));
  report.members = Object.fromEntries(
    [m1, m2, m3, m4].map((k, i) => [`m${i + 1}`, k.publicKey.toBase58()]),
  );
  save();

  // ---- Clubs and listings --------------------------------------------------
  const address = {};
  for (const [key, spec] of Object.entries(CLUBS)) {
    const rec = (report.clubs[key] ??= {
      name: spec.name,
      id: crypto.randomBytes(32).toString("hex"),
    });
    const created = await c.createClubInstruction(
      P,
      admin.publicKey,
      spec.name,
      Uint8Array.from(Buffer.from(rec.id, "hex")),
    );
    rec.address = created.club.toBase58();
    address[key] = created.club;
    save();
    await send(`${key}: create club`, [created.instruction], [admin]);
    if (spec.listing) {
      rec.visibility = spec.listing.open ? "open" : "public";
      rec.topic = spec.listing.topic;
      save();
      await send(
        `${key}: list as ${rec.visibility}`,
        [
          await c.setClubListingInstruction(
            P,
            admin.publicKey,
            created.club,
            spec.listing.open,
            spec.listing.topic,
            spec.listing.description,
          ),
        ],
        [admin],
      );
      await send(
        `${key}: verify listing`,
        [
          await c.verifyClubListingInstruction(
            P,
            admin.publicKey,
            created.club,
            true,
          ),
        ],
        [admin],
      );
    }
  }

  // ---- Public club: request and approve ------------------------------------
  const crypto_ = address.crypto;
  const notes = {
    m1: "Trading BTC and SOL since 2021.",
    m2: "Macro and ETF flows are my focus.",
    m3: "Keen to learn from the group.",
    m4: "Checking how requests work.",
  };
  for (const [name, kp] of Object.entries({ m1, m2, m3, m4 }))
    await send(
      `crypto: ${name} requests to join`,
      [
        await c.requestClubMembershipInstruction(
          programFor(kp),
          kp.publicKey,
          crypto_,
          notes[name],
        ),
      ],
      [kp],
    );
  for (const [name, kp] of Object.entries({ m1, m2 }))
    await send(
      `crypto: owner approves ${name}`,
      [
        await c.approveClubRequestInstruction(
          P,
          admin.publicKey,
          crypto_,
          kp.publicKey,
        ),
      ],
      [admin],
    );
  await send(
    "crypto: m4 cancels its own request",
    [
      await c.closeClubRequestInstruction(
        programFor(m4),
        m4.publicKey,
        crypto_,
        m4.publicKey,
        false,
      ),
    ],
    [m4],
  );

  // ---- Open club: join directly --------------------------------------------
  for (const [name, kp] of Object.entries({ m3, m4 }))
    await send(
      `sports: ${name} joins directly`,
      [
        await c.joinOpenClubInstruction(
          programFor(kp),
          kp.publicKey,
          address.sports,
        ),
      ],
      [kp],
    );

  // ---- Private club: invite and accept -------------------------------------
  for (const [name, kp] of Object.entries({ m1, m2 })) {
    await send(
      `founders: owner invites ${name}`,
      [
        await c.inviteClubMemberInstruction(
          P,
          admin.publicKey,
          address.founders,
          kp.publicKey,
        ),
      ],
      [admin],
    );
    if (done(`founders: ${name} accepts`)) continue;
    const invite = (await c.readWalletClubs(P, kp.publicKey)).invites.find(
      (i) => i.invite.club.equals(address.founders),
    );
    assert.ok(invite, `${name} has no founders invite`);
    await send(
      `founders: ${name} accepts`,
      [
        await c.acceptClubInviteInstruction(
          programFor(kp),
          kp.publicKey,
          invite.invite,
        ),
      ],
      [kp],
    );
  }

  // ---- Members-only market on the public club's topic ----------------------
  const rec = (report.market ??= {
    slug: MARKET.slug,
    name: MARKET.name,
    club: "crypto",
    id: crypto.randomBytes(32).toString("hex"),
  });
  const bytes = fs.readFileSync(path.join(rulesDir, `${MARKET.slug}.json`));
  const uri = `https://raw.githubusercontent.com/kunal171/outcomia/${ref}/docs/devnet/public-clubs/${MARKET.slug}.json`;
  const remote = Buffer.from(await (await fetch(uri)).arrayBuffer());
  assert.ok(remote.equals(bytes), "published rules differ from the local file");
  const parsed = await pr.parsePredictionRules(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
  );
  const made = await c.createClubMarketInstructions(
    P,
    admin.publicKey,
    crypto_,
    TEST_USDC,
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
    MARKET.name,
    "outcomia-tUSDC",
    false,
    Uint8Array.from(Buffer.from(rec.id, "hex")),
  );
  const market = made.market;
  rec.address = market.toBase58();
  save();
  await send(
    "crypto: create, open and book the members-only market",
    made.instructions,
    [admin],
  );
  const positionOf = (kp) =>
    PublicKey.findProgramAddressSync(
      [
        Buffer.from("prediction_position"),
        market.toBuffer(),
        kp.publicKey.toBuffer(),
      ],
      new PublicKey(idl.address),
    )[0];
  for (const [name, kp] of Object.entries({ m1, m2 }))
    await send(
      `crypto market: ${name} position`,
      [
        await c.initializeClubPositionInstruction(
          programFor(kp),
          kp.publicKey,
          market,
          positionOf(kp),
        ),
      ],
      [kp],
    );
  const context = async () => {
    const snap = await c.readClub(P, crypto_);
    const row = snap.markets.find((r) => r.binding.market.equals(market));
    assert.ok(row, "club market binding not found");
    return c.clubTrading(snap, row.binding);
  };
  const trade = async (label, kp, outcome, p, qty, complement) => {
    if (done(label)) return console.log(`skip ${label}`);
    const ctx = await context();
    const book = await sh.readSharedBook(P, market, ctx);
    const plan = await sh.buildSharedTrade(
      programFor(kp),
      book,
      kp.publicKey,
      outcome,
      "bid",
      new BN(price(p)),
      new BN(qty),
      [],
      complement,
      ctx,
    );
    assert.ok(plan.remaining.isZero(), `${label}: ${plan.stopReason}`);
    await send(label, plan.instructions, [kp]);
  };
  const yes = MARKET.p,
    no = 1 - MARKET.p;
  await trade(
    "crypto market: m1 bids YES 0.28 x150",
    m1,
    "yes",
    yes - 0.02,
    150,
    false,
  );
  await trade(
    "crypto market: m1 bids YES 0.25 x300",
    m1,
    "yes",
    yes - 0.05,
    300,
    false,
  );
  await trade(
    "crypto market: m2 bids NO 0.68 x200",
    m2,
    "no",
    no - 0.02,
    200,
    false,
  );
  await trade(
    "crypto market: m2 bids NO 0.65 x350",
    m2,
    "no",
    no - 0.05,
    350,
    false,
  );
  await trade(
    "crypto market: m2 buys YES 0.32 x40 against the NO bid",
    m2,
    "yes",
    yes + 0.02,
    40,
    true,
  );

  // ---- Checks against what the app reads ----------------------------------
  const listings = await c.readClubListings(P);
  for (const key of ["crypto", "sports"])
    assert.ok(
      listings.some((l) => l.address.equals(address[key])),
      `${key} missing from discovery`,
    );
  assert.ok(
    !listings.some((l) => l.address.equals(address.founders)),
    "private club must not be listed",
  );
  check(
    "discovery lists Crypto Forecasters and Matchday Predictors, not Outcomia Founders",
  );
  const snap = {};
  for (const key of Object.keys(CLUBS))
    snap[key] = await c.readClub(P, address[key]);
  const wallets = (s) => s.members.map((m) => m.wallet.toBase58()).sort();
  const expect = (...kps) =>
    [admin, ...kps].map((k) => k.publicKey.toBase58()).sort();
  assert.deepEqual(wallets(snap.crypto), expect(m1, m2));
  assert.deepEqual(
    snap.crypto.requests.map((r) => r.wallet.toBase58()),
    [m3.publicKey.toBase58()],
  );
  check(
    "Crypto Forecasters: owner, m1 and m2 approved; m3 still pending; m4's cancelled request is gone",
  );
  assert.deepEqual(wallets(snap.sports), expect(m3, m4));
  check("Matchday Predictors: m3 and m4 joined directly");
  assert.deepEqual(wallets(snap.founders), expect(m1, m2));
  assert.equal(snap.founders.listing, null);
  check("Outcomia Founders: invite-only, m1 and m2 accepted, no listing");
  // An outsider (m3 is not a member) is refused by the client planner.
  {
    const ctx = await context();
    const book = await sh.readSharedBook(P, market, ctx);
    let refused = false;
    try {
      await sh.buildSharedTrade(
        programFor(m3),
        book,
        m3.publicKey,
        "yes",
        "bid",
        new BN(price(0.2)),
        new BN(1),
        [],
        false,
        ctx,
      );
    } catch (e) {
      refused = /club members/i.test(e.message);
    }
    assert.ok(refused, "a non-member must not be able to trade");
  }
  check("members-only market refuses a non-member (m3)");
  report.finishedAt = new Date().toISOString();
  save();
  console.log("done");
}

const mode = process.argv[2];
if (mode === "rules") writeRules();
else if (mode === "seed") await seed();
else {
  console.error("usage: node scripts/devnet-public-clubs.mjs rules|seed");
  process.exit(1);
}
