/** Public configuration controls reads; signing programs always keep direct RPC. */
import { BN, type Program } from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
import idl from "../idl/outcomia.json";
export const INDEXER_ENABLED = process.env.NEXT_PUBLIC_INDEXER_ENABLED === "true";
const readers = new WeakSet<Program>();
export function indexedReader<T extends Program>(program: T): T { readers.add(program); return program; }
export function usesIndexer(program: Program) { return INDEXER_ENABLED && readers.has(program); }
export async function graphql<T>(query: string, variables: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
  const response = await fetch("/api/indexer/graphql", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }), cache: "no-store", signal,
  });
  const result = await response.json();
  if (!response.ok || result.errors?.length || !result.data)
    throw new Error(result.errors?.[0]?.message ?? result.error ?? "Indexed data is unavailable");
  return result.data;
}
const camel = (name: string) => name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()).replace(/^./, c => c.toLowerCase());
const definitions = new Map(idl.types.map(t => [t.name, t.type]));
type WireType = string | { option?: WireType; array?: [WireType, number]; vec?: WireType; defined?: { name: string } };
/** Convert exact JSON strings back into the existing Anchor client value types. */
export function hydrate(type: WireType, value: unknown): unknown {
  if (value === null) return null;
  if (typeof type === "string") {
    if (type === "pubkey") return new PublicKey(value as string);
    if (type === "bytes") return Buffer.from(value as number[]);
    if (["u64", "i64", "u128", "i128"].includes(type)) return new BN(value as string);
    return value;
  }
  if (type.option) return hydrate(type.option, value);
  if (type.array || type.vec) {
    const inner = type.array?.[0] ?? type.vec!;
    return (value as unknown[]).map(v => hydrate(inner, v));
  }
  if (type.defined) {
    const body = definitions.get(type.defined.name as typeof idl.types[number]["name"]) as unknown as { kind: string; fields?: Array<{ name: string; type: WireType } | WireType>; variants?: Array<{ name: string; fields?: Array<{ name: string; type: WireType } | WireType> }> };
    if (!body) throw new Error("Unsupported indexed account schema");
    const fields = (rows: NonNullable<typeof body.fields>, source: unknown) => {
      if (rows.length && !(typeof rows[0] === "object" && "name" in rows[0]))
        return rows.map((t, i) => hydrate(t as WireType, (source as unknown[])[i]));
      return Object.fromEntries((rows as { name: string; type: WireType }[]).map(f => [camel(f.name), hydrate(f.type, (source as Record<string, unknown>)[camel(f.name)])]));
    };
    if (body.kind === "struct") return fields(body.fields!, value);
    const variant = body.variants!.find(v => Object.hasOwn(value as object, camel(v.name)));
    if (!variant) throw new Error("Invalid indexed enum variant");
    return { [camel(variant.name)]: variant.fields ? fields(variant.fields, (value as Record<string, unknown>)[camel(variant.name)]) : {} };
  }
  throw new Error("Unsupported indexed field");
}
type RecordRow = { address: string; accountType: string; data: unknown };
type Page = { nodes: RecordRow[]; sync: { revision: string }; hasNextPage: boolean; endCursor: string | null };
const inflight = new Map<string, Promise<unknown>>();
function dedupe<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = inflight.get(key); if (previous) return previous as Promise<T>;
  const promise = action().finally(() => { if (inflight.get(key) === promise) inflight.delete(key); });
  inflight.set(key, promise); return promise;
}
export function indexedAccounts(program: Program) {
  if (!usesIndexer(program)) return program.account;
  return new Proxy({}, { get(_target, key: string) {
    const name = idl.accounts.find(a => camel(a.name) === key)?.name;
    if (!name) throw new Error(`Unsupported indexed account ${key}`);
    const convert = (row: RecordRow) => {
      if (row.accountType !== name) throw new Error("Indexed account type mismatch");
      return hydrate({ defined: { name } }, row.data);
    };
    return {
      fetchNullable: (address: PublicKey) => dedupe(`account:${name}:${address}`, async () => {
        const result = await graphql<{ account: RecordRow | null }>(`query Account($address:String!){account(address:$address){address accountType data}}`, { address: address.toBase58() });
        return result.account ? convert(result.account) : null;
      }),
      fetch: async (address: PublicKey) => {
        const result = await graphql<{ account: RecordRow | null }>(`query Account($address:String!){account(address:$address){address accountType data}}`, { address: address.toBase58() });
        if (!result.account) throw new Error("Indexed account was not found"); return convert(result.account);
      },
      all: (filters?: { memcmp: { offset: number; bytes: string } }[]) => dedupe(`all:${name}:${JSON.stringify(filters)}`, async () => {
        const output: { publicKey: PublicKey; account: unknown }[] = [];
        let after: string | null = null, revision: string | null = null;
        for (let count = 0; count < 100; count++) {
          const result: { accounts: Page } = await graphql(`query Accounts($type:String!,$filters:[Memcmp!],$after:String,$revision:String){accounts(accountType:$type,filters:$filters,after:$after,revision:$revision,first:500){nodes{address accountType data}sync{revision}hasNextPage endCursor}}`, { type: name, filters: filters?.map(f => f.memcmp), after, revision });
          const page = result.accounts; revision ??= page.sync.revision;
          output.push(...page.nodes.map(row => ({ publicKey: new PublicKey(row.address), account: convert(row) })));
          if (!page.hasNextPage) return output;
          if (!page.endCursor || page.endCursor === after) throw new Error("Indexed pagination did not advance");
          after = page.endCursor;
        }
        throw new Error("Indexed account result limit exceeded");
      }),
    };
  }});
}

export async function accountInfos(connection: import("@solana/web3.js").Connection, keys: PublicKey[]) {
  if (!INDEXER_ENABLED) return connection.getMultipleAccountsInfo(keys, "confirmed");
  const result = await graphql<{ rawAccounts: ({ rawBase64: string; owner: string; lamports: string } | null)[] }>(`query Raw($keys:[String!]!){rawAccounts(addresses:$keys)}`, { keys: keys.map(k => k.toBase58()) });
  if (result.rawAccounts.length !== keys.length) throw new Error("Incomplete indexed account response");
  return result.rawAccounts.map(row => {
    if (!row) return null;
    const lamports = Number(row.lamports); if (!Number.isSafeInteger(lamports)) throw new Error("Account rent exceeds safe client range");
    return { data: Buffer.from(row.rawBase64, "base64"), owner: new PublicKey(row.owner), lamports, executable: false, rentEpoch: 0 };
  });
}
export type IndexedAsset = { mint: string; tokenProgram: string; amount: string; frozen: string; decimals: number; accountCount: number; slot: string };
export function walletAssets(owner: PublicKey) {
  return dedupe(`wallet:${owner}`, () => graphql<{ walletAssets: IndexedAsset[] }>(`query Holdings($owner:String!){walletAssets(owner:$owner)}`, { owner: owner.toBase58() }).then(r => r.walletAssets));
}
