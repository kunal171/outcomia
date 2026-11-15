/** Ephemeral Solana accounts and RPC responses for local UI verification. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { loadTypeScript } from "../support/typescript.mjs";
const require = createRequire(import.meta.url),
  { BN, Program } = require("@anchor-lang/core"),
  { PublicKey, Keypair, Transaction } = require("@solana/web3.js"),
  bs58 = require("bs58");
const m = loadTypeScript(
    new URL("../../lib/multi-outcome.ts", import.meta.url),
  ),
  out = loadTypeScript(new URL("../../lib/outcomia.ts", import.meta.url)),
  shared = loadTypeScript(new URL("../../lib/shared.ts", import.meta.url));
const p = new Program(
    JSON.parse(
      readFileSync(new URL("../../idl/outcomia.json", import.meta.url)),
    ),
    { connection: {} },
  ),
  program = p.programId;
const wallet = Keypair.fromSeed(Buffer.alloc(32, 42)),
  owner = wallet.publicKey,
  maker = new PublicKey(Buffer.alloc(32, 3)),
  mint = new PublicKey(Buffer.alloc(32, 5)),
  id = Buffer.alloc(32, 8),
  market = m.multiMarketPda(id),
  bookKey = m.multiBookPda(market),
  positionKey = m.multiPositionPda(market, owner);
const zero = () => new BN(0),
  amount = (n) => new BN(n),
  records = new Map(),
  states = new Map();
async function account(name, key, value) {
  states.set(key.toBase58(), { name, value });
  const bytes = await p.coder.accounts.encode(name, value);
  records.set(key.toBase58(), {
    data: [bytes.toString("base64"), "base64"],
    executable: false,
    lamports: 10000000,
    owner: program.toBase58(),
    rentEpoch: 0,
    space: bytes.length,
  });
}
const terms = {
  resolver: owner,
  fallback: null,
  outcomeLabels: ["Red", "Blue", "Green"],
  questionHash: Array(32).fill(1),
  rulesHash: Array(32).fill(2),
  rulesUri: "https://example.com/rules",
  closeTs: amount(2000000000),
  earliestResolutionTs: null,
  resolutionDelaySeconds: amount(60),
  payoutPerContract: amount(1000000),
  priceTick: amount(10000),
  quantityLot: amount(3),
};
const marketState = {
  marketId: [...id],
  authority: owner,
  collateralMint: mint,
  collateralVault: out.deriveVaultPda(market, mint),
  metadata: out.deriveMarketMetadataPda(market),
  terms,
  resolutionPhase: { primary: {} },
  status: { open: {} },
  proposal: null,
  finalOutcome: null,
  supplies: [
    amount(6),
    amount(6),
    amount(6),
    zero(),
    zero(),
    zero(),
    zero(),
    zero(),
  ],
  backingReserve: amount(6000000),
  openOrderCount: amount(2),
  bump: 0,
};
const askKey = m.multiOrderPda(bookKey, amount(1)),
  bidKey = m.multiOrderPda(bookKey, amount(2));
const ask = {
  owner: maker,
  market,
  book: bookKey,
  orderId: amount(1),
  outcome: [0],
  side: { ask: {} },
  price: amount(400000),
  quantity: amount(3),
  remainingQuantity: amount(3),
  lockedAmount: amount(3),
  previous: null,
  next: null,
  status: { open: {} },
  bump: 0,
};
const bid = {
  ...ask,
  owner,
  orderId: amount(2),
  side: { bid: {} },
  price: amount(200000),
  lockedAmount: amount(600000),
};
const heads = Array(16).fill(null);
heads[0] = { order: bidKey, ...bid };
heads[1] = { order: askKey, ...ask };
const book = {
  market,
  authority: owner,
  heads,
  openOrderCount: amount(2),
  nextOrderId: amount(3),
  accruedCollateralFees: zero(),
  bump: 0,
};
const position = {
  market,
  owner,
  free: [
    amount(3),
    amount(3),
    amount(3),
    zero(),
    zero(),
    zero(),
    zero(),
    zero(),
  ],
  locked: Array.from({ length: 8 }, zero),
  bump: 0,
};
await account("multiOutcomeMarket", market, marketState);
await account("multiOutcomeBook", bookKey, book);
await account("multiOutcomeOrder", askKey, ask);
await account("multiOutcomeOrder", bidKey, bid);
await account("multiOutcomePosition", positionKey, position);
await account("marketMetadata", marketState.metadata, {
  market,
  baseSymbol: "OUTCOMES",
  quoteSymbol: "USDC",
  displayName: "Which colour wins?",
  kind: { prediction: {} },
  bump: 0,
});
await account("protocolConfig", out.deriveProtocolConfigPda(), {
  superAdmin: owner,
  takerFeeBps: 100,
  bump: 0,
});
await account("adminRecord", out.deriveAdminRecordPda(owner), {
  authority: owner,
  addedBy: owner,
  status: { active: {} },
  bump: 0,
});
await account("assetBalance", shared.assetBalancePda(owner, mint), {
  owner,
  mint,
  free: amount(10000000),
  locked: amount(600000),
  bump: 0,
});
const mintBytes = Buffer.alloc(82);
mintBytes.writeBigUInt64LE(100000000n, 36);
mintBytes[44] = 6;
mintBytes[45] = 1;
records.set(mint.toBase58(), {
  data: [mintBytes.toString("base64"), "base64"],
  executable: false,
  lamports: 10000000,
  owner: out.TOKEN_PROGRAM_ID.toBase58(),
  rentEpoch: 0,
  space: 82,
});
const abandonedId = Buffer.alloc(32, 19);
const abandonedBuffer = PublicKey.findProgramAddressSync(
  [Buffer.from("multi_terms"), owner.toBytes(), abandonedId],
  program,
)[0];
await account("multiOutcomeTermsBuffer", abandonedBuffer, {
  authority: owner,
  marketId: [...abandonedId],
  bytes: Buffer.from([1, 2, 3]),
  bump: 0,
});
const submissions = [];
let ledgerNow = 2000000005,
  marketMissing = false;
function setMarketMissing(value) {
  marketMissing = value;
}
function setLedgerNow(now) {
  ledgerNow = now;
}
async function setAskLadder(count) {
  const keys = Array.from({ length: count }, (_, i) =>
    m.multiOrderPda(bookKey, amount(i + 10)),
  );
  for (let i = 0; i < count; i++) {
    const value = {
      ...ask,
      orderId: amount(i + 10),
      remainingQuantity: amount(3),
      lockedAmount: amount(3),
      status: { open: {} },
      previous: keys[i - 1] ?? null,
      next: keys[i + 1] ?? null,
    };
    await account("multiOutcomeOrder", keys[i], value);
  }
  book.heads[1] = count
    ? { order: keys[0], ...states.get(keys[0].toBase58()).value }
    : null;
  book.nextOrderId = amount(count + 10);
  book.openOrderCount = amount(count);
  marketState.openOrderCount = amount(count);
  await account("multiOutcomeBook", bookKey, book);
  await account("multiOutcomeMarket", market, marketState);
}
async function rpc(request) {
  const { method, params = [] } = request;
  const context = { slot: 100 };
  switch (method) {
    case "getGenesisHash":
      return "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
    case "getAccountInfo":
      if (marketMissing && params[0] === market.toBase58()) {
        return { context, value: null };
      }
      return { context, value: records.get(params[0]) ?? null };
    case "getMultipleAccounts":
      return { context, value: params[0].map((k) => records.get(k) ?? null) };
    case "getProgramAccounts":
      return [...records]
        .filter(([, r]) => r.owner === program.toBase58())
        .filter(([, r]) =>
          (params[1]?.filters ?? []).every((f) =>
            f.memcmp
              ? Buffer.from(r.data[0], "base64")
                  .subarray(
                    f.memcmp.offset,
                    f.memcmp.offset + bs58.decode(f.memcmp.bytes).length,
                  )
                  .equals(Buffer.from(bs58.decode(f.memcmp.bytes)))
              : f.dataSize
                ? Buffer.from(r.data[0], "base64").length === f.dataSize
                : true,
          ),
        )
        .map(([pubkey, account]) => ({ pubkey, account }));
    case "getTokenAccountsByOwner":
      return { context, value: [] };
    case "getBalance":
      return { context, value: 1000000000 };
    case "getLatestBlockhash":
      return {
        context,
        value: {
          blockhash: PublicKey.default.toBase58(),
          lastValidBlockHeight: 100000,
        },
      };
    case "getBlockHeight":
      return 100;
    case "getSignatureStatuses":
      return {
        context,
        value: [
          {
            slot: 100,
            confirmations: null,
            err: null,
            confirmationStatus: "finalized",
          },
        ],
      };
    case "simulateTransaction":
      return { context, value: { err: null, logs: [], unitsConsumed: 100000 } };
    case "sendTransaction": {
      const tx = Transaction.from(Buffer.from(params[0], "base64"));
      for (const ix of tx.instructions) {
        if (!ix.programId.equals(program)) continue;
        const decoded = p.coder.instruction.decode(ix.data);
        submissions.push(decoded.name);
        if (decoded.name === "closeMultiOutcomeTerms") {
          records.delete(abandonedBuffer.toBase58());
        }
        if (decoded.name === "cancelMultiOutcomeOrder") {
          bid.status = { canceled: {} };
          bid.remainingQuantity = zero();
          bid.lockedAmount = zero();
          book.heads[0] = null;
          book.openOrderCount = amount(1);
          marketState.openOrderCount = amount(1);
          await account("multiOutcomeOrder", bidKey, bid);
        }
        if (decoded.name === "matchMultiOutcomeOrder") {
          const entry = states.get(ix.keys[4].pubkey.toBase58()),
            o = entry.value;
          const q = BN.min(decoded.data.quantity, o.remainingQuantity),
            cost = o.price.mul(q),
            fee = cost.muln(100).addn(9999).divn(10000);
          o.remainingQuantity = o.remainingQuantity.sub(q);
          o.lockedAmount = o.remainingQuantity;
          book.accruedCollateralFees = book.accruedCollateralFees.add(fee);
          if (o.remainingQuantity.isZero()) {
            o.status = { filled: {} };
            const next = o.next ? states.get(o.next.toBase58()) : null;
            if (next) {
              next.value.previous = null;
              await account(next.name, o.next, next.value);
            }
            book.heads[1] = next ? { order: o.next, ...next.value } : null;
            book.openOrderCount = book.openOrderCount.subn(1);
            marketState.openOrderCount = book.openOrderCount;
          }
          position.free[0] = position.free[0].add(q);
          await account(entry.name, ix.keys[4].pubkey, o);
        }
        if (decoded.name === "proposeMultiOutcome") {
          marketState.status = { proposed: {} };
          marketState.proposal = {
            outcome: decoded.data.outcome,
            proposedAt: amount(ledgerNow),
            evidenceUri: decoded.data.evidenceUri,
            evidenceHash: [...decoded.data.evidenceHash],
          };
        }
        if (decoded.name === "advanceMultiOutcome") {
          const action = decoded.data.action;
          if (action === 0) marketState.status = { frozen: {} };
          if (action === 1) {
            marketState.status = { frozen: {} };
            marketState.resolutionPhase = { fallback: {} };
          }
          if (action === 2) {
            marketState.status = { resolved: {} };
            marketState.finalOutcome = marketState.proposal.outcome;
          }
          if (action === 3) {
            marketState.status = { resolved: {} };
            marketState.finalOutcome = { invalid: {} };
          }
        }
        if (decoded.name === "withdrawMultiOutcomeFees")
          book.accruedCollateralFees = book.accruedCollateralFees.sub(
            decoded.data.amount,
          );
        if (decoded.name === "redeemMultiOutcome") {
          position.free = Array.from({ length: 8 }, zero);
          marketState.backingReserve = zero();
        }
      }
      await account("multiOutcomeBook", bookKey, book);
      await account("multiOutcomeMarket", market, marketState);
      await account("multiOutcomePosition", positionKey, position);
      return bs58.encode(Buffer.alloc(64, submissions.length));
    }
    default:
      throw new Error(`Unhandled fixture RPC: ${method}`);
  }
}

export {
  setMarketMissing,
  setAskLadder,
  setLedgerNow,
  wallet,
  owner,
  mint,
  market,
  marketState,
  submissions,
  rpc,
  account,
};
