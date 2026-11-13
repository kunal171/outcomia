/** JSON Ledger API boundary. Financial values remain decimal/Int64 strings;
 * no browser number participates in a command or a payout calculation. */
export type RecordValue = Record<string, unknown>;
export const templates = {
  Protocol: "Outcomia.Binary:Protocol",
  BinaryMarket: "Outcomia.Binary:BinaryMarket",
  AssetAdmission: "Outcomia.Assets:AssetAdmission",
  VaultAuthority: "Outcomia.Custody:VaultAuthority",
  AssetBalance: "Outcomia.Custody:AssetBalance",
  PositionRegistry: "Outcomia.Positions:PositionRegistry",
  MarketReserve: "Outcomia.Positions:MarketReserve",
  SettledReserve: "Outcomia.Positions:SettledReserve",
  PositionLot: "Outcomia.Positions:PositionLot",
  OrderRegistry: "Outcomia.Orders:OrderRegistry",
  OrderBook: "Outcomia.Orders:OrderBook",
  LimitOrder: "Outcomia.Orders:LimitOrder",
  ResolutionProposal: "Outcomia.Resolution:ResolutionProposal",
  FinalResolution: "Outcomia.Resolution:FinalResolution",
} as const;
export type Kind = keyof typeof templates;
export type Contract = {
  id: string;
  templateId: string;
  kind: Kind;
  data: RecordValue;
  blob?: string;
  synchronizerId?: string;
};
export type Deployment = {
  network: string;
  packageId: string;
  operator: string;
  vault: string;
  namespace: string;
  synchronizerId: string;
  trading: boolean;
};
export type Catalog = {
  deployment: Deployment;
  contracts: Contract[];
  quotes: {
    market: string;
    side: string;
    outcome: string;
    price: string;
    quantity: string;
    orderId: string;
  }[];
};
export const publicKinds: Kind[] = [
  "Protocol",
  "BinaryMarket",
  "AssetAdmission",
  "VaultAuthority",
  "PositionRegistry",
  "MarketReserve",
  "SettledReserve",
  "OrderRegistry",
  "OrderBook",
  "ResolutionProposal",
  "FinalResolution",
];
export function obj(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid ledger record.");
  return value as RecordValue;
}
export function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 16384)
    throw new Error("Invalid ledger text.");
  return value;
}
export function list(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 4096)
    throw new Error("Invalid ledger list.");
  return value;
}
export function cid(value: unknown): string {
  const v = text(value);
  if (v.length > 512 || /\s/.test(v)) throw new Error("Invalid contract ID.");
  return v;
}
export const scale = BigInt("10000000000");
export function raw(value: unknown): bigint {
  const v = text(value);
  if (!/^\d{1,28}(?:\.\d{1,10})?$/.test(v))
    throw new Error(
      "Use an exact nonnegative amount with at most 10 decimals.",
    );
  const [whole, fraction = ""] = v.split(".");
  return BigInt(whole) * scale + BigInt(fraction.padEnd(10, "0"));
}
export function amount(value: bigint): string {
  const f = (value % scale).toString().padStart(10, "0").replace(/0+$/, "");
  return `${value / scale}${f ? `.${f}` : ""}`;
}
export function integer(value: unknown): bigint {
  const v = text(value);
  if (!/^\d+$/.test(v) || BigInt(v) > BigInt("9223372036854775807"))
    throw new Error("Invalid whole-contract quantity.");
  return BigInt(v);
}
export function marketKey(data: RecordValue): string {
  const k = obj(data.key ?? data);
  return JSON.stringify([
    text(k.operator),
    text(k.protocolName),
    integer(k.marketId).toString(),
  ]);
}
export function namespace(data: RecordValue): RecordValue {
  return obj(data.key ?? data);
}
export function belongs(data: RecordValue, deployment: Deployment): boolean {
  const k = namespace(data);
  return (
    k.operator === deployment.operator &&
    k.protocolName === deployment.namespace &&
    (data.vault === undefined || data.vault === deployment.vault)
  );
}
export function templateId(d: Deployment, kind: Kind): string {
  return `${d.packageId}:${templates[kind]}`;
}
export function disclosure(c: Contract) {
  if (!c.blob)
    throw new Error("Missing contract disclosure. Refresh the market.");
  return {
    templateId: c.templateId,
    contractId: c.id,
    createdEventBlob: c.blob,
    ...(c.synchronizerId ? { synchronizerId: c.synchronizerId } : {}),
  };
}
/** Decode only active contracts from the documented v2/Console ACS envelopes.
 * Unknown response shapes are errors, never successful empty account lists. */
export function decodeContracts(value: unknown, d: Deployment): Contract[] {
  const rows = Array.isArray(value) ? value : list(obj(value).items);
  const result: Contract[] = [],
    seen = new Set<string>();
  for (const row of rows) {
    const item = obj(row);
    const entry = item.contractEntry ? obj(item.contractEntry) : item;
    const active = entry.JsActiveContract
      ? obj(entry.JsActiveContract)
      : entry.activeContract
        ? obj(entry.activeContract)
        : entry;
    const e = obj(active.createdEvent);
    const id = cid(e.contractId),
      tid = text(e.templateId);
    const kind = (Object.keys(templates) as Kind[]).find(
      (k) => templateId(d, k) === tid,
    );
    if (!kind) continue;
    if (seen.has(id)) throw new Error("Duplicate contract in ledger snapshot.");
    seen.add(id);
    const data = obj(e.createArgument);
    const identity = kind === "FinalResolution" ? obj(data.proposal) : data;
    if (
      kind === "AssetAdmission"
        ? data.operator !== d.operator
        : !belongs(identity, d)
    )
      continue;
    if (kind === "BinaryMarket" || kind === "ResolutionProposal")
      text(obj(data.terms).question);
    if (kind === "AssetBalance") {
      text(data.owner);
      raw(data.available);
    }
    if (kind === "PositionLot") {
      text(data.owner);
      integer(data.yes);
      integer(data.no);
    }
    if (kind === "LimitOrder") {
      text(data.owner);
      raw(data.price);
      integer(data.quantity);
      if (
        !["Buy", "Sell"].includes(String(data.side)) ||
        !["Yes", "No"].includes(String(data.outcome))
      )
        throw new Error("Invalid order side or outcome.");
    }
    if (
      kind === "SettledReserve" &&
      !["YesWins", "NoWins", "Invalid"].includes(String(data.outcome))
    )
      throw new Error("Invalid final outcome.");
    if (kind === "Protocol") {
      list(data.admins).forEach(text);
      integer(data.feeRevision);
      integer(data.takerFeeBps);
    }
    result.push({
      id,
      templateId: tid,
      kind,
      data,
      ...(typeof e.createdEventBlob === "string" && e.createdEventBlob
        ? { blob: e.createdEventBlob }
        : {}),
      ...(typeof (active.synchronizerId ?? item.synchronizerId) === "string"
        ? {
            synchronizerId: String(
              active.synchronizerId ?? item.synchronizerId,
            ),
          }
        : {}),
    });
  }
  return result;
}
export function single(contracts: Contract[], kind: Kind): Contract {
  const rows = contracts.filter((c) => c.kind === kind);
  if (rows.length !== 1)
    throw new Error(
      `Expected one current ${kind}. Refresh or check deployment roots.`,
    );
  return rows[0];
}
export function sameMarket(c: Contract, key: string): boolean {
  try {
    return (
      marketKey(
        c.kind === "FinalResolution" ? obj(c.data.proposal) : c.data,
      ) === key
    );
  } catch {
    return false;
  }
}
export function orderQuote(
  price: string,
  quantity: string,
  tick: string,
  lot: string,
  bps: string,
  decimals: string,
) {
  const p = raw(price),
    q = integer(quantity),
    rate = integer(bps),
    precision = integer(decimals);
  if (
    p <= BigInt(0) ||
    p >= scale ||
    q <= BigInt(0) ||
    raw(tick) <= BigInt(0) ||
    integer(lot) <= BigInt(0) ||
    p % raw(tick) !== BigInt(0) ||
    q % integer(lot) !== BigInt(0) ||
    rate > BigInt(1000) ||
    precision > BigInt(10)
  )
    throw new Error(
      "Price or quantity does not match this market's increments.",
    );
  const gross = p * q,
    unit = BigInt(10) ** (BigInt(10) - precision);
  if (gross % unit !== BigInt(0))
    throw new Error("Order amount cannot settle in this asset.");
  const fee = ((gross * rate) / BigInt(10000) / unit) * unit;
  return { gross: amount(gross), fee: amount(fee), debit: amount(gross + fee) };
}

export function sameInstrument(a: unknown, b: unknown): boolean {
  const left = obj(a),
    right = obj(b);
  return left.admin === right.admin && left.id === right.id;
}
/** UI timing is a preflight hint. Ledger choices remain authoritative. */
export function resolverEligible(
  data: RecordValue,
  party: string,
  now = Date.now(),
): boolean {
  const terms = obj(data.terms),
    earliest = Date.parse(text(terms.earliestResolutionAt ?? terms.closeAt));
  if (now < earliest) return false;
  const fallback = terms.fallback ? obj(terms.fallback) : null;
  if (party === data.creator)
    return !fallback || now < Date.parse(text(fallback.availableAt));
  return (
    !!fallback &&
    party === fallback.resolver &&
    now >= Date.parse(text(fallback.availableAt)) &&
    (!fallback.deadlineAt || now < Date.parse(text(fallback.deadlineAt)))
  );
}
