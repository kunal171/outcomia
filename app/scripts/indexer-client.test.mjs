import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
const require = createRequire(import.meta.url);
const { Program, BN } = require("@anchor-lang/core"), { PublicKey } = require("@solana/web3.js");
const idl = JSON.parse(readFileSync(new URL("../idl/outcomia.json", import.meta.url)));
const fixtures = JSON.parse(readFileSync(new URL("../../services/indexer/tests/fixtures/account-wire.json", import.meta.url)));
function load(respond = () => { throw new Error("Unexpected HTTP"); }) {
  const cache = new Map();
  let time = 0;
  const loadFile = url => {
    const key = url.href;
    if (cache.has(key)) return cache.get(key).exports;
    if (url.pathname.endsWith(".json")) return JSON.parse(readFileSync(url, "utf8"));
    const module = { exports: {} }; cache.set(key, module);
    runInNewContext(ts.transpileModule(readFileSync(url, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, {
      module, exports: module.exports, Buffer, Response, PublicKey, AbortSignal,
      setTimeout: fn => setImmediate(fn), Date: { now: () => time += 2000 },
      process: { env: { NEXT_PUBLIC_INDEXER_ENABLED: "true" } },
      require: name => name.startsWith(".") ? loadFile(new URL(name.endsWith(".json") ? name : `${name}.ts`, url)) : require(name),
      fetch: async (_url, options) => new Response(JSON.stringify(await respond(JSON.parse(options.body))), { headers: { "content-type": "application/json" } }),
    });
    return module.exports;
  };
  return { ...loadFile(new URL("../lib/graphql/client.ts", import.meta.url)), ...loadFile(new URL("../lib/indexed-accounts.ts", import.meta.url)), ...loadFile(new URL("../lib/graphql/receipts.ts", import.meta.url)) };
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
test("GraphQL failures stay visible and do not fall back to a hidden RPC scan", async () => {
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
