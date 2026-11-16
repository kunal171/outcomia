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
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(readFileSync(new URL("../lib/indexer-client.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, {
    module, exports: module.exports, Buffer, Response, PublicKey, process: { env: { NEXT_PUBLIC_INDEXER_ENABLED: "true" } },
    require: name => name.endsWith("outcomia.json") ? idl : require(name),
    fetch: async (_url, options) => new Response(JSON.stringify(await respond(JSON.parse(options.body))), { headers: { "content-type": "application/json" } }),
  });
  return module.exports;
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
