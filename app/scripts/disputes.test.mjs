// Outcome disputes: window and eligibility rules mirrored from the program, and
// instruction encodings for binary and multi-outcome markets, without a network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { loadTypeScript } from "./support/typescript.mjs";
const require = createRequire(import.meta.url),
  { BN, Program } = require("@anchor-lang/core"),
  { PublicKey, Connection } = require("@solana/web3.js");
const idl = JSON.parse(
    readFileSync(new URL("../idl/outcomia.json", import.meta.url), "utf8"),
  ),
  programId = new PublicKey(idl.address),
  p = new Program(idl, { connection: new Connection("http://127.0.0.1:8899") });
const derive = (seed, ...parts) =>
  PublicKey.findProgramAddressSync([Buffer.from(seed), ...parts], programId)[0];
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
function load(file, modules) {
  const mod = { exports: {} };
  runInNewContext(
    ts.transpileModule(readFileSync(new URL(`../lib/${file}`, import.meta.url), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText,
    {
      module: mod,
      exports: mod.exports,
      Buffer,
      BigInt,
      require: (name) => modules[name] ?? require(name),
    },
  );
  return mod.exports;
}
const d = load("disputes.ts", {
  "./solana": { PROGRAM_ID: programId },
  "./outcomia": { TOKEN_PROGRAM_ID: TOKEN },
  "./indexed-accounts": loadTypeScript(new URL("../lib/indexed-accounts.ts", import.meta.url)),
});
const key = (n) => new PublicKey(Buffer.alloc(32, n));
const name = (i) => p.coder.instruction.decode(i.data).name;
const args = (i) => p.coder.instruction.decode(i.data).data;
function account(i, n) {
  const ix = idl.instructions.find(
    (x) => x.name === name(i).replace(/[A-Z]/g, (ch) => "_" + ch.toLowerCase()),
  );
  return i.keys[ix.accounts.findIndex((x) => x.name === n)].pubkey;
}
const market = { proposal: { proposedAt: new BN(1_000) }, resolutionDelaySeconds: new BN(10) };
const record = (state, window = 500) => ({ state: { [state]: {} }, windowSeconds: new BN(window) });

test("the window ends after the review delay and the dispute window", () => {
  assert.equal(d.windowEnd(market, record("none")), 1_500);
  // A window shorter than the delay changes nothing.
  assert.equal(d.windowEnd(market, record("none", 1)), 1_010);
  assert.equal(d.windowEnd({ ...market, proposal: null }, record("none")), null);
  const proposed = { proposed: {} };
  assert(d.canDispute(proposed, market, record("none"), 1_499));
  assert(!d.canDispute(proposed, market, record("none"), 1_500));
  assert(!d.canDispute(proposed, market, record("open"), 1_100));
  assert(!d.canDispute({ resolved: {} }, market, record("none"), 1_100));
  assert(!d.canDispute(proposed, market, null, 1_100));
  assert.equal(d.disputeState(record("overturned")), "overturned");
});

test("creators and resolvers cannot rule; the bond is whole tokens", () => {
  const [creator, resolver, fallback, admin] = [key(1), key(2), key(3), key(4)];
  assert.match(d.rulerIssue(creator, creator, resolver, null), /creator/);
  assert.match(d.rulerIssue(resolver, creator, resolver, null), /resolvers/);
  assert.match(d.rulerIssue(fallback, creator, resolver, { resolver: fallback }), /resolvers/);
  assert.equal(d.rulerIssue(admin, creator, resolver, { resolver: fallback }), null);
  assert.equal(d.bondUnits({ bondTokens: new BN(2) }, 6), 2_000_000n);
});

test("binary dispute instructions name the right accounts and rulings", async () => {
  const [disputer, mkt, mint, token, admin, club, recipient] = [1, 2, 3, 4, 5, 6, 7].map(key);
  const open = await d.openDisputeInstruction(p, "binary", disputer, mkt, mint, token);
  assert.equal(name(open), "openPredictionDispute");
  assert(account(open, "dispute").equals(derive("market_dispute", mkt.toBuffer())));
  assert(account(open, "position").equals(derive("prediction_position", mkt.toBuffer(), disputer.toBuffer())));
  assert(account(open, "bond_vault").equals(derive("dispute_bond", mkt.toBuffer())));
  assert(account(open, "dispute_config").equals(derive("dispute_config")));

  const rule = await d.ruleDisputeInstruction(p, "binary", admin, mkt, "no", recipient, disputer, club);
  assert.ok("no" in args(rule).ruling.overturn[0]);
  assert(account(rule, "admin_record").equals(derive("admin", admin.toBuffer())));
  assert(account(rule, "club_market").equals(derive("club_market", mkt.toBuffer())));
  assert(account(rule, "admin_club_member").equals(derive("club_member", club.toBuffer(), admin.toBuffer())));
  const publicRule = await d.ruleDisputeInstruction(p, "binary", admin, mkt, "uphold", recipient, disputer, null);
  assert.ok("uphold" in args(publicRule).ruling);
  assert(account(publicRule, "admin_club_member").equals(programId));
  const invalid = await d.ruleDisputeInstruction(p, "binary", admin, mkt, "invalid", recipient, disputer, null);
  assert.ok("invalid" in args(invalid).ruling);

  const expire = await d.expireDisputeInstruction(p, "binary", mkt, recipient, disputer);
  assert.equal(name(expire), "expirePredictionDispute");
  assert(account(expire, "disputer").equals(disputer));
});

test("multi-outcome dispute instructions use the multi position and outcome ids", async () => {
  const [disputer, mkt, mint, token, admin, recipient] = [1, 2, 3, 4, 5, 7].map(key);
  const open = await d.openDisputeInstruction(p, "multi", disputer, mkt, mint, token);
  assert.equal(name(open), "openMultiOutcomeDispute");
  assert(account(open, "position").equals(derive("multi_position", mkt.toBuffer(), disputer.toBuffer())));
  const rule = await d.ruleDisputeInstruction(p, "multi", admin, mkt, 2, recipient, disputer, null);
  assert.equal(name(rule), "ruleMultiOutcomeDispute");
  assert.equal(args(rule).ruling.overturn[0][0], 2);
  const expire = await d.expireDisputeInstruction(p, "multi", mkt, recipient, disputer);
  assert.equal(name(expire), "expireMultiOutcomeDispute");
});

test("dispute settings encode in seconds and whole tokens", async () => {
  const ix = await d.setDisputeConfigInstruction(p, key(1), {
    clubWindowSeconds: new BN(432_000),
    regularWindowSeconds: new BN(259_200),
    bondTokens: new BN(1),
    rulingDeadlineSeconds: new BN(604_800),
    treasury: key(9),
  });
  const a = args(ix);
  assert.equal(a.clubWindowSeconds.toString(), "432000");
  assert.equal(a.rulingDeadlineSeconds.toString(), "604800");
  assert(a.treasury.equals(key(9)));
  assert(account(ix, "protocol_config").equals(derive("protocol_config")));
});
