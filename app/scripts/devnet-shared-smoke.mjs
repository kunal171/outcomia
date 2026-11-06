/** Two-stage devnet release check. Fresh tokens isolate existing user funds.
 * prepare: trade and save public evidence; resolve: use that evidence's pinned commit.
 * Checkpoints and generated keypairs stay under ignored target/, never in the report. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { execFileSync } from "node:child_process";
import anchor from "@anchor-lang/core";
import web3 from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  burn,
  closeAccount,
  getMint,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
const { AnchorProvider, BN, Program, Wallet } = anchor;
const { Connection, Keypair, PublicKey, SystemProgram, Transaction } = web3;
const root = fileURLToPath(new URL("../../", import.meta.url));
const directory = path.join(
  root,
  "target/deploy-history/2026-11-06-shared-balances",
);
fs.mkdirSync(directory, { recursive: true });
const checkpoint = path.join(directory, "smoke-checkpoint.json"),
  keysFile = path.join(directory, "smoke-keys.json");
const publicEvidence = path.join(
  root,
  "docs/devnet/shared-smoke-evidence.json",
);
const completion = path.join(root, "docs/devnet/shared-smoke-result.json");
const stage = process.argv[2];
if (!["prepare", "resolve", "snapshot"].includes(stage))
  throw new Error("Use prepare, resolve or snapshot");
// Load only public RPC settings. Never import the faucet's server secret.
const env = {};
for (const file of [".env", ".env.local"]) {
  const p = path.join(root, "app", file);
  if (fs.existsSync(p))
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(
        /^(NEXT_PUBLIC_(?:HELIUS_RPC_URL|HELIUS_API_KEY|SOLANA_RPC_URL))=(.*)$/,
      );
      if (m) env[m[1]] = m[2].trim().replace(/^(["'])(.*)\1$/, "$2");
    }
}
const rpc = new URL(
  process.env.SOLANA_RPC_URL ||
    env.NEXT_PUBLIC_HELIUS_RPC_URL ||
    env.NEXT_PUBLIC_SOLANA_RPC_URL ||
    "https://api.devnet.solana.com",
);
if (rpc.hostname === "devnet.helius-rpc.com" && env.NEXT_PUBLIC_HELIUS_API_KEY)
  rpc.searchParams.set("api-key", env.NEXT_PUBLIC_HELIUS_API_KEY);
const connection = new Connection(rpc.toString(), "confirmed");
const idl = JSON.parse(
  fs.readFileSync(path.join(root, "app/idl/tidebook.json"), "utf8"),
);
const payer = Keypair.fromSecretKey(
  Uint8Array.from(
    JSON.parse(
      fs.readFileSync(
        process.env.SOLANA_WALLET ||
          path.join(os.homedir(), ".config/solana/id.json"),
        "utf8",
      ),
    ),
  ),
);
const programFor = (key) =>
  new Program(
    idl,
    new AnchorProvider(connection, new Wallet(key), {
      commitment: "confirmed",
      preflightCommitment: "confirmed",
    }),
  );
const a = programFor(payer),
  id = a.programId;
const bn = (v) => new BN(String(v)),
  pda = (seed, ...parts) =>
    PublicKey.findProgramAddressSync(
      [
        Buffer.from(seed),
        ...parts.map((x) =>
          x instanceof PublicKey ? x.toBuffer() : Buffer.from(x),
        ),
      ],
      id,
    )[0];
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest();
const gitHead = () =>
  execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
const require = createRequire(import.meta.url),
  ts = require("typescript"),
  module = { exports: {} };
runInNewContext(
  ts.transpileModule(
    fs.readFileSync(path.join(root, "app/lib/shared.ts"), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
      },
    },
  ).outputText,
  {
    module,
    exports: module.exports,
    Buffer,
    process: { env: {} },
    require: (name) =>
      name === "./solana"
        ? { PROGRAM_ID: id }
        : name === "./tidebook"
          ? { deriveProtocolConfigPda: () => pda("protocol_config") }
          : name === "./prediction"
            ? {
                derivePredictionPositionPda: (m, o) =>
                  pda("prediction_position", m, o),
              }
            : require(name),
  },
);
const sdk = module.exports;
let state = fs.existsSync(checkpoint)
  ? JSON.parse(fs.readFileSync(checkpoint, "utf8"))
  : {
      program: id.toBase58(),
      deployer: payer.publicKey.toBase58(),
      sourceCommit: gitHead(),
      steps: {},
    };
function save() {
  fs.writeFileSync(checkpoint, JSON.stringify(state, null, 2) + "\n", {
    mode: 0o600,
  });
}
async function step(label, action) {
  if (Object.hasOwn(state.steps, label)) return state.steps[label];
  const result = await action();
  state.steps[label] = result;
  save();
  console.log(
    label + ": " + (typeof result === "string" ? result : "confirmed"),
  );
  return result;
}
async function send(label, program, instructions) {
  return step(label, () =>
    program.provider.sendAndConfirm(new Transaction().add(...instructions)),
  );
}
const account = (program, name, key) => program.account[name].fetch(key);
const rawTokens = async (key) => (await getAccount(connection, key)).amount;
const equal = (actual, expected, label) =>
  assert.equal(actual.toString(), String(expected), label);
async function chainTime() {
  const slot = await connection.getSlot("confirmed"),
    time = await connection.getBlockTime(slot);
  if (time === null) throw new Error("Chain timestamp unavailable");
  return time;
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function main() {
  assert.equal(
    await connection.getGenesisHash(),
    "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
    "Devnet only",
  );
  assert.equal(id.toBase58(), "AG4ztZvcZjzFKjoXLzH8M6U3if9CwVFTXH2FHjqg7SdL");
  assert.equal(state.deployer, payer.publicKey.toBase58());
  if (stage === "snapshot") {
    const records = await connection.getProgramAccounts(id, "confirmed");
    const snapshot = records
      .map((r) => ({
        address: r.pubkey.toBase58(),
        sha256: hash(r.account.data).toString("hex"),
        lamports: r.account.lamports,
      }))
      .sort((x, y) => x.address.localeCompare(y.address));
    fs.writeFileSync(
      path.join(directory, "before-accounts.json"),
      JSON.stringify(snapshot, null, 2) + "\n",
    );
    console.log(`Saved ${snapshot.length} existing public account hashes.`);
    return;
  }
  const config = await a.account.protocolConfig.fetch(pda("protocol_config"));
  assert(
    config.superAdmin.equals(payer.publicKey),
    "Smoke cleanup requires the current super-admin",
  );
  const admin = pda("admin", payer.publicKey);
  assert(
    "active" in (await a.account.adminRecord.fetch(admin)).status,
    "Active creator admin required",
  );
  if (!fs.existsSync(keysFile)) {
    const keys = {};
    for (const label of ["base", "quote", "taker"])
      keys[label] = Array.from(Keypair.generate().secretKey);
    fs.writeFileSync(keysFile, JSON.stringify(keys), { mode: 0o600 });
  }
  const secrets = JSON.parse(fs.readFileSync(keysFile, "utf8"));
  const baseKey = Keypair.fromSecretKey(Uint8Array.from(secrets.base)),
    quoteKey = Keypair.fromSecretKey(Uint8Array.from(secrets.quote)),
    taker = Keypair.fromSecretKey(Uint8Array.from(secrets.taker));
  if (stage === "prepare" && state.steps.initialize_prediction) {
    const previous = await a.account.predictionMarket.fetch(
      new PublicKey(state.prediction),
    );
    if (
      "draft" in previous.status &&
      previous.closeTs.lte(bn(await chainTime()))
    ) {
      assert(
        previous.authority.equals(payer.publicKey) &&
          previous.backingReserve.isZero() &&
          previous.yesSupply.isZero() &&
          previous.noSupply.isZero(),
        "Only an unfunded test draft may be replaced",
      );
      state.expiredUnfundedDrafts ??= [];
      state.expiredUnfundedDrafts.push(state.prediction);
      state.predictionAttempt = (state.predictionAttempt ?? 0) + 1;
      delete state.closeTs;
      for (const name of [
        "initialize_prediction",
        "initialize_maker_position",
        "initialize_taker_position",
        "open_prediction",
      ])
        delete state.steps[name];
      save();
      console.log(
        "The unfunded test draft expired; using a fresh question ID without changing its immutable deadline.",
      );
    }
  }
  const b = programFor(taker),
    base = baseKey.publicKey,
    quote = quoteKey.publicKey;
  const spot = pda("market", base, quote),
    spotBook = sdk.sharedBookPda(spot),
    predId = hash(
      Buffer.from(
        `shared-smoke:${base}:${quote}${state.predictionAttempt ? ":" + state.predictionAttempt : ""}`,
      ),
    ),
    prediction = pda("prediction_market", predId),
    predBook = sdk.sharedBookPda(prediction);
  const predVault = pda("vault", prediction, quote),
    assetVault = sdk.assetVaultPda(quote);
  const position = (owner) => pda("prediction_position", prediction, owner);
  Object.assign(state, {
    baseMint: base.toBase58(),
    quoteMint: quote.toBase58(),
    taker: taker.publicKey.toBase58(),
    spot: spot.toBase58(),
    prediction: prediction.toBase58(),
  });
  save();
  const ledger = (program, mint) =>
    account(
      program,
      "assetBalance",
      sdk.assetBalancePda(program.provider.wallet.publicKey, mint),
    );
  async function custody(program, mint) {
    return {
      ...sdk.assetCustody(program.provider.wallet.publicKey, mint),
      tokenProgram: TOKEN_PROGRAM_ID,
    };
  }
  const predCustody = (program) => ({
    owner: program.provider.wallet.publicKey,
    market: prediction,
    position: position(program.provider.wallet.publicKey),
    mint: quote,
    assetBalance: sdk.assetBalancePda(program.provider.wallet.publicKey, quote),
    assetAuthority: sdk.assetAuthorityPda(quote),
    assetVault,
    marketAuthority: pda("vault-authority", prediction),
    marketVault: predVault,
    tokenProgram: TOKEN_PROGRAM_ID,
  });
  async function conserve() {
    const books = await Promise.all([
      a.account.sharedBook.fetch(spotBook),
      a.account.sharedBook.fetch(predBook),
    ]);
    for (const mint of [base, quote]) {
      const [x, y] = await Promise.all([ledger(a, mint), ledger(b, mint)]);
      const fees = mint.equals(quote)
        ? books.reduce((n, r) => n + BigInt(r.accruedQuoteFees.toString()), 0n)
        : 0n;
      assert.equal(
        await rawTokens(sdk.assetVaultPda(mint)),
        BigInt(x.free.toString()) +
          BigInt(x.locked.toString()) +
          BigInt(y.free.toString()) +
          BigInt(y.locked.toString()) +
          fees,
        "Shared vault equals all claims plus fees",
      );
    }
  }
  if (stage === "prepare") {
    await send("fund_test_wallet", a, [
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: taker.publicKey,
        lamports: 80_000_000,
      }),
    ]);
    await step("create_base_mint", async () =>
      String(
        await createMint(connection, payer, payer.publicKey, null, 6, baseKey),
      ),
    );
    await step("create_quote_mint", async () =>
      String(
        await createMint(connection, payer, payer.publicKey, null, 6, quoteKey),
      ),
    );
    const abase = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        base,
        payer.publicKey,
      ),
      bquote = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        quote,
        taker.publicKey,
      );
    await step("mint_base_test_tokens", () =>
      mintTo(connection, payer, base, abase.address, payer, 2_000_000n),
    );
    await step("mint_quote_test_tokens", () =>
      mintTo(connection, payer, quote, bquote.address, payer, 10_000_000n),
    );
    for (const [label, program] of [
      ["maker", a],
      ["taker", b],
    ])
      for (const [symbol, mint] of [
        ["base", base],
        ["quote", quote],
      ])
        await send(`initialize_${label}_${symbol}`, program, [
          await program.methods
            .initializeAssetBalance()
            .accountsPartial({
              ...(await custody(program, mint)),
              systemProgram: SystemProgram.programId,
            })
            .instruction(),
        ]);
    await send("deposit_maker_base", a, [
      await a.methods
        .depositAsset(bn(2_000_000))
        .accountsPartial({
          ...(await custody(a, base)),
          walletToken: abase.address,
        })
        .instruction(),
    ]);
    await send("deposit_taker_quote", b, [
      await b.methods
        .depositAsset(bn(10_000_000))
        .accountsPartial({
          ...(await custody(b, quote)),
          walletToken: bquote.address,
        })
        .instruction(),
    ]);
    await send("initialize_spot", a, [
      await a.methods
        .initializeMarket(bn(10_000), bn(1000))
        .accountsPartial({
          authority: payer.publicKey,
          adminRecord: admin,
          market: spot,
          marketFees: pda("market_fees", spot),
          baseMint: base,
          quoteMint: quote,
          vaultAuthority: pda("vault-authority", spot),
          baseVault: pda("vault", spot, base),
          quoteVault: pda("vault", spot, quote),
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
      await a.methods
        .initializeMarketMetadata(
          "smBASE",
          "smUSD",
          "Deployment smoke test - spot",
          { spot: {} },
        )
        .accountsPartial({
          authority: payer.publicKey,
          adminRecord: admin,
          market: spot,
          marketMetadata: pda("market_metadata", spot),
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
      await a.methods
        .initializeSharedBook({ spot: {} })
        .accountsPartial({
          authority: payer.publicKey,
          adminRecord: admin,
          market: spot,
          book: spotBook,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
    ]);
    await step("place_spot_ask", async () => {
      const plan = await sdk.buildSharedTrade(
        a,
        await sdk.readSharedBook(a, spot),
        payer.publicKey,
        "spot",
        "ask",
        bn(2_000_000),
        bn(1_000_000),
      );
      return a.provider.sendAndConfirm(
        new Transaction().add(...plan.instructions),
      );
    });
    await step("partial_spot_fill", async () => {
      const plan = await sdk.buildSharedTrade(
        b,
        await sdk.readSharedBook(b, spot),
        taker.publicKey,
        "spot",
        "bid",
        bn(2_000_000),
        bn(500_000),
      );
      return b.provider.sendAndConfirm(
        new Transaction().add(...plan.instructions),
      );
    });
    await send("pause_spot", a, [
      await a.methods
        .pauseMarket()
        .accountsPartial({ authority: payer.publicKey, market: spot })
        .instruction(),
    ]);
    await step("cancel_while_paused", async () => {
      const s = await sdk.readSharedBook(a, spot);
      return a.provider.sendAndConfirm(
        new Transaction().add(
          await sdk.cancelShared(
            a,
            s,
            payer.publicKey,
            sdk.sharedOrderPda(spotBook, bn(1)),
          ),
        ),
      );
    });
    equal((await ledger(a, base)).free, 1_500_000, "Maker base refunded");
    equal((await ledger(b, base)).free, 500_000, "Buyer base received");
    equal(
      (await ledger(a, quote)).free,
      1_000_000,
      "Maker quote proceeds reusable",
    );
    if (!state.closeTs) {
      state.closeTs = (await chainTime()) + 90;
      save();
    }
    const rules = fs.readFileSync(
      path.join(root, "docs/devnet/shared-smoke-rules.json"),
    );
    state.rulesUri = `https://raw.githubusercontent.com/kunal171/tidebook/${state.sourceCommit}/docs/devnet/shared-smoke-rules.json`;
    save();
    await send("initialize_prediction", a, [
      await a.methods
        .initializePredictionMarket(
          Array.from(predId),
          {
            resolver: payer.publicKey,
            fallback: null,
            closeTs: bn(state.closeTs),
            earliestResolutionTs: null,
            resolutionDelaySeconds: bn(5),
            payoutPerContract: bn(1_000_000),
            priceTick: bn(10_000),
            rulesUri: state.rulesUri,
            questionHash: Array.from(
              hash(Buffer.from(JSON.parse(rules).question)),
            ),
            rulesHash: Array.from(hash(rules)),
          },
          "SMOKE ONLY - shared wallet settlement",
          "smUSD",
        )
        .accountsPartial({
          authority: payer.publicKey,
          adminRecord: admin,
          market: prediction,
          collateralMint: quote,
          vaultAuthority: pda("vault-authority", prediction),
          collateralVault: predVault,
          marketMetadata: pda("market_metadata", prediction),
          marketFees: pda("market_fees", prediction),
          orderBook: pda("prediction_book", prediction),
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
      await a.methods
        .initializeSharedBook({ prediction: {} })
        .accountsPartial({
          authority: payer.publicKey,
          adminRecord: admin,
          market: prediction,
          book: predBook,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
      await a.methods
        .openPredictionMarket()
        .accountsPartial({
          authority: payer.publicKey,
          market: prediction,
          adminRecord: admin,
        })
        .instruction(),
    ]);
    for (const [label, program] of [
      ["maker", a],
      ["taker", b],
    ])
      await send(`initialize_${label}_position`, program, [
        await program.methods
          .initializePredictionPosition()
          .accountsPartial({
            owner: program.provider.wallet.publicKey,
            market: prediction,
            position: position(program.provider.wallet.publicKey),
            systemProgram: SystemProgram.programId,
          })
          .instruction(),
      ]);
    await send("split_using_spot_proceeds", a, [
      await a.methods
        .sharedCompleteSet(bn(1), true)
        .accountsPartial(predCustody(a))
        .instruction(),
    ]);
    await step("place_yes_ask", async () => {
      const plan = await sdk.buildSharedTrade(
        a,
        await sdk.readSharedBook(a, prediction),
        payer.publicKey,
        "yes",
        "ask",
        bn(400_000),
        bn(1),
      );
      return a.provider.sendAndConfirm(
        new Transaction().add(...plan.instructions),
      );
    });
    await step("buy_yes_same_quote_balance", async () => {
      const plan = await sdk.buildSharedTrade(
        b,
        await sdk.readSharedBook(b, prediction),
        taker.publicKey,
        "yes",
        "bid",
        bn(500_000),
        bn(1),
      );
      return b.provider.sendAndConfirm(
        new Transaction().add(...plan.instructions),
      );
    });
    const pm = await a.account.predictionMarket.fetch(prediction),
      bp = await b.account.predictionPosition.fetch(position(taker.publicKey));
    equal(pm.backingReserve, 1_000_000, "Reserved collateral");
    equal(bp.yesFree, 1, "YES buyer owns claim");
    await conserve();
    const evidence = {
      environment: "devnet",
      program: id.toBase58(),
      sourceCommit: state.sourceCommit,
      deployer: payer.publicKey.toBase58(),
      taker: taker.publicKey.toBase58(),
      baseMint: base.toBase58(),
      quoteMint: quote.toBase58(),
      spot: spot.toBase58(),
      prediction: prediction.toBase58(),
      quoteBalanceReused: sdk
        .assetBalancePda(taker.publicKey, quote)
        .toBase58(),
      closeTs: state.closeTs,
      reviewDelaySeconds: 5,
      spotPartialFill: state.steps.partial_spot_fill,
      pausedCancellation: state.steps.cancel_while_paused,
      predictionFill: state.steps.buy_yes_same_quote_balance,
      assertions: {
        sharedVaultsConserved: true,
        spotBaseRefund: "1500000",
        buyerBase: "500000",
        predictionReserve: "1000000",
        buyerYes: "1",
      },
      result:
        "Resolution criteria for YES satisfied; redemption is checked in the completion report.",
    };
    fs.writeFileSync(publicEvidence, JSON.stringify(evidence, null, 2) + "\n");
    console.log(
      "Trade checks passed. Commit/push the evidence, then run resolve with SMOKE_EVIDENCE_COMMIT.",
    );
    return;
  }
  const evidenceCommit = process.env.SMOKE_EVIDENCE_COMMIT;
  if (!/^[a-f0-9]{40}$/.test(evidenceCommit || ""))
    throw new Error(
      "Set SMOKE_EVIDENCE_COMMIT to the published evidence commit",
    );
  const evidence = fs.readFileSync(publicEvidence),
    evidenceUri = `https://raw.githubusercontent.com/kunal171/tidebook/${evidenceCommit}/docs/devnet/shared-smoke-evidence.json`;
  const remote = Buffer.from(await (await fetch(evidenceUri)).arrayBuffer());
  assert(
    hash(remote).equals(hash(evidence)),
    "Published evidence must match its exact committed bytes",
  );
  while ((await chainTime()) < state.closeTs) {
    console.log("Waiting for the published trading cutoff…");
    await pause(5000);
  }
  await send("freeze_at_cutoff", b, [
    await b.methods
      .advancePrediction(0)
      .accountsPartial({ market: prediction })
      .instruction(),
  ]);
  await send("propose_yes", a, [
    await a.methods
      .proposePrediction(
        { yes: {} },
        evidenceUri,
        Array.from(hash(evidence)),
        false,
      )
      .accountsPartial({
        resolver: payer.publicKey,
        market: prediction,
        adminRecord: admin,
      })
      .instruction(),
  ]);
  let pm = await a.account.predictionMarket.fetch(prediction);
  const mature = Number(pm.proposal.proposedAt.toString()) + 5;
  while ((await chainTime()) < mature) await pause(1000);
  await send("permissionless_finalize", b, [
    await b.methods
      .advancePrediction(2)
      .accountsPartial({ market: prediction })
      .instruction(),
  ]);
  await send("redeem_winning_yes", b, [
    await b.methods
      .redeemPrediction(bn(1), bn(0))
      .accountsPartial(predCustody(b))
      .instruction(),
  ]);
  await send("burn_losing_no", a, [
    await a.methods
      .redeemPrediction(bn(0), bn(1))
      .accountsPartial(predCustody(a))
      .instruction(),
  ]);
  pm = await a.account.predictionMarket.fetch(prediction);
  assert("resolved" in pm.status && "yes" in pm.finalOutcome);
  equal(pm.backingReserve, 0, "Reserve fully redeemed");
  equal(pm.yesSupply, 0, "YES burned");
  equal(pm.noSupply, 0, "NO burned");
  equal(await rawTokens(predVault), 0, "Question vault drained");
  await conserve();
  for (const [label, book] of [
    ["spot", spotBook],
    ["prediction", predBook],
  ]) {
    const root = await a.account.sharedBook.fetch(book);
    if (root.accruedQuoteFees.gtn(0)) {
      const destination = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        quote,
        payer.publicKey,
      );
      await send(`withdraw_${label}_fees`, a, [
        await a.methods
          .withdrawSharedFees(root.accruedQuoteFees)
          .accountsPartial({
            superAdmin: payer.publicKey,
            protocolConfig: pda("protocol_config"),
            book,
            mint: quote,
            destination: destination.address,
            vaultAuthority: sdk.assetAuthorityPda(quote),
            assetVault,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .instruction(),
      ]);
    }
  }
  for (const [label, program, key] of [
    ["maker", a, payer],
    ["taker", b, taker],
  ])
    for (const [symbol, mint] of [
      ["base", base],
      ["quote", quote],
    ]) {
      const balance = await ledger(program, mint);
      equal(balance.locked, 0, "No remaining lock");
      if (balance.free.gtn(0)) {
        const destination = await getOrCreateAssociatedTokenAccount(
          connection,
          payer,
          mint,
          key.publicKey,
        );
        await send(`withdraw_${label}_${symbol}`, program, [
          await program.methods
            .withdrawAsset(balance.free)
            .accountsPartial({
              ...(await custody(program, mint)),
              walletToken: destination.address,
            })
            .instruction(),
        ]);
      }
    }
  equal(await rawTokens(assetVault), 0, "Global quote vault empty");
  equal(await rawTokens(sdk.assetVaultPda(base)), 0, "Global base vault empty");
  await send("close_drained_spot", a, [
    await a.methods
      .closeSharedBook()
      .accountsPartial({
        authority: payer.publicKey,
        adminRecord: admin,
        market: spot,
        book: spotBook,
      })
      .instruction(),
    await a.methods
      .closeMarketMetadata()
      .accountsPartial({
        authority: payer.publicKey,
        market: spot,
        marketMetadata: pda("market_metadata", spot),
      })
      .instruction(),
    await a.methods
      .closeMarket()
      .accountsPartial({
        authority: payer.publicKey,
        market: spot,
        marketFees: pda("market_fees", spot),
        testFaucet: pda("test_faucet", spot),
        vaultAuthority: pda("vault-authority", spot),
        baseVault: pda("vault", spot, base),
        quoteVault: pda("vault", spot, quote),
        tokenProgram: TOKEN_PROGRAM_ID,
        sharedBook: spotBook,
      })
      .instruction(),
  ]);
  // Test assets have no economic value. Burn only this run's two generated
  // mints, close their empty wallet ATAs, and return the test wallet's spare SOL.
  for (const [label, key] of [
    ["maker", payer],
    ["taker", taker],
  ])
    for (const [symbol, mint] of [
      ["base", base],
      ["quote", quote],
    ]) {
      const token = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        mint,
        key.publicKey,
      );
      const amount = await rawTokens(token.address);
      if (amount > 0n)
        await step(`burn_${label}_${symbol}`, () =>
          burn(connection, key, token.address, mint, key, amount),
        );
      await step(`close_${label}_${symbol}_ata`, () =>
        closeAccount(connection, key, token.address, payer.publicKey, key),
      );
    }
  equal((await getMint(connection, base)).supply, 0, "Test base supply burned");
  equal(
    (await getMint(connection, quote)).supply,
    0,
    "Test quote supply burned",
  );
  if (!state.steps.return_test_wallet_sol) {
    const latest = await connection.getLatestBlockhash(),
      balance = await connection.getBalance(taker.publicKey);
    const tx = new Transaction({
      feePayer: taker.publicKey,
      recentBlockhash: latest.blockhash,
    }).add(
      SystemProgram.transfer({
        fromPubkey: taker.publicKey,
        toPubkey: payer.publicKey,
        lamports: 0,
      }),
    );
    const fee = (await connection.getFeeForMessage(tx.compileMessage())).value;
    if (fee !== null && balance > fee)
      await send("return_test_wallet_sol", b, [
        SystemProgram.transfer({
          fromPubkey: taker.publicKey,
          toPubkey: payer.publicKey,
          lamports: balance - fee,
        }),
      ]);
  }
  const report = {
    ...JSON.parse(evidence),
    evidenceUri,
    evidenceHash: hash(evidence).toString("hex"),
    completedAt: new Date().toISOString(),
    finalOutcome: "Yes",
    smokeRunnerCommit: gitHead(),
    testTokenSuppliesBurned: true,
    finalReserve: "0",
    globalBaseVault: "0",
    globalQuoteVault: "0",
    spotClosed: true,
    expiredUnfundedDrafts: state.expiredUnfundedDrafts ?? [],
    transactions: state.steps,
  };
  fs.writeFileSync(completion, JSON.stringify(report, null, 2) + "\n");
  state.completed = true;
  save();
  console.log(
    "PASS: shared custody, cross-market reuse, paused cancellation, resolution, redemption, fees, withdrawals and safe shutdown.",
  );
}
main()
  .then(() => {
    setTimeout(() => process.exit(0), 250);
  })
  .catch((error) => {
    let text = error.stack || String(error);
    text = text.split(rpc.toString()).join(rpc.origin + "/<redacted>");
    for (const value of [
      rpc.searchParams.get("api-key"),
      env.NEXT_PUBLIC_HELIUS_API_KEY,
    ])
      if (value) text = text.split(value).join("<redacted>");
    console.error(text);
    setTimeout(() => process.exit(1), 250);
  });
