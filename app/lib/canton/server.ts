/** Server-only public discovery. No party argument, user credentials, generic
 * proxy path or command submission is accepted by this service. */
import {
  decodeContracts,
  disclosure,
  list,
  marketKey,
  obj,
  publicKinds,
  sameInstrument,
  single,
  templateId,
  text,
  type Catalog,
  type Contract,
  type Deployment,
} from "./model.ts";
export function deployment(env: NodeJS.ProcessEnv): Deployment | null {
  const packageId = env.CANTON_PACKAGE_ID,
    operator = env.CANTON_OPERATOR_PARTY,
    vault = env.CANTON_VAULT_PARTY,
    namespace = env.CANTON_PROTOCOL_NAME,
    synchronizerId = env.CANTON_SYNCHRONIZER_ID;
  if (
    !packageId ||
    !operator ||
    !vault ||
    !namespace ||
    !synchronizerId ||
    !env.CANTON_JSON_API_URL ||
    !env.CANTON_CATALOG_TOKEN
  )
    return null;
  if (!/^[a-f0-9]{64}$/.test(packageId) || operator === vault)
    throw new Error("Invalid Canton deployment configuration.");
  return {
    packageId,
    operator,
    vault,
    namespace,
    synchronizerId,
    network: env.NEXT_PUBLIC_CANTON_NETWORK_ID ?? "canton:testnet",
    trading: env.CANTON_TRADING_ENABLED === "true",
  };
}
export function endpoint(value: string): URL {
  const u = new URL(value);
  if (
    u.username ||
    u.password ||
    (u.protocol !== "https:" &&
      !(
        u.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(u.hostname)
      ))
  )
    throw new Error("Invalid Canton service URL.");
  return u;
}
export async function readJson(response: Response): Promise<unknown> {
  if (!response.ok)
    throw new Error("Canton service is unavailable. Refresh and try again.");
  const body = await response.text();
  if (body.length > 3000000) throw new Error("Canton snapshot is too large.");
  return JSON.parse(body);
}
export async function catalog(
  env: NodeJS.ProcessEnv,
  transport: typeof fetch = fetch,
): Promise<Catalog | null> {
  const d = deployment(env);
  if (!d) return null;
  const base = endpoint(env.CANTON_JSON_API_URL!);
  const headers = {
    authorization: `Bearer ${env.CANTON_CATALOG_TOKEN}`,
    "content-type": "application/json",
  };
  const request = (path: string, body?: unknown) =>
    transport(new URL(path, base), {
      method: body ? "POST" : "GET",
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    }).then(readJson);
  const offset = obj(await request("/v2/state/ledger-end")).offset;
  if (!/^[0-9]+$/.test(String(offset)))
    throw new Error("Invalid ledger offset.");
  const kinds = [...publicKinds, "LimitOrder"] as const;
  const raw = await request("/v2/state/active-contracts", {
    eventFormat: {
      filtersByParty: {
        [d.operator]: {
          cumulative: kinds.map((k) => ({
            identifierFilter: {
              TemplateFilter: {
                value: {
                  templateId: templateId(d, k),
                  includeCreatedEventBlob: true,
                },
              },
            },
          })),
        },
      },
      verbose: true,
    },
    activeAtOffset: offset,
  });
  const all = decodeContracts(raw, d);
  single(all, "Protocol");
  single(all, "VaultAuthority");
  single(all, "PositionRegistry");
  single(all, "OrderRegistry");
  const orders = all.filter((c) => c.kind === "LimitOrder");
  for (const book of all.filter((c) => c.kind === "OrderBook"))
    for (const ref of list(book.data.orders))
      if (
        !orders.some(
          (o) =>
            o.id === obj(ref).order &&
            marketKey(o.data) === marketKey(book.data),
        )
      )
        throw new Error("Incomplete order-book snapshot.");
  return {
    deployment: d,
    contracts: all
      .filter((c) => publicKinds.includes(c.kind))
      .map((c) => {
        disclosure(c);
        return c;
      }),
    quotes: orders.map((c) => ({
      market: marketKey(c.data),
      side: text(c.data.side),
      outcome: text(c.data.outcome),
      price: text(c.data.price),
      quantity: text(c.data.quantity),
      orderId: text(c.data.orderId),
    })),
  };
}
/** Registry-specific context stays behind an explicitly configured read-only
 * provider. It supplies current factory prerequisites;
 * it cannot approve or execute any transaction. Live compatibility is deployment work. */
export async function registryContext(
  env: NodeJS.ProcessEnv,
  input: unknown,
  transport: typeof fetch = fetch,
) {
  const d = deployment(env);
  if (!d?.trading || !env.CANTON_REGISTRY_CONTEXT_URL)
    throw new Error("Canton transactions are not configured.");
  const request = obj(input);
  const party = text(request.party),
    action = text(request.action);
  if (
    ![
      "deposit",
      "withdraw",
      "buy",
      "sell",
      "split",
      "merge",
      "cancel",
      "match",
      "redeem",
      "withdrawFees",
    ].includes(action) ||
    party === d.vault
  )
    throw new Error("Invalid context request.");
  const instrument = obj(request.instrument);
  text(instrument.admin);
  text(instrument.id);
  const command = obj(request.command),
    exercise = obj(command.ExerciseCommand);
  if (!text(exercise.templateId).startsWith(`${d.packageId}:`))
    throw new Error("Foreign command context.");
  const args = obj(exercise.choiceArgument);
  if (args.owner !== undefined && args.owner !== party)
    throw new Error("Context owner mismatch.");
  const response = await transport(endpoint(env.CANTON_REGISTRY_CONTEXT_URL), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(env.CANTON_REGISTRY_CONTEXT_TOKEN
        ? { authorization: `Bearer ${env.CANTON_REGISTRY_CONTEXT_TOKEN}` }
        : {}),
    },
    body: JSON.stringify({
      party,
      action,
      instrument,
      contractIds: list(request.contractIds).map(text),
      command: obj(request.command),
      network: d.network,
    }),
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  }).then(readJson);
  const value = obj(response);
  if (
    value.party !== party ||
    value.network !== d.network ||
    !sameInstrument(value.instrument, instrument)
  )
    throw new Error("Registry context identity mismatch.");
  obj(value.extraArgs);
  list(value.disclosedContracts);
  return value;
}
