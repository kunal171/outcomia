// Exercise the browser's pure parser in Node without loading Next.js or .env.
// TypeScript is already a dev dependency; no additional test runner is needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { webcrypto, createHash } from "node:crypto";
import ts from "typescript";

const require = createRequire(import.meta.url);
const { PublicKey } = require("@solana/web3.js");
const mod = { exports: {} };
const source = readFileSync(
  new URL("../lib/prediction.ts", import.meta.url),
  "utf8",
);
const code = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
}).outputText;
runInNewContext(code, {
  module: mod,
  exports: mod.exports,
  Buffer,
  TextEncoder,
  TextDecoder,
  crypto: webcrypto,
  process: { env: {} },
  require: (name) =>
    name === "./solana" ? { PROGRAM_ID: PublicKey.default } : require(name),
});
const { parsePredictionRules, derivePredictionMarketPda } = mod.exports;

function rules() {
  return {
    schemaVersion: 1,
    question: "Will this proposal pass?",
    resolutionSource: "https://example.org/proposals/1",
    resolutionRules: {
      yesCriteria: "Proposal final state is succeeded before close.",
      noCriteria: "Proposal final state is defeated before close.",
      invalidCriteria: "Neither result can be established.",
      evidenceRequirements: "Final proposal account and timestamp.",
      conflictingEvidencePolicy: "Use the committed final account observation.",
    },
    primaryResolver: new PublicKey(new Uint8Array(32).fill(1)).toBase58(),
    closeTimestamp: 1900000000,
    earliestResolutionTimestamp: null,
    resolutionDelaySeconds: 3600,
    fallback: null,
  };
}

function bytes(value, pretty = false) {
  return new TextEncoder().encode(
    JSON.stringify(value, null, pretty ? 2 : undefined),
  ).buffer;
}

test("hashes exact document bytes and unnormalized UTF-8 question", async () => {
  const value = rules();
  value.question += " café";
  const raw = bytes(value, true);
  const result = await parsePredictionRules(raw);
  assert.equal(
    Buffer.from(result.rulesHash).toString("hex"),
    createHash("sha256").update(Buffer.from(raw)).digest("hex"),
  );
  assert.equal(
    Buffer.from(result.questionHash).toString("hex"),
    createHash("sha256").update(value.question).digest("hex"),
  );
  assert.notEqual(
    Buffer.from(result.rulesHash).toString("hex"),
    Buffer.from((await parsePredictionRules(bytes(value))).rulesHash).toString(
      "hex",
    ),
  );
  assert.equal(result.earliestResolutionTs, null);
  assert.equal(result.fallback, null);
});

test("optional fallback deadline has explicit timeout semantics", async () => {
  const value = rules();
  value.fallback = {
    resolver: new PublicKey(new Uint8Array(32).fill(2)).toBase58(),
    availableTimestamp: 1900086400,
    proposalDeadlineTimestamp: null,
    activation: "No primary proposal exists at the activation time",
    procedure: "Use the same source and evaluation criteria.",
    noProposalOutcome: "No automatic timeout; await resolver",
  };
  assert.equal(
    (await parsePredictionRules(bytes(value))).fallback.deadlineTs,
    null,
  );
  value.fallback.proposalDeadlineTimestamp = 1900172800;
  await assert.rejects(
    () => parsePredictionRules(bytes(value)),
    /timeout policy/,
  );
  value.fallback.noProposalOutcome = "Invalid after the proposal deadline";
  assert.equal(
    (await parsePredictionRules(bytes(value))).fallback.deadlineTs.toString(),
    "1900172800",
  );
  value.fallback.availableTimestamp = value.closeTimestamp;
  await assert.rejects(
    () => parsePredictionRules(bytes(value)),
    /Fallback times/,
  );
});

test("rejects ambiguous inputs and missing evaluation criteria", async () => {
  for (const field of [
    "yesCriteria",
    "noCriteria",
    "invalidCriteria",
    "evidenceRequirements",
    "conflictingEvidencePolicy",
  ]) {
    const value = rules();
    delete value.resolutionRules[field];
    await assert.rejects(() => parsePredictionRules(bytes(value)), /required/);
  }
  const value = rules();
  value.closeTimestamp = Number.MAX_SAFE_INTEGER + 1;
  await assert.rejects(
    () => parsePredictionRules(bytes(value)),
    /integer Unix seconds/,
  );
  value.closeTimestamp = 1900000000;
  value.earliestResolutionTimestamp = value.closeTimestamp - 1;
  await assert.rejects(
    () => parsePredictionRules(bytes(value)),
    /before trading closes/,
  );
  value.earliestResolutionTimestamp = null;
  value.resolutionDelaySeconds = 0;
  await assert.rejects(() => parsePredictionRules(bytes(value)), /positive/);
  await assert.rejects(
    () => parsePredictionRules(new ArrayBuffer(128 * 1024 + 1)),
    /128 KiB/,
  );
});

test("PDA namespace matches Rust and requires a 32-byte market ID", () => {
  const id = new Uint8Array(32).fill(7);
  const expected = PublicKey.findProgramAddressSync(
    [Buffer.from("prediction_market"), Buffer.from(id)],
    PublicKey.default,
  )[0];
  assert.equal(derivePredictionMarketPda(id).toBase58(), expected.toBase58());
  assert.throws(
    () => derivePredictionMarketPda(new Uint8Array(31)),
    /32 bytes/,
  );
});

test("creation arguments encode against the checked-in IDL within transaction limits", async () => {
  const { Program, BN } = require("@anchor-lang/core");
  const { Connection, SystemProgram, Transaction } = require("@solana/web3.js");
  const idl = JSON.parse(
    readFileSync(new URL("../idl/tidebook.json", import.meta.url), "utf8"),
  );
  // Every account is supplied explicitly; building this instruction needs no RPC.
  const program = new Program(idl, {
    connection: new Connection("http://127.0.0.1:8899"),
  });
  const parsed = await parsePredictionRules(bytes(rules()));
  const authority = parsed.resolver;
  const marketId = new Uint8Array(32).fill(7);
  const derive = (seed, ...keys) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from(seed), ...keys],
      program.programId,
    )[0];
  const market = derive("prediction_market", Buffer.from(marketId));
  const mint = new PublicKey(new Uint8Array(32).fill(3));
  const instruction = await program.methods
    .initializePredictionMarket(
      Array.from(marketId),
      {
        resolver: authority,
        fallback: {
          resolver: mint,
          availableTs: new BN("1900086400"),
          deadlineTs: new BN("1900172800"),
        },
        closeTs: parsed.closeTs,
        earliestResolutionTs: new BN("1900003600"),
        resolutionDelaySeconds: parsed.resolutionDelaySeconds,
        payoutPerContract: new BN("1000000"),
        priceTick: new BN("10000"),
        rulesUri: `ar://${"a".repeat(195)}`,
        questionHash: parsed.questionHash,
        rulesHash: parsed.rulesHash,
      },
      "x".repeat(64),
      "X".repeat(16),
    )
    .accountsStrict({
      authority,
      adminRecord: derive("admin", authority.toBuffer()),
      market,
      collateralMint: mint,
      vaultAuthority: derive("vault-authority", market.toBuffer()),
      collateralVault: derive("vault", market.toBuffer(), mint.toBuffer()),
      marketMetadata: derive("market_metadata", market.toBuffer()),
      marketFees: derive("market_fees", market.toBuffer()),
      tokenProgram: new PublicKey(
        "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      ),
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  assert.equal(
    program.coder.instruction.decode(instruction.data).name,
    "initializePredictionMarket",
  );
  const tx = new Transaction({
    feePayer: authority,
    recentBlockhash: PublicKey.default.toBase58(),
  }).add(instruction);
  assert.ok(
    tx.serialize({ requireAllSignatures: false, verifySignatures: false })
      .length <= 1232,
  );
});
