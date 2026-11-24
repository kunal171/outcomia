#!/usr/bin/env node
// Devnet demo activity: real trades on the demo markets so charts have history.
//
// Each round picks the next demo market, moves its price by a small random
// walk (0.01 steps, 0.02–0.98, pulled back toward where it started), then:
//   1. the seller splits complete sets so it holds the contracts it sells,
//   2. a maker bids at the new price,
//   3. the seller sells into that bid.
// Wallets are the demo makers/taker from the git-ignored demo-markets folder.
// Usage: SOLANA_RPC_URL=… MINUTES=180 node scripts/devnet-market-activity.mjs
import fs from "node:fs";
import path from "node:path";
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
const m = loadTypeScript(new URL("../lib/multi-outcome.ts", import.meta.url));
const sh = loadTypeScript(new URL("../lib/shared.ts", import.meta.url));
const o = loadTypeScript(new URL("../lib/outcomia.ts", import.meta.url));
const pr = loadTypeScript(new URL("../lib/prediction.ts", import.meta.url));

const root = fileURLToPath(new URL("../../", import.meta.url));
const report = JSON.parse(
  fs.readFileSync(
    path.join(root, "docs/devnet/demo-markets-result.json"),
    "utf8",
  ),
);
const secrets = JSON.parse(
  fs.readFileSync(
    path.join(
      root,
      "target/deploy-history/2026-11-23-demo-markets/wallets.json",
    ),
    "utf8",
  ),
);
const [m1, m2, m3, m4, seller] = secrets.map((s) =>
  Keypair.fromSecretKey(Uint8Array.from(s)),
);
const makers = [m1, m2, m3, m4];
const rpc = process.env.SOLANA_RPC_URL;
if (!rpc?.startsWith("https://")) throw new Error("Set SOLANA_RPC_URL");
const conn = new Connection(rpc, "confirmed");
const idl = JSON.parse(
  fs.readFileSync(new URL("../idl/outcomia.json", import.meta.url), "utf8"),
);
const programFor = (kp) =>
  new Program(
    idl,
    new AnchorProvider(conn, new Wallet(kp), { commitment: "confirmed" }),
  );
const P = programFor(m1);
const TICK = 10_000; // 0.01 of a 6-decimal token
const price = (p) => new BN(Math.round(p * 100) * TICK);
const deadline = Date.now() + Number(process.env.MINUTES ?? 180) * 60_000;
const pauseMs = Number(process.env.PAUSE_MS ?? 4000);
const feeBps = (
  await P.account.protocolConfig.fetch(o.deriveProtocolConfigPda())
).takerFeeBps;

const gauss = () =>
  Math.sqrt(-2 * Math.log(1 - Math.random())) *
  Math.cos(2 * Math.PI * Math.random());
/** Next price: mean-reverting random walk with occasional jumps, 0.02–0.98. */
function walk(p, anchor) {
  const jump = Math.random() < 0.06 ? gauss() * 0.05 : 0;
  const next = p + (anchor - p) * 0.08 + gauss() * 0.012 + jump;
  return Math.min(0.98, Math.max(0.02, Math.round(next * 100) / 100));
}
const pick = (list) => list[Math.floor(Math.random() * list.length)];

async function send(ixsOrTx, signers) {
  const tx =
    ixsOrTx instanceof Transaction
      ? ixsOrTx
      : new Transaction().add(...ixsOrTx);
  try {
    return await sendAndConfirmTransaction(conn, tx, signers, {
      commitment: "confirmed",
    });
  } catch (cause) {
    // Landed after the blockhash expired: treat a confirmed signature as success.
    const sig = cause?.signature;
    const status = sig
      ? (await conn.getSignatureStatus(sig, { searchTransactionHistory: true }))
          .value
      : null;
    if (status && !status.err) return sig;
    throw cause;
  }
}

// Market state: current price per outcome and the anchor it reverts to.
const markets = [];
for (const [slug, rec] of Object.entries(report.markets)) {
  const key = new PublicKey(rec.address);
  if (rec.kind === "binary") {
    const snap = await sh.readSharedBook(P, key);
    if (!snap) continue;
    const bid = snap.book.bestPrices[0];
    const p = bid ? Math.min(0.97, bid.toNumber() / 1e6 + 0.02) : 0.5;
    const market = await P.account.predictionMarket.fetch(key);
    markets.push({
      slug,
      kind: "binary",
      key,
      market,
      prices: [p],
      anchors: [p],
    });
  } else {
    const mk = await m.multiAccounts(P).multiOutcomeMarket.fetch(key);
    const b = await m.readMultiBook(P, key);
    const n = mk.terms.outcomeLabels.length;
    const prices = Array.from({ length: n }, (_, i) => {
      const head = b.book.heads[m.slot(i, "bid")];
      return head ? Math.min(0.95, head.price.toNumber() / 1e6 + 0.02) : 1 / n;
    });
    markets.push({
      slug,
      kind: "multi",
      key,
      mk,
      n,
      prices,
      anchors: [...prices],
    });
  }
}
console.log(
  `markets: ${markets.length}, until ${new Date(deadline).toISOString()}`,
);

async function binaryTrade(t) {
  const buyer = pick(makers);
  const outcome = Math.random() < 0.5 ? "yes" : "no";
  t.prices[0] = walk(t.prices[0], t.anchors[0]);
  const p =
    outcome === "yes" ? t.prices[0] : Math.round((1 - t.prices[0]) * 100) / 100;
  const qty = new BN(5 + Math.floor(Math.random() * 36));
  // 1. Seller splits qty complete sets (qty YES + qty NO from qty collateral).
  await send(
    [
      await programFor(seller)
        .methods.sharedCompleteSet(qty, true)
        .accountsPartial({
          owner: seller.publicKey,
          market: t.key,
          position: pr.derivePredictionPositionPda(t.key, seller.publicKey),
          mint: t.market.collateralMint,
          assetBalance: sh.assetBalancePda(
            seller.publicKey,
            t.market.collateralMint,
          ),
          assetAuthority: sh.assetAuthorityPda(t.market.collateralMint),
          assetVault: sh.assetVaultPda(t.market.collateralMint),
          marketAuthority: o.deriveVaultAuthorityPda(t.key),
          marketVault: t.market.collateralVault,
          tokenProgram: o.TOKEN_PROGRAM_ID,
        })
        .instruction(),
    ],
    [seller],
  );
  // 2. Maker bids; 3. seller sells into it. Complements on so a crossing bid
  // fills through the other outcome instead of being rejected at rest.
  for (const [kp, side] of [
    [buyer, "bid"],
    [seller, "ask"],
  ]) {
    const snap = await sh.readSharedBook(P, t.key);
    const plan = await sh.buildSharedTrade(
      programFor(kp),
      snap,
      kp.publicKey,
      outcome,
      side,
      price(p),
      qty,
      [],
      true,
    );
    if (plan.instructions.length) await send(plan.instructions, [kp]);
  }
  return `${outcome.toUpperCase()} ${p.toFixed(2)} x${qty}`;
}

async function multiTrade(t) {
  const buyer = pick(makers);
  const i = Math.floor(Math.random() * t.n);
  t.prices[i] = walk(t.prices[i], t.anchors[i]);
  const p = Math.min(0.95, t.prices[i]);
  const lot = t.mk.terms.quantityLot.toNumber();
  const qty = new BN(
    lot * (1 + Math.floor(Math.random() * Math.max(1, Math.floor(40 / lot)))),
  );
  await send(
    [
      await programFor(seller)
        .methods.multiOutcomeCompleteSet(qty, true)
        .accountsStrict(m.custody(t.key, seller.publicKey, t.mk.collateralMint))
        .instruction(),
    ],
    [seller],
  );
  for (const [kp, side] of [
    [buyer, "bid"],
    [seller, "ask"],
  ]) {
    const mk = await m.multiAccounts(P).multiOutcomeMarket.fetch(t.key);
    const b = await m.readMultiBook(P, t.key);
    const plan = await m.buildMultiTrade(
      programFor(kp),
      t.key,
      mk,
      b.book,
      b.rows,
      kp.publicKey,
      i,
      side,
      price(p),
      qty,
      feeBps,
      true,
      [],
      null,
    );
    if (plan.transaction.instructions.length)
      await send(plan.transaction, [kp]);
  }
  return `${t.mk.terms.outcomeLabels[i]} ${p.toFixed(2)} x${qty}`;
}

let round = 0,
  ok = 0,
  failed = 0;
while (Date.now() < deadline) {
  const t = markets[round++ % markets.length];
  try {
    const what =
      t.kind === "binary" ? await binaryTrade(t) : await multiTrade(t);
    ok++;
    console.log(`${new Date().toISOString()} ok   ${t.slug}: ${what}`);
  } catch (cause) {
    failed++;
    console.log(
      `${new Date().toISOString()} fail ${t.slug}: ${String(
        cause?.message ?? cause,
      )
        .split("\n")[0]
        .slice(0, 160)}`,
    );
  }
  await new Promise((r) => setTimeout(r, pauseMs));
}
console.log(`done: ${ok} trades, ${failed} failures`);
process.exit(0);
