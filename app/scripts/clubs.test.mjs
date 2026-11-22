// Club addresses, discovery rules and instruction encodings, without a wallet or network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { loadTypeScript } from "./support/typescript.mjs";
const require = createRequire(import.meta.url),
  { BN, Program } = require("@anchor-lang/core"),
  { PublicKey, Connection, Transaction } = require("@solana/web3.js");
const idl = JSON.parse(
    readFileSync(new URL("../idl/outcomia.json", import.meta.url), "utf8"),
  ),
  programId = new PublicKey(idl.address),
  p = new Program(idl, { connection: new Connection("http://127.0.0.1:8899") });
const derive = (seed, ...parts) =>
  PublicKey.findProgramAddressSync([Buffer.from(seed), ...parts], programId)[0];
const indexed = loadTypeScript(
  new URL("../lib/indexed-accounts.ts", import.meta.url),
);
const outcomia = {
  deriveProtocolConfigPda: () => derive("protocol_config"),
  deriveVaultAuthorityPda: (m) => derive("vault-authority", m.toBuffer()),
  deriveVaultPda: (m, mint) => derive("vault", m.toBuffer(), mint.toBuffer()),
  deriveMarketMetadataPda: (m) => derive("market_metadata", m.toBuffer()),
  TOKEN_PROGRAM_ID: new PublicKey(
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  ),
};
function load(file, modules) {
  const mod = { exports: {} };
  runInNewContext(
    ts.transpileModule(
      readFileSync(new URL(`../lib/${file}`, import.meta.url), "utf8"),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2020,
        },
      },
    ).outputText,
    {
      module: mod,
      exports: mod.exports,
      Buffer,
      TextEncoder,
      crypto,
      process: { env: {} },
      require: (name) => modules[name] ?? require(name),
    },
  );
  return mod.exports;
}
const base = {
  "./indexed-accounts": indexed,
  "./solana": { PROGRAM_ID: programId },
  "./outcomia": outcomia,
  "./prediction": {
    derivePredictionPositionPda: (market, owner) =>
      derive("prediction_position", market.toBuffer(), owner.toBuffer()),
  },
};
const shared = load("shared.ts", base);
const c = load("clubs.ts", { ...base, "./shared": shared });
const key = (n) => new PublicKey(Buffer.alloc(32, n));
const name = (i) => p.coder.instruction.decode(i.data).name;
function account(i, n) {
  const ix = idl.instructions.find(
    (x) => x.name === name(i).replace(/[A-Z]/g, (ch) => "_" + ch.toLowerCase()),
  );
  return i.keys[ix.accounts.findIndex((x) => x.name === n)].pubkey;
}
const [owner, wallet, inviter] = [key(1), key(2), key(3)];
const id = Uint8Array.from(Buffer.alloc(32, 7));

test("club addresses match the program seeds", () => {
  const club = c.clubPda(id);
  assert(club.equals(derive("club", Buffer.from(id))));
  assert(
    c
      .clubMemberPda(club, wallet)
      .equals(derive("club_member", club.toBuffer(), wallet.toBuffer())),
  );
  assert(
    c
      .clubInvitePda(club, wallet)
      .equals(derive("club_invite", club.toBuffer(), wallet.toBuffer())),
  );
  const market = c.clubPredictionMarketPda(id);
  assert(market.equals(derive("club_prediction_market", Buffer.from(id))));
  assert(
    c.clubMarketPda(market).equals(derive("club_market", market.toBuffer())),
  );
  assert(c.clubBookPda(market).equals(derive("club_book", market.toBuffer())));
});

test("public discovery recognises only public-seed markets", () => {
  const publicMarket = derive("prediction_market", Buffer.from(id));
  const clubMarket = c.clubPredictionMarketPda(id);
  assert(c.isPublicPredictionMarket(publicMarket, Array.from(id)));
  assert(!c.isPublicPredictionMarket(clubMarket, Array.from(id)));
  assert(c.isClubPredictionMarket(clubMarket, Array.from(id)));
  assert(!c.isClubPredictionMarket(publicMarket, Array.from(id)));
});

test("roles, policy, expiry and names follow the program rules", () => {
  const club = { owner, marketPolicy: { adminsOnly: {} } };
  const admin = { wallet, role: { admin: {} } };
  const member = { wallet: inviter, role: { member: {} } };
  assert.equal(
    c.clubRole(club, { wallet: owner, role: { admin: {} } }),
    "owner",
  );
  assert.equal(c.clubRole(club, admin), "admin");
  assert.equal(c.clubRole(club, member), "member");
  assert.equal(c.clubRole(club, null), null);
  assert(c.canCreateClubMarket(club, admin));
  assert(!c.canCreateClubMarket(club, member));
  assert(
    c.canCreateClubMarket({ ...club, marketPolicy: { anyMember: {} } }, member),
  );
  assert(!c.canCreateClubMarket(club, null));
  assert(c.inviteExpired({ expiresAt: new BN(100) }, 100));
  assert(!c.inviteExpired({ expiresAt: new BN(100) }, 99));
  for (const bad of ["", " padded", "trailing ", "é".repeat(33)])
    assert(c.clubNameIssue(bad), bad);
  assert.equal(c.clubNameIssue("é".repeat(32)), null);
});

test("administration instructions bind the signer's own membership", async () => {
  const { club, instruction } = await c.createClubInstruction(
    p,
    owner,
    "Chess",
    id,
  );
  assert.equal(name(instruction), "createClub");
  assert(
    account(instruction, "owner_member").equals(c.clubMemberPda(club, owner)),
  );
  const invite = await c.inviteClubMemberInstruction(p, owner, club, wallet);
  assert(
    account(invite, "existing_member").equals(c.clubMemberPda(club, wallet)),
  );
  assert(account(invite, "invite").equals(c.clubInvitePda(club, wallet)));
  const accept = await c.acceptClubInviteInstruction(p, wallet, {
    club,
    inviter,
  });
  assert(account(accept, "inviter").equals(inviter));
  assert(account(accept, "member").equals(c.clubMemberPda(club, wallet)));
  const decline = await c.closeClubInviteInstruction(
    p,
    wallet,
    { club, wallet, inviter },
    false,
  );
  assert(account(decline, "closer_member").equals(programId));
  const revoke = await c.closeClubInviteInstruction(
    p,
    owner,
    { club, wallet, inviter },
    true,
  );
  assert(account(revoke, "closer_member").equals(c.clubMemberPda(club, owner)));
  const remove = await c.removeClubMemberInstruction(p, owner, club, wallet);
  assert(account(remove, "wallet").equals(wallet));
  assert(account(remove, "admin_member").equals(c.clubMemberPda(club, owner)));
});

test("club market creation opens the market and its book in one packet", async () => {
  const club = c.clubPda(id),
    mint = key(5);
  const { market, instructions } = await c.createClubMarketInstructions(
    p,
    owner,
    club,
    mint,
    {
      resolver: owner,
      fallback: null,
      closeTs: new BN(2_000_000_000),
      earliestResolutionTs: null,
      resolutionDelaySeconds: new BN(3600),
      payoutPerContract: new BN(1_000_000),
      priceTick: new BN(10_000),
      rulesUri: `ar://${"a".repeat(43)}`,
      questionHash: Array(32).fill(1),
      rulesHash: Array(32).fill(2),
    },
    "Will it rain tomorrow in the city centre?",
    "tUSDC",
    false,
    id,
  );
  assert.deepEqual(Array.from(instructions, name), [
    "createClubPredictionMarket",
    "openClubPredictionMarket",
    "initializeClubBook",
  ]);
  assert(market.equals(c.clubPredictionMarketPda(id)));
  assert(account(instructions[2], "book").equals(c.clubBookPda(market)));
  const tx = new Transaction().add(...instructions);
  tx.feePayer = owner;
  tx.recentBlockhash = PublicKey.default.toBase58();
  const bytes = tx.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  });
  assert(bytes.length <= 1232, `${bytes.length} bytes`);
});

test("custody passes membership only to members-only splits", async () => {
  const club = c.clubPda(id),
    market = c.clubPredictionMarketPda(id),
    mint = key(5),
    position = derive(
      "prediction_position",
      market.toBuffer(),
      owner.toBuffer(),
    );
  const trading = {
    club,
    clubMarket: c.clubMarketPda(market),
    membersOnly: true,
    members: new Set(),
  };
  const split = await c.clubCompleteSetInstruction(
    p,
    owner,
    trading,
    market,
    mint,
    position,
    new BN(1),
    true,
  );
  assert(account(split, "member").equals(c.clubMemberPda(club, owner)));
  const merge = await c.clubCompleteSetInstruction(
    p,
    owner,
    trading,
    market,
    mint,
    position,
    new BN(1),
    false,
  );
  assert(account(merge, "member").equals(programId));
  const redeem = await c.redeemClubPredictionInstruction(
    p,
    owner,
    trading,
    market,
    mint,
    position,
    new BN(1),
    new BN(0),
  );
  assert(account(redeem, "member").equals(programId));
  const publicSplit = await c.clubCompleteSetInstruction(
    p,
    owner,
    { ...trading, membersOnly: false },
    market,
    mint,
    position,
    new BN(1),
    true,
  );
  assert(account(publicSplit, "member").equals(programId));
});
