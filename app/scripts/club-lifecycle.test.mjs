// Club type switching, market settlement and closing: rules mirrored from the
// program and instruction encodings, without a wallet or network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
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
    ts.transpileModule(
      readFileSync(new URL(`../lib/${file}`, import.meta.url), "utf8"),
      { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } },
    ).outputText,
    {
      module: mod,
      exports: mod.exports,
      Buffer,
      BigInt,
      Date,
      setTimeout,
      require: (name) => modules[name] ?? require(name),
    },
  );
  return mod.exports;
}
const base = {
  "./solana": { PROGRAM_ID: programId },
  "./outcomia": { TOKEN_PROGRAM_ID: TOKEN },
  "./shared": {
    optionalAccounts: (values) =>
      Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v ?? programId])),
  },
};
const deposits = load("club-deposits.ts", base);
const l = load("club-lifecycle.ts", { ...base, "./club-deposits": deposits });
const key = (n) => new PublicKey(Buffer.alloc(32, n));
const name = (i) => p.coder.instruction.decode(i.data).name;
function account(i, n) {
  const ix = idl.instructions.find(
    (x) => x.name === name(i).replace(/[A-Z]/g, (ch) => "_" + ch.toLowerCase()),
  );
  return i.keys[ix.accounts.findIndex((x) => x.name === n)].pubkey;
}
const market = (status, { closeTs = 100, yes = 0 } = {}) => ({
  status: { [status]: {} },
  closeTs: new BN(closeTs),
  yesSupply: new BN(yes),
  noSupply: new BN(0),
  backingReserve: new BN(0),
});
const zero = new BN(0),
  fees = new BN(5);

test("settle state follows the program's finished-market rule", () => {
  assert.equal(l.settleState(market("resolved"), zero, true, 0), "settled");
  assert.equal(l.settleState(market("resolved"), zero, false, 0), "ready");
  assert.equal(l.settleState(market("resolved"), fees, false, 0), "fees");
  for (const status of ["open", "frozen", "proposed"])
    assert.equal(l.settleState(market(status), zero, false, 1e9), "live");
  // A draft settles only after its close time, and only while empty.
  assert.equal(l.settleState(market("draft"), zero, false, 99), "live");
  assert.equal(l.settleState(market("draft"), zero, false, 100), "ready");
  assert.equal(l.settleState(market("draft", { yes: 1 }), zero, false, 100), "live");
});

test("close blockers explain what is left", () => {
  assert.equal(l.closeBlockers({ liveMarketsReady: true, liveMarkets: 0 }).length, 0);
  assert.match(l.closeBlockers({ liveMarketsReady: true, liveMarkets: 2 })[0], /Settle every/);
  assert.match(l.closeBlockers({ liveMarketsReady: false, liveMarkets: 0 })[0], /market count/);
  assert.match(l.closeBlockers({ closed: true })[0], /closed/);
});

test("lifecycle instructions name the right accounts", async () => {
  const owner = key(1),
    club = key(2),
    mkt = key(3),
    token = key(4),
    price = key(5);
  const clubMarket = derive("club_market", mkt.toBuffer());
  const settle = await l.settleClubMarketInstruction(p, owner, club, mkt);
  assert.equal(name(settle), "settleClubMarket");
  assert(account(settle, "club_market").equals(clubMarket));
  assert(account(settle, "settlement").equals(derive("club_market_settled", clubMarket.toBuffer())));
  assert(account(settle, "settlement").equals(l.clubMarketSettlementPda(mkt)));

  const toPrivate = await l.setClubKindInstruction(p, owner, club, "private", null, { ownerToken: token });
  assert.ok("private" in p.coder.instruction.decode(toPrivate.data).data.kind);
  assert(account(toPrivate, "listing").equals(derive("club_listing", club.toBuffer())));
  assert(account(toPrivate, "deposit_vault").equals(derive("club_deposit_vault", club.toBuffer())));
  assert(account(toPrivate, "owner_token").equals(token));
  assert(account(toPrivate, "token_program").equals(TOKEN));
  assert(account(toPrivate, "price_update").equals(programId));
  const toPublic = await l.setClubKindInstruction(p, owner, club, "public", price, null);
  assert(account(toPublic, "price_update").equals(price));
  assert(account(toPublic, "deposit_vault").equals(programId));

  const close = await l.closeClubInstruction(p, owner, club, null);
  assert.equal(name(close), "closeClub");
  assert(account(close, "owner_record").equals(derive("club_owner", owner.toBuffer())));
  assert(account(close, "owner_member").equals(derive("club_member", club.toBuffer(), owner.toBuffer())));
  assert(account(close, "owner_token").equals(programId));
  const closeUsdc = await l.closeClubInstruction(p, owner, club, { ownerToken: token });
  assert(account(closeUsdc, "owner_token").equals(token));
});
