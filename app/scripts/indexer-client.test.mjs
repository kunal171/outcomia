import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
const require = createRequire(import.meta.url);
const { Program, BN, AnchorProvider, utils } = require("@anchor-lang/core"), { PublicKey, Keypair, Transaction, SystemProgram, VersionedTransaction, TransactionMessage, SendTransactionError } = require("@solana/web3.js");
const idl = JSON.parse(readFileSync(new URL("../idl/outcomia.json", import.meta.url)));
const fixtures = JSON.parse(readFileSync(new URL("../../services/indexer/tests/fixtures/account-wire.json", import.meta.url)));
function load(respond = () => { throw new Error("Unexpected HTTP"); }, session = new Map(), enabled = true) {
  const cache = new Map(), events = new Map();
  let time = 0;
  const loadFile = url => {
    const key = url.href;
    if (cache.has(key)) return cache.get(key).exports;
    if (url.pathname.endsWith(".json")) return JSON.parse(readFileSync(url, "utf8"));
    const module = { exports: {} }; cache.set(key, module);
    runInNewContext(ts.transpileModule(readFileSync(url, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, {
      module, exports: module.exports, Buffer, Response, PublicKey, AbortSignal, AbortController,
      window: {
        addEventListener: (name, fn) => events.set(name, fn),
        sessionStorage: {
        getItem: key => session.get(key) ?? null,
        setItem: (key, value) => session.set(key, value),
        removeItem: key => session.delete(key),
      } },
      setTimeout: fn => { time += 2000; return setImmediate(fn); }, Date: { now: () => time },
      process: { env: { NEXT_PUBLIC_INDEXER_ENABLED: String(enabled), NEXT_PUBLIC_OUTCOMIA_PROGRAM_ID: idl.address } },
      require: name => name.startsWith(".") ? loadFile(new URL(name.endsWith(".json") ? name : `${name}.ts`, url)) : require(name),
      fetch: async (_url, options) => {
        const result = await respond(options.body ? JSON.parse(options.body) : {}, _url);
        return result instanceof Response ? result : new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
      },
    });
    return module.exports;
  };
  return { pageHide: () => events.get("pagehide")?.(), pageShow: () => events.get("pageshow")?.(), advanceClock: ms => { time += ms; }, ...loadFile(new URL("../lib/auth/client.ts", import.meta.url)), ...loadFile(new URL("../lib/read-source.ts", import.meta.url)), ...loadFile(new URL("../lib/outcomia.ts", import.meta.url)), ...loadFile(new URL("../lib/graphql/client.ts", import.meta.url)), ...loadFile(new URL("../lib/indexed-accounts.ts", import.meta.url)), ...loadFile(new URL("../lib/graphql/receipts.ts", import.meta.url)) };
}

function exact(value) {
  if (BN.isBN(value)) return value.toString();
  if (value instanceof PublicKey) return value.toBase58();
  if (Array.isArray(value) || value instanceof Uint8Array) return [...value].map(exact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, exact(v)]));
  return value;
}
test("indexed JSON hydrates every Anchor account without rounding or changing tuple shapes", () => {
  const client = load();
  for (const fixture of fixtures)
    assert.deepEqual(exact(client.hydrate({ defined: { name: fixture.name } }, fixture.expected)), fixture.expected, fixture.name);
});
test("only marked read programs use GraphQL; signed programs keep the RPC account reader", async () => {
  let calls = 0;
  const fixture = fixtures.find(f => f.name === "AssetBalance");
  const address = new PublicKey(Buffer.alloc(32, 8));
  const client = load(() => { calls++; return { data: { account: { address: address.toBase58(), accountType: fixture.name, data: fixture.expected } } }; });
  const signed = new Program(idl, { connection: {} });
  assert.equal(client.indexedAccounts(signed), signed.account);
  const reader = client.indexedReader(new Program(idl, { connection: {} }));
  const [a, b] = await Promise.all([client.indexedAccounts(reader).assetBalance.fetchNullable(address), client.indexedAccounts(reader).assetBalance.fetchNullable(address)]);
  assert.equal(calls, 1); assert.equal(a.free.toString(), "18446744073709551615"); assert.equal(b.owner.toBase58(), fixture.expected.owner);
});
test("GraphQL transport identifies unhealthy data so read adapters can choose RPC", async () => {
  const client = load(() => ({ errors: [{ message: "Account index is warming or stale" }] }));
  await assert.rejects(client.graphql("{syncStatus{ready}}"), /warming or stale/);
});


test("a delayed indexed receipt blocks duplicate sends and requires review when it catches up", async () => {
  let status = "PENDING_INDEXING", calls = 0;
  const client = load(() => { calls++; return {data:{transaction:{status}}}; });
  const owner = new PublicKey(Buffer.alloc(32, 9));
  await assert.rejects(client.waitForIndexedTransaction(owner, "signature"), /Do not resubmit/);
  assert.ok(calls > 1);
  await assert.rejects(client.checkPendingTransaction(owner), /Do not resubmit/);
  status = "CONFIRMED_INDEXED";
  await assert.rejects(client.checkPendingTransaction(owner), /Refresh and review/);
  await client.checkPendingTransaction(owner);
});

test("pending receipts survive page reloads and remain isolated by wallet", async () => {
  const session = new Map();
  let status = "PENDING_INDEXING";
  const respond = () => ({ data: { transaction: { status } } });
  const owner = new PublicKey(Buffer.alloc(32, 10));
  await assert.rejects(load(respond, session).waitForIndexedTransaction(owner, "reload-signature"), /Do not resubmit/);
  const reloaded = load(respond, session);
  await assert.rejects(reloaded.checkPendingTransaction(owner), /Do not resubmit/);
  await reloaded.checkPendingTransaction(new PublicKey(Buffer.alloc(32, 11)));
  status = "FAILED";
  await assert.rejects(reloaded.checkPendingTransaction(owner), /previous transaction failed/);
  assert.equal(session.size, 0);
  await load(respond, session).checkPendingTransaction(owner);
});

test("wallet sends share one receipt guard across forms and retain timed-out signatures", async () => {
  let status = "PENDING_INDEXING", sends = 0;
  const client = load(() => ({ data: { transaction: { status } } }));
  const owner = new PublicKey(Buffer.alloc(32, 12));
  let release;
  const signing = new Promise(resolve => { release = resolve; });
  const first = client.sendWithIndexedReceipt(owner, async () => {
    sends++;
    await signing;
    return "guarded-signature";
  });
  await assert.rejects(client.sendWithIndexedReceipt(owner, async () => { sends++; }), /still pending/);
  release();
  await assert.rejects(first, /Do not resubmit/);
  await assert.rejects(client.sendWithIndexedReceipt(owner, async () => { sends++; }), /Do not resubmit/);
  assert.equal(sends, 1);
  status = "CONFIRMED_INDEXED";
  await assert.rejects(client.sendWithIndexedReceipt(owner, async () => { sends++; }), /Refresh and review/);
  assert.equal(await client.sendWithIndexedReceipt(owner, async () => { sends++; return "next-signature"; }), "next-signature");
  assert.equal(sends, 2);
});

test("all signing programs apply the receipt guard and disabled rollout preserves direct sending", async () => {
  const original = AnchorProvider.prototype.sendAndConfirm;
  let sends = 0;
  const sentTransaction = {};
  AnchorProvider.prototype.sendAndConfirm = async function (transaction) {
    assert.ok(this instanceof AnchorProvider);
    assert.equal(transaction, sentTransaction);
    sends++;
    return "provider-signature";
  };
  try {
    const owner = new PublicKey(Buffer.alloc(32, 13));
    const client = load(() => ({ data: { transaction: { status: "PENDING_INDEXING" } } }));
    const program = client.getOutcomiaProgram({}, { publicKey: owner });
    await assert.rejects(program.provider.sendAndConfirm(sentTransaction), /Do not resubmit/);
    await assert.rejects(program.provider.sendAndConfirm(sentTransaction), /Do not resubmit/);
    assert.equal(sends, 1);
    const disabled = load(undefined, new Map(), false).getOutcomiaProgram({}, { publicKey: owner });
    assert.equal(await disabled.provider.sendAndConfirm(sentTransaction), "provider-signature");
    assert.equal(sends, 2);
  } finally {
    AnchorProvider.prototype.sendAndConfirm = original;
  }
});

test("account reads fall back on outages, use a cooldown and recover to GraphQL", async () => {
  let healthy = false, queries = 0, reads = 0;
  const fixture = fixtures.find(f => f.name === "AssetBalance");
  const address = new PublicKey(Buffer.alloc(32, 14));
  const client = load(() => {
    queries++;
    if (!healthy) return new Response("down", { status: 503 });
    return { data: { account: { address: address.toBase58(), accountType: fixture.name, data: fixture.expected } } };
  });
  const program = client.indexedReader(new Program(idl, { connection: {} }));
  program.account.assetBalance.fetchNullable = async (_address, commitment) => {
    reads++; assert.equal(commitment, "confirmed"); return { source: "rpc" };
  };
  const account = client.indexedAccounts(program).assetBalance;
  assert.equal((await account.fetchNullable(address)).source, "rpc");
  assert.equal(client.hasRpcFallback(), true);
  await account.fetchNullable(address);
  assert.equal(queries, 1); assert.equal(reads, 2);
  healthy = true;
  client.advanceClock(15001);
  const recovered = await account.fetchNullable(address);
  assert.equal(recovered.free.toString(), fixture.expected.free);
  assert.equal(queries, 2); assert.equal(reads, 2);
  assert.equal(client.hasRpcFallback(), false);
});

test("stale data triggers RPC but valid nulls, invalid filters and aborts do not", async () => {
  const owner = new PublicKey(Buffer.alloc(32, 15));
  for (const [response, fallback] of [
    [{ errors: [{ message: "Account index is warming or stale" }] }, true],
    [{ data: { account: null } }, false],
    [{ errors: [{ message: "Invalid account filter" }] }, false],
  ]) {
    let calls = 0;
    const client = load(() => response);
    const reader = client.indexedReader(new Program(idl, { connection: {} }));
    reader.account.assetBalance.fetchNullable = async () => { calls++; return "rpc"; };
    const result = client.indexedAccounts(reader).assetBalance.fetchNullable(owner);
    if (response.errors && !fallback) await assert.rejects(result, /Invalid account filter/);
    else assert.equal(await result, fallback ? "rpc" : null);
    assert.equal(calls, fallback ? 1 : 0);
  }
  const client = load(() => { throw new Error("cancelled"); });
  const signal = AbortSignal.abort();
  let reads = 0;
  await assert.rejects(client.readWithRpcFallback("accounts", () => client.graphql("{}", {}, signal), async () => { reads++; }), /cancelled/);
  assert.equal(reads, 0);
});

test("an interrupted indexed page is discarded before the complete RPC query", async () => {
  const fixture = fixtures.find(f => f.name === "AssetBalance");
  const address = new PublicKey(Buffer.alloc(32, 16));
  const filters = [{ memcmp: { offset: 8, bytes: address.toBase58() } }];
  let queries = 0, reads = 0;
  const client = load(() => ++queries === 1 ? {
    data: { accounts: {
      nodes: [{ address: address.toBase58(), accountType: fixture.name, data: fixture.expected }],
      sync: { revision: "1" }, hasNextPage: true, endCursor: address.toBase58(),
    } },
  } : new Response("down", { status: 503 }));
  const reader = client.indexedReader(new Program(idl, { connection: {} }));
  reader.account.assetBalance.all = async supplied => {
    reads++; assert.equal(supplied, filters); return [{ source: "complete RPC result" }];
  };
  const result = await client.indexedAccounts(reader).assetBalance.all(filters);
  assert.equal(result.length, 1); assert.equal(result[0].source, "complete RPC result");
  assert.equal(queries, 2); assert.equal(reads, 1);
});

test("raw accounts and token holdings use RPC during outages without rounding", async () => {
  const client = load(() => new Response("down", { status: 503 }));
  const address = new PublicKey(Buffer.alloc(32, 17));
  let raw = 0, tokens = 0;
  const expected = [{ data: Buffer.from([1]), owner: address, lamports: 1 }];
  const connection = {
    getMultipleAccountsInfo: async (keys, level) => {
      raw++; assert.equal(keys[0], address); assert.equal(level, "confirmed"); return expected;
    },
    getParsedTokenAccountsByOwner: async () => {
      tokens++; return { value: [{ account: { data: { parsed: { info: { tokenAmount: { amount: "9007199254740993" } } } } } }] };
    },
  };
  assert.equal(await client.accountInfos(connection, [address]), expected);
  assert.equal((await client.getOwnedTokenBalance(connection, address, address)).toString(), "9007199254740993");
  assert.equal(raw, 1); assert.equal(tokens, 1);
});

test("receipt outages use confirmed RPC status; missing/processed status never clears a pending send", async () => {
  const owner = new PublicKey(Buffer.alloc(32, 18));
  const client = load(() => new Response("down", { status: 503 }));
  let status = { err: null, confirmationStatus: "processed" }, sends = 0;
  const connection = { getSignatureStatuses: async () => ({ value: [status] }) };
  await assert.rejects(client.sendWithIndexedReceipt(owner, async () => { sends++; return "rpc-receipt"; }, connection), /Do not resubmit/);
  await assert.rejects(client.sendWithIndexedReceipt(owner, async () => { sends++; }, connection), /Do not resubmit/);
  assert.equal(sends, 1);
  status = { err: { InstructionError: [0, "Custom"] }, confirmationStatus: "processed" };
  await assert.rejects(client.checkPendingTransaction(owner, connection), /Do not resubmit/);
  status = null;
  await assert.rejects(client.checkPendingTransaction(owner, connection), /Do not resubmit/);
  status = { err: null, confirmationStatus: "confirmed" };
  await assert.rejects(client.checkPendingTransaction(owner, connection), /Refresh and review/);
  assert.equal(await client.sendWithIndexedReceipt(owner, async () => { sends++; return "next-rpc-receipt"; }, connection), "next-rpc-receipt");
  assert.equal(sends, 2);
});

test("unreachable or malformed services fall back and RPC failures remain errors", async () => {
  for (const respond of [() => { throw new Error("network offline"); }, () => ({}), () => null]) {
    const client = load(respond);
    let calls = 0;
    const result = await client.readWithRpcFallback("accounts", () => client.graphql("{}"), async () => { calls++; return "rpc"; });
    assert.equal(result, "rpc"); assert.equal(calls, 1);
    assert.equal(client.hasRpcFallback(), true);
    await assert.rejects(client.readWithRpcFallback("accounts", () => client.graphql("{}"), async () => { throw new Error("RPC also down"); }), /RPC also down/);
  }
});

test("only one indexed recovery probe runs while other readers wait", async () => {
  const client = load(() => ({}));
  await client.readWithRpcFallback("accounts", () => client.graphql("{}"), async () => "rpc");
  client.advanceClock(15001);
  let release, probes = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const first = client.readWithRpcFallback("accounts", async () => { probes++; await gate; return "first"; }, async () => "rpc");
  const second = client.readWithRpcFallback("accounts", async () => { probes++; return "second"; }, async () => "rpc");
  assert.equal(probes, 1);
  release();
  assert.equal(await first, "first"); assert.equal(await second, "second");
  assert.equal(client.hasRpcFallback(), false);
});

test("page navigation aborts reads without falling back and page restoration resumes them", async () => {
  let release, rpc = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const client = load(async () => { await pending; return { data: { ok: true } }; });
  const read = client.readWithRpcFallback("accounts", () => client.graphql("{}"), async () => { rpc++; });
  client.pageHide();
  release();
  await assert.rejects(read);
  assert.equal(rpc, 0); assert.equal(client.hasRpcFallback(), false);
  client.pageShow();
  assert.equal((await client.graphql("{}")).ok, true);
});

test("unavailable wallet authentication is distinguishable from rejection and never returns a user", async () => {
  const unavailable = load(() => new Response("down", { status: 503 }));
  await assert.rejects(unavailable.callWalletAuth("me"), error => error instanceof unavailable.IndexerUnavailableError);
  const rejected = load(() => new Response(JSON.stringify({ error: "Signature rejected" }), { status: 401 }));
  await assert.rejects(rejected.callWalletAuth("verify", {}), error =>
    !(error instanceof rejected.IndexerUnavailableError) && /Signature rejected/.test(error.message));
  const recovered = load(() => ({ id: "id", wallet: "wallet" }));
  assert.equal((await recovered.callWalletAuth("me")).id, "id");
});

function realSigningFixture(client, sendRaw, overrides = {}) {
  const payer = Keypair.fromSeed(Buffer.alloc(32, 30));
  const blockhash = new PublicKey(Buffer.alloc(32, 31)).toBase58();
  let signs = 0;
  const connection = {
    getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 100 }),
    getSignatureStatuses: async () => ({ context: { slot: 100 }, value: [null] }),
    getBlockHeight: async () => 50,
    sendRawTransaction: sendRaw,
    confirmTransaction: async () => ({ context: { slot: 100 }, value: { err: null } }),
    ...overrides,
  };
  const wallet = { publicKey: payer.publicKey, signTransaction: async tx => { signs++; if (tx instanceof VersionedTransaction) tx.sign([payer]); else tx.partialSign(payer); return tx; } };
  const program = client.getOutcomiaProgram(connection, wallet);
  const transaction = () => new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: new PublicKey(Buffer.alloc(32, 32)), lamports: 1 }));
  return { owner: payer.publicKey, program, transaction, connection, signs: () => signs };
}

test("broadcast reply loss and confirmation timeout persist the signed signature before another send", async () => {
  for (const stage of ["broadcast", "confirmation"]) {
    const storage = new Map();
    const client = load(() => ({ data: { transaction: { status: "PENDING_INDEXING" } } }), storage);
    let sends = 0, signature;
    const fixture = realSigningFixture(client, async raw => {
      sends++;
      signature = utils.bytes.bs58.encode(VersionedTransaction.deserialize(raw).signatures[0]);
      if (stage === "broadcast") throw new Error("Network reply lost");
      return signature;
    }, { confirmTransaction: async () => { throw new Error("Confirmation timed out"); } });
    await assert.rejects(fixture.program.provider.sendAndConfirm(fixture.transaction()), /Do not resubmit/);
    const saved = JSON.parse([...storage.values()][0]);
    assert.equal(saved.signature, signature); assert.equal(saved.lastValidBlockHeight, 100);
    assert.equal(sends, 1); assert.equal(fixture.signs(), 1);
    const reloaded = load(() => ({ data: { transaction: { status: "PENDING_INDEXING" } } }), storage);
    const second = realSigningFixture(reloaded, async () => { sends++; });
    await assert.rejects(second.program.provider.sendAndConfirm(second.transaction()), /Do not resubmit/);
    assert.equal(sends, 1); assert.equal(second.signs(), 0);
  }
});

test("only an absent signature past its known finalized expiry can release an ambiguous send", async () => {
  const storage = new Map();
  const client = load(() => ({ data: { transaction: { status: "PENDING_INDEXING" } } }), storage);
  let height = 50, status = null;
  const fixture = realSigningFixture(client, async () => { throw new Error("Unknown broadcast result"); }, {
    getBlockHeight: async () => height,
    getSignatureStatuses: async () => ({ context: { slot: 100 }, value: [status] }),
  });
  await assert.rejects(fixture.program.provider.sendAndConfirm(fixture.transaction()), /Do not resubmit/);
  await assert.rejects(client.checkPendingTransaction(fixture.owner, fixture.connection), /Do not resubmit/);
  height = 101;
  status = { err: null, confirmationStatus: "processed" };
  await assert.rejects(client.checkPendingTransaction(fixture.owner, fixture.connection), /Do not resubmit/);
  fixture.connection.getSignatureStatuses = async () => ({ context: { slot: 100 }, value: [] });
  await assert.rejects(client.checkPendingTransaction(fixture.owner, fixture.connection), /Do not resubmit/);
  fixture.connection.getSignatureStatuses = async () => ({ context: { slot: 100 }, value: [null] });
  await assert.rejects(client.checkPendingTransaction(fixture.owner, fixture.connection), /expired without confirmation.*Refresh and review/);
  assert.equal(storage.size, 0);
});

test("preflight rejection releases the guard and confirmation retry never rebroadcasts", async () => {
  const storage = new Map();
  const rejected = load(() => ({ data: { transaction: { status: "CONFIRMED_INDEXED" } } }), storage);
  const preflight = realSigningFixture(rejected, async () => { throw new SendTransactionError({ action: "simulate", signature: "", transactionMessage: "Insufficient funds" }); });
  await assert.rejects(preflight.program.provider.sendAndConfirm(preflight.transaction()), /Simulation failed/);
  assert.equal(storage.size, 0);
  let sends = 0, confirmations = 0;
  const successful = realSigningFixture(rejected, async raw => {
    sends++; return utils.bytes.bs58.encode(VersionedTransaction.deserialize(raw).signatures[0]);
  }, { confirmTransaction: async () => {
    confirmations++;
    if (confirmations === 1) { const error = new Error("Temporary timeout"); error.name = "TimeoutError"; throw error; }
    return { context: { slot: 100 }, value: { err: null } };
  } });
  await successful.program.provider.sendAndConfirm(successful.transaction());
  assert.equal(sends, 1); assert.equal(confirmations, 2); assert.equal(storage.size, 0);
});

test("an RPC signature mismatch retains the actual signed transaction", async () => {
  const storage = new Map();
  const client = load(() => ({ data: { transaction: { status: "PENDING_INDEXING" } } }), storage);
  let signed;
  const fixture = realSigningFixture(client, async raw => {
    signed = utils.bytes.bs58.encode(VersionedTransaction.deserialize(raw).signatures[0]);
    return "different-signature";
  });
  await assert.rejects(fixture.program.provider.sendAndConfirm(fixture.transaction()), /Do not resubmit/);
  assert.equal(JSON.parse([...storage.values()][0]).signature, signed);
});

test("unknown blockhash expiry stays guarded and batch sends retain the same protection", async () => {
  const storage = new Map();
  const client = load(() => ({ data: { transaction: { status: "PENDING_INDEXING" } } }), storage);
  const fixture = realSigningFixture(client, async () => { throw new Error("Broadcast response lost"); }, { getBlockHeight: async () => 100000 });
  const prepared = fixture.transaction();
  prepared.recentBlockhash = new PublicKey(Buffer.alloc(32, 33)).toBase58();
  await assert.rejects(fixture.program.provider.sendAndConfirm(prepared), /Do not resubmit/);
  assert.equal(JSON.parse([...storage.values()][0]).lastValidBlockHeight, undefined);
  await assert.rejects(client.checkPendingTransaction(fixture.owner, fixture.connection), /Do not resubmit/);

  const healthy = load(() => ({ data: { transaction: { status: "FINALIZED_INDEXED" } } }));
  let sends = 0;
  const batch = realSigningFixture(healthy, async raw => {
    sends++; return utils.bytes.bs58.encode(VersionedTransaction.deserialize(raw).signatures[0]);
  });
  const tx1 = batch.transaction(), tx2 = batch.transaction();
  tx2.add(SystemProgram.transfer({ fromPubkey: batch.owner, toPubkey: new PublicKey(Buffer.alloc(32, 34)), lamports: 2 }));
  const signatures = await batch.program.provider.sendAll([{ tx: tx1 }, { tx: tx2 }]);
  assert.equal(signatures.length, 2); assert.equal(sends, 2);
});

test("versioned transactions keep their signed identity and wallet rejection creates no pending send", async () => {
  const storage = new Map();
  const client = load(() => ({ data: { transaction: { status: "FINALIZED_INDEXED" } } }), storage);
  let sends = 0;
  const fixture = realSigningFixture(client, async raw => {
    sends++; return utils.bytes.bs58.encode(VersionedTransaction.deserialize(raw).signatures[0]);
  });
  const blockhash = new PublicKey(Buffer.alloc(32, 35)).toBase58();
  const message = new TransactionMessage({
    payerKey: fixture.owner, recentBlockhash: blockhash,
    instructions: fixture.transaction().instructions,
  }).compileToV0Message();
  await fixture.program.provider.sendAndConfirm(new VersionedTransaction(message), [], {
    commitment: "confirmed", preflightCommitment: "confirmed",
    blockhash: { blockhash, lastValidBlockHeight: 100 },
  });
  assert.equal(sends, 1); assert.equal(storage.size, 0);
  fixture.program.provider.wallet.signTransaction = async () => { throw new Error("Rejected by wallet"); };
  await assert.rejects(fixture.program.provider.sendAndConfirm(fixture.transaction()), /Rejected by wallet/);
  assert.equal(sends, 1); assert.equal(storage.size, 0);
});

test("pending signatures saved by the earlier client keep their retry protection", async () => {
  const owner = new PublicKey(Buffer.alloc(32, 36));
  const storage = new Map([[`outcomia:pending-indexed-transaction:${owner}`, "legacy-signature"]]);
  let status = "PENDING_INDEXING";
  const client = load(() => ({ data: { transaction: { status } } }), storage);
  await assert.rejects(client.checkPendingTransaction(owner), /Do not resubmit/);
  status = "FINALIZED_INDEXED";
  await assert.rejects(client.checkPendingTransaction(owner), /Refresh and review/);
  assert.equal(storage.size, 0);
});
