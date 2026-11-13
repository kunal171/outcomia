import { templateId } from "../../lib/canton/model.ts";
const d = {
  packageId: "a".repeat(64),
  network: "canton:testnet",
  operator: "operator",
  vault: "vault",
  namespace: "outcomia",
  synchronizerId: "sync",
  trading: true,
};
const instrument = { admin: "issuer", id: "USD" },
  key = { operator: d.operator, protocolName: d.namespace, marketId: "1" };
const terms = {
  question: "Will the booster launch twice?",
  collateral: instrument,
  priceTick: "0.01",
  quantityLot: "1",
  closeAt: "2099-01-01T00:00:00Z",
  earliestResolutionAt: null,
  fallback: null,
  resolutionDelaySeconds: "3600",
  rules: {
    yesCriteria: "Two launches",
    noCriteria: "No second launch",
    invalidCriteria: "No evidence",
    evidenceRequirements: "Official records",
    documentUri: "https://example.com/rules",
    documentSha256: "a".repeat(64),
  },
};
const c = (kind, id, data) => ({
  kind,
  id,
  templateId: templateId(d, kind),
  data,
  blob: "YmxvYg==",
});
const policy = c("Protocol", "policy", {
  operator: d.operator,
  protocolName: d.namespace,
  admins: [d.operator, "alice"],
  takerFeeBps: "25",
  feeRevision: "3",
});
const market = c("BinaryMarket", "market", {
  ...key,
  creator: "alice",
  terms,
  status: "Open",
  createdAt: "2026-01-01T00:00:00Z",
  openedAt: "2026-01-01T00:00:00Z",
});
const book = c("OrderBook", "book", {
  key,
  vault: d.vault,
  creator: "alice",
  terms,
  factory: "factory",
  assetDecimals: "6",
  orders: [],
  fees: { amount: "0", cash: null },
});
const balance = c("AssetBalance", "balance", {
  ...key,
  owner: "alice",
  vault: d.vault,
  instrument,
  factory: "factory",
  available: "5",
  cash: "cash",
});
const position = c("PositionLot", "position", {
  key,
  vault: d.vault,
  owner: "alice",
  yes: "5",
  no: "5",
});
const admission = c("AssetAdmission", "admission", {
  operator: d.operator,
  instrument,
  factory: "factory",
  assetDecimals: "6",
});
const roots = ["VaultAuthority", "PositionRegistry", "OrderRegistry"].map((k) =>
  c(k, k, {
    operator: d.operator,
    vault: d.vault,
    protocolName: d.namespace,
    accounts: [],
    marketIds: [],
  }),
);
const snapshot = {
  deployment: d,
  contracts: [policy, market, book, admission, ...roots],
  quotes: [],
};
const owned = [balance, position];
const event = (x) => ({
  contractEntry: {
    JsActiveContract: {
      createdEvent: {
        contractId: x.id,
        templateId: x.templateId,
        createArgument: x.data,
        createdEventBlob: x.blob,
      },
    },
  },
});

export {
  d,
  instrument,
  key,
  terms,
  c,
  policy,
  market,
  book,
  balance,
  position,
  admission,
  roots,
  snapshot,
  owned,
  event,
};
