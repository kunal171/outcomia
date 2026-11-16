/** Anchor is the independent oracle for the Rust account decoder's wire contract. */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { rpc, owner, mint, market } from "./fixtures/multi-outcome.mjs";
const require = createRequire(import.meta.url);
const { Program, BN } = require("@anchor-lang/core"), { PublicKey } = require("@solana/web3.js");
const idl = JSON.parse(readFileSync(new URL("../idl/outcomia.json", import.meta.url)));
const program = new Program(idl, { connection: {} });
const definitions = new Map(idl.types.map(t => [t.name, t.type]));
const camel = value => value.replace(/_([a-z])/g, (_, c) => c.toUpperCase()).replace(/^./, c => c.toLowerCase());
function fields(rows) {
  return rows.length && !rows[0].name ? rows.map(value) : Object.fromEntries(rows.map(f => [camel(f.name), value(f.type)]));
}
function value(type) {
  if (typeof type === "string") {
    if (type === "pubkey") return new PublicKey(Buffer.alloc(32, 7));
    if (type === "u64") return new BN("18446744073709551615");
    if (type === "i64") return new BN("-9223372036854775808");
    if (type === "string") return "Fixture UTF-8 café";
    if (type === "bool") return true;
    if (type === "bytes") return Buffer.from([1, 2]);
    return 1;
  }
  if (type.option) return null;
  if (type.array) return Array.from({ length: type.array[1] }, () => value(type.array[0]));
  if (type.vec) return [value(type.vec)];
  const body = definitions.get(type.defined.name);
  if (body.kind === "struct") return fields(body.fields);
  const variant = body.variants[0];
  return { [camel(variant.name)]: variant.fields ? fields(variant.fields) : {} };
}
function exact(value) {
  if (BN.isBN(value)) return value.toString();
  if (value instanceof PublicKey) return value.toBase58();
  if (Array.isArray(value) || value instanceof Uint8Array) return [...value].map(exact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, exact(v)]));
  return value;
}
const records = [];
for (const account of idl.accounts) {
  const data = value({ defined: { name: account.name } });
  const bytes = await program.coder.accounts.encode(camel(account.name), data);
  records.push({ name: account.name, bytes: bytes.toString("base64"), expected: exact(data) });
}
const paths = [
  [new URL("../../services/indexer/tests/fixtures/account-wire.json", import.meta.url), `[\n${records.map(r => JSON.stringify(r)).join(",\n")}\n]\n`],
  [new URL("../../services/indexer/tests/fixtures/ui-snapshot.json", import.meta.url), JSON.stringify({ owner: owner.toBase58(), mint: mint.toBase58(), market: market.toBase58(), program: idl.address, snapshot: { context: { slot: 100 }, value: await rpc({ method: "getProgramAccounts" }) }, mintInfo: (await rpc({ method: "getAccountInfo", params: [mint.toBase58()] })).value }, null, 2) + "\n"],
];
for (const [path, content] of paths) {
  if (process.argv.includes("--write")) writeFileSync(path, content);
  else if (readFileSync(path, "utf8") !== content) throw new Error(`Stale indexer fixture: ${path.pathname}`);
}
console.log(`PASS: ${records.length} Anchor account layouts and the ephemeral UI fixture agree.`);
