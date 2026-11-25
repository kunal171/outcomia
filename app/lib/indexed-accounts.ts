/** Anchor compatibility belongs here; GraphQL operations stay in lib/graphql. */
import { displayMetadata } from "./collateral-display";
import { readWithRpcFallback } from "./read-source";
import { BN, type Program, type AccountClient } from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
import idl from "../idl/outcomia.json";
import { INDEXER_ENABLED, dedupe } from "./graphql/client";
import {
  getAccount,
  getAccounts,
  getRawAccounts,
  type AccountRecord,
  type AccountFilter,
} from "./graphql/accounts";
import { getMarkets, MARKET_ACCOUNT_TYPES } from "./graphql/markets";
const readers = new WeakSet<Program>();
export function indexedReader<T extends Program>(program: T): T {
  readers.add(program);
  return program;
}
export function usesIndexer(program: Program) {
  return INDEXER_ENABLED && readers.has(program);
}
const camel = (name: string) =>
  name
    .replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
    .replace(/^./, (c) => c.toLowerCase());
const definitions = new Map(idl.types.map((t) => [t.name, t.type]));
type WireType =
  | string
  | {
      option?: WireType;
      array?: [WireType, number];
      vec?: WireType;
      defined?: { name: string };
    };
/** Convert exact JSON strings back into the existing Anchor client value types. */
export function hydrate(type: WireType, value: unknown): unknown {
  // A field missing entirely belongs to a newer layout than the account was
  // written with (for example a club created before club types, until it is
  // upgraded). Keep it undefined so callers can tell; never guess a value.
  if (value === null || value === undefined) return value;
  if (typeof type === "string") {
    if (type === "pubkey") return new PublicKey(value as string);
    if (type === "bytes") return Buffer.from(value as number[]);
    if (["u64", "i64", "u128", "i128"].includes(type))
      return new BN(value as string);
    return value;
  }
  if (type.option) return hydrate(type.option, value);
  if (type.array || type.vec) {
    const inner = type.array?.[0] ?? type.vec!;
    return (value as unknown[]).map((v) => hydrate(inner, v));
  }
  if (type.defined) {
    const body = definitions.get(
      type.defined.name as (typeof idl.types)[number]["name"],
    ) as unknown as {
      kind: string;
      fields?: Array<{ name: string; type: WireType } | WireType>;
      variants?: Array<{
        name: string;
        fields?: Array<{ name: string; type: WireType } | WireType>;
      }>;
    };
    if (!body) throw new Error("Unsupported indexed account schema");
    const fields = (rows: NonNullable<typeof body.fields>, source: unknown) => {
      if (rows.length && !(typeof rows[0] === "object" && "name" in rows[0]))
        return rows.map((t, i) =>
          hydrate(t as WireType, (source as unknown[])[i]),
        );
      return Object.fromEntries(
        (rows as { name: string; type: WireType }[]).map((f) => [
          camel(f.name),
          hydrate(f.type, (source as Record<string, unknown>)[camel(f.name)]),
        ]),
      );
    };
    if (body.kind === "struct") return fields(body.fields!, value);
    const variant = body.variants!.find((v) =>
      Object.hasOwn(value as object, camel(v.name)),
    );
    if (!variant) throw new Error("Invalid indexed enum variant");
    return {
      [camel(variant.name)]: variant.fields
        ? fields(
            variant.fields,
            (value as Record<string, unknown>)[camel(variant.name)],
          )
        : {},
    };
  }
  throw new Error("Unsupported indexed field");
}
export function indexedAccounts(program: Program) {
  if (!usesIndexer(program)) return program.account;
  return new Proxy(
    {},
    {
      get(_target, key: string) {
        const name = idl.accounts.find(
          (account) => camel(account.name) === key,
        )?.name;
        if (!name) throw new Error(`Unsupported indexed account ${key}`);
        const rpcAccount = (
          program.account as unknown as Record<string, AccountClient>
        )[key];
        const convert = (row: AccountRecord) => {
          if (row.accountType !== name)
            throw new Error("Indexed account type mismatch");
          const value = hydrate({ defined: { name } }, row.data);
          return name === "MarketMetadata" ? displayMetadata(value) : value;
        };
        return {
          fetchNullable: (address: PublicKey) =>
            readWithRpcFallback(
              "accounts",
              () =>
                getAccount(address.toBase58()).then((row) =>
                  row ? convert(row) : null,
                ),
              () =>
                dedupe(
                  `rpc:nullable:${program.programId}:${key}:${address}`,
                  () => rpcAccount.fetchNullable(address, "confirmed"),
                ),
            ),
          fetch: (address: PublicKey) =>
            readWithRpcFallback(
              "accounts",
              async () => {
                const row = await getAccount(address.toBase58());
                if (!row) throw new Error("Indexed account was not found");
                return convert(row);
              },
              () =>
                dedupe(
                  `rpc:account:${program.programId}:${key}:${address}`,
                  () => rpcAccount.fetch(address, "confirmed"),
                ),
            ),
          all: (filters?: { memcmp: AccountFilter }[]) =>
            dedupe(`all:${name}:${JSON.stringify(filters)}`, () =>
              readWithRpcFallback(
                "accounts",
                async () => {
                  const output: { publicKey: PublicKey; account: unknown }[] =
                    [];
                  let after: string | null = null;
                  let revision: string | null = null;
                  const getPage = MARKET_ACCOUNT_TYPES.includes(name)
                    ? getMarkets
                    : getAccounts;
                  for (let count = 0; count < 100; count++) {
                    const page = await getPage(
                      name,
                      filters?.map((filter) => filter.memcmp),
                      after,
                      revision,
                    );
                    revision ??= page.sync.revision;
                    output.push(
                      ...page.nodes.map((row) => ({
                        publicKey: new PublicKey(row.address),
                        account: convert(row),
                      })),
                    );
                    if (!page.hasNextPage) return output;
                    if (!page.endCursor || page.endCursor === after)
                      throw new Error("Indexed pagination did not advance");
                    after = page.endCursor;
                  }
                  throw new Error("Indexed account result limit exceeded");
                },
                () => rpcAccount.all(filters),
              ),
            ),
        };
      },
    },
  );
}
export async function accountInfos(
  connection: import("@solana/web3.js").Connection,
  keys: PublicKey[],
) {
  return readWithRpcFallback(
    "accounts",
    async () => {
      const rows = await getRawAccounts(keys.map((key) => key.toBase58()));
      if (rows.length !== keys.length)
        throw new Error("Incomplete indexed account response");
      return rows.map((row) => {
        if (!row) return null;
        const lamports = Number(row.lamports);
        if (!Number.isSafeInteger(lamports))
          throw new Error("Account rent exceeds safe client range");
        return {
          data: Buffer.from(row.rawBase64, "base64"),
          owner: new PublicKey(row.owner),
          lamports,
          executable: false,
          rentEpoch: 0,
        };
      });
    },
    () => connection.getMultipleAccountsInfo(keys, "confirmed"),
  );
}
