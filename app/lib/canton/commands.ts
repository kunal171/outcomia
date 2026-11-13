import {
  amount,
  cid,
  integer,
  list,
  marketKey,
  obj,
  orderQuote,
  raw,
  sameMarket,
  sameInstrument,
  resolverEligible,
  single,
  templateId,
  text,
  type Catalog,
  type Contract,
  type Kind,
  type RecordValue,
} from "./model.ts";
export type Action =
  | "enroll"
  | "deposit"
  | "withdraw"
  | "split"
  | "merge"
  | "buy"
  | "sell"
  | "cancel"
  | "redeem"
  | "match"
  | "propose"
  | "fallbackPropose"
  | "correct"
  | "finalize"
  | "bind"
  | "withdrawFees"
  | "create"
  | "reserve"
  | "book"
  | "open"
  | "close"
  | "cancelDraft"
  | "setFee"
  | "setAdmins";
export type Intent = { action: Action; target: string; values?: RecordValue };
export type Command = {
  ExerciseCommand: {
    templateId: string;
    contractId: string;
    choice: string;
    choiceArgument: RecordValue;
  };
};
export type Plan = {
  command: Command;
  context: boolean;
  instrument?: RecordValue;
  dependencies: string[];
};
export function buildPlan(
  party: string,
  catalog: Catalog,
  owned: Contract[],
  intent: Intent,
): Plan {
  const d = catalog.deployment,
    v = intent.values ?? {},
    all = [
      ...new Map(
        [...catalog.contracts, ...owned].map((c) => [c.id, c]),
      ).values(),
    ];
  const target = all.find((c) => c.id === intent.target);
  if (!target) throw new Error("Contract is stale. Refresh and try again.");
  const expected: Record<Action, Kind> = {
    enroll: "AssetAdmission",
    deposit: "AssetBalance",
    withdraw: "AssetBalance",
    split: "MarketReserve",
    merge: "MarketReserve",
    buy: "OrderBook",
    sell: "OrderBook",
    cancel: "LimitOrder",
    redeem: "SettledReserve",
    match: "OrderBook",
    propose: "BinaryMarket",
    fallbackPropose: "BinaryMarket",
    correct: "ResolutionProposal",
    finalize: "ResolutionProposal",
    bind: "MarketReserve",
    withdrawFees: "OrderBook",
    create: "Protocol",
    reserve: "BinaryMarket",
    book: "BinaryMarket",
    open: "BinaryMarket",
    close: "BinaryMarket",
    cancelDraft: "BinaryMarket",
    setFee: "Protocol",
    setAdmins: "Protocol",
  };
  if (target.kind !== expected[intent.action])
    throw new Error("Action does not match this contract type.");
  const policy = single(catalog.contracts, "Protocol"),
    admins = list(policy.data.admins);
  const operator = () => {
    if (party !== d.operator) throw new Error("Operator wallet required.");
  };
  const admin = () => {
    if (!admins.includes(party))
      throw new Error("Active administrator required.");
  };
  const owner = (c: Contract) => {
    if (c.data.owner !== party)
      throw new Error("This account or position belongs to another wallet.");
  };
  const key =
    target.kind === "BinaryMarket"
      ? marketKey(target.data)
      : target.data.key
        ? marketKey(target.data)
        : "";
  const find = (kind: Kind) =>
    single(
      all.filter((c) => c.kind === kind && sameMarket(c, key)),
      kind,
    );
  const terms = target.data.terms ? obj(target.data.terms) : undefined;
  const instrument = terms
    ? obj(terms.collateral)
    : target.data.instrument
      ? obj(target.data.instrument)
      : undefined;
  const account = (accountOwner = party) =>
    single(
      owned.filter(
        (c) =>
          c.kind === "AssetBalance" &&
          c.data.owner === accountOwner &&
          instrument &&
          obj(c.data.instrument).admin === instrument.admin &&
          obj(c.data.instrument).id === instrument.id &&
          (!target.data.factory || c.data.factory === target.data.factory),
      ),
      "AssetBalance",
    );
  const lots = () => {
    const rows = owned.filter(
      (c) =>
        c.kind === "PositionLot" &&
        c.data.owner === party &&
        sameMarket(c, key),
    );
    if (!rows.length) throw new Error("No available position lots.");
    return rows.slice(0, 16);
  };
  const quantity = () => {
    const q = integer(v.quantity);
    if (
      q <= BigInt(0) ||
      !terms ||
      q % integer(terms.quantityLot) !== BigInt(0)
    )
      throw new Error("Quantity must follow this market's contract lot.");
    return q.toString();
  };
  const positive = () => {
    if (raw(v.amount) <= BigInt(0)) throw new Error("Amount must be positive.");
    return text(v.amount);
  };
  const creator = () => {
    admin();
    if (target.data.creator !== party)
      throw new Error("Market creator wallet required.");
  };
  let root = target,
    choice = "",
    args: RecordValue = {},
    context = false;
  const dependencies = new Set<string>([target.id, policy.id]);
  const use = (c: Contract) => {
    dependencies.add(c.id);
    return c.id;
  };
  const currentMarket = () => {
    const m = find("BinaryMarket");
    if (
      m.data.status !== "Open" ||
      Date.parse(text(obj(m.data.terms).closeAt)) <= Date.now()
    )
      throw new Error("Market is not open for new orders.");
    return use(m);
  };
  const approval = () => ({
    feePolicy: policy.id,
    expectedFeeRevision: text(policy.data.feeRevision),
    expectedFeeTerms: {
      takerFeeBps: text(policy.data.takerFeeBps),
      assetDecimals: text(target.data.assetDecimals),
    },
  });
  switch (intent.action) {
    case "enroll":
      root = single(catalog.contracts, "VaultAuthority");
      choice = "VaultAuthority_OpenBalance";
      args = { owner: party, admission: use(target) };
      break;
    case "deposit":
    case "withdraw": {
      if (target.kind !== "AssetBalance") throw new Error("Balance required.");
      owner(target);
      const value = positive();
      if (
        intent.action === "withdraw" &&
        raw(value) > raw(target.data.available)
      )
        throw new Error("Amount exceeds available balance.");
      choice =
        intent.action === "deposit"
          ? "AssetBalance_Deposit"
          : "AssetBalance_Withdraw";
      args = { amount: value };
      if (intent.action === "deposit")
        args.admission = use(
          single(
            catalog.contracts.filter(
              (c) =>
                c.kind === "AssetAdmission" &&
                sameInstrument(c.data.instrument, instrument) &&
                c.data.factory === target.data.factory,
            ),
            "AssetAdmission",
          ),
        );
      context = true;
      break;
    }
    case "buy":
    case "sell": {
      if (target.kind !== "OrderBook" || !terms)
        throw new Error("Order book required.");
      const q = quantity(),
        side = intent.action,
        outcome = v.outcome === "No" ? "No" : "Yes";
      const quote = orderQuote(
        text(v.price),
        q,
        text(terms.priceTick),
        text(terms.quantityLot),
        text(policy.data.takerFeeBps),
        text(target.data.assetDecimals),
      );
      args = {
        owner: party,
        market: currentMarket(),
        outcome,
        price: text(v.price),
        quantity: q,
        ...approval(),
      };
      if (side === "buy") {
        const balance = account();
        if (raw(quote.debit) > raw(balance.data.available))
          throw new Error(
            "Deposit enough collateral for the order and fee reserve.",
          );
        args.balance = use(balance);
        choice = "OrderBook_PlaceBuy";
        context = true;
      } else {
        const positions = lots();
        if (
          positions.reduce(
            (sum, c) => sum + integer(c.data[outcome === "Yes" ? "yes" : "no"]),
            BigInt(0),
          ) < integer(q)
        )
          throw new Error("Insufficient outcome contracts.");
        args.positions = positions.map(use);
        choice = "OrderBook_PlaceSell";
      }
      break;
    }
    case "cancel": {
      if (target.kind !== "LimitOrder") throw new Error("Order required.");
      owner(target);
      root = find("OrderBook");
      if (!list(root.data.orders).some((r) => obj(r).order === target.id))
        throw new Error("Order is no longer open.");
      choice = "OrderBook_Cancel";
      args = {
        owner: party,
        order: target.id,
        balance: target.data.side === "Buy" ? use(account()) : null,
      };
      context = true;
      break;
    }
    case "split":
    case "merge": {
      if (target.kind !== "MarketReserve")
        throw new Error("An unsettled reserve is required.");
      choice =
        intent.action === "split"
          ? "MarketReserve_Split"
          : "MarketReserve_Merge";
      args = { owner: party, balance: use(account()), quantity: quantity() };
      if (intent.action === "split") args.market = currentMarket();
      else args.positions = lots().map(use);
      context = true;
      break;
    }
    case "redeem": {
      if (target.kind !== "SettledReserve")
        throw new Error("Final reserve is not ready for claims.");
      const positions = lots();
      choice = "SettledReserve_Redeem";
      args = {
        owner: party,
        balance: use(account()),
        positions: positions.map(use),
      };
      context = true;
      break;
    }
    case "match": {
      operator();
      if (target.kind !== "OrderBook") throw new Error("Order book required.");
      const outcome = v.outcome === "No" ? "No" : "Yes",
        refs = list(target.data.orders).map(obj);
      const orders = refs
        .map((ref) => {
          const o = owned.find(
            (c) => c.kind === "LimitOrder" && c.id === ref.order,
          );
          if (!o) throw new Error("Incomplete matching snapshot. Refresh.");
          use(o);
          return o;
        })
        .filter((o) => o.data.outcome === outcome);
      const best = (side: string) =>
        orders
          .filter((o) => o.data.side === side)
          .sort((a, b) => {
            const priceA = raw(a.data.price),
              priceB = raw(b.data.price);
            return priceA === priceB
              ? integer(a.data.orderId) < integer(b.data.orderId)
                ? -1
                : 1
              : (side === "Buy" ? priceA > priceB : priceA < priceB)
                ? -1
                : 1;
          })[0];
      const buy = best("Buy"),
        sell = best("Sell");
      if (!buy || !sell || raw(buy.data.price) < raw(sell.data.price))
        throw new Error("No crossed orders to match.");
      choice = "OrderBook_MatchBest";
      args = {
        market: currentMarket(),
        outcome,
        buyerBalance: use(account(text(buy.data.owner))),
        sellerBalance: use(account(text(sell.data.owner))),
      };
      context = true;
      break;
    }
    case "propose":
      creator();
      if (!resolverEligible(target.data, party))
        throw new Error("Resolution is not available in this time window.");
      choice = "Binary_ProposeResolution";
      args = {
        protocol: policy.id,
        outcome: resolutionOutcome(v.outcome),
        evidence: evidence(v.evidence),
      };
      break;
    case "fallbackPropose":
      admin();
      if (
        party === target.data.creator ||
        !resolverEligible(target.data, party)
      )
        throw new Error("Fallback is not available in this time window.");
      choice = "Binary_ProposeFallback";
      args = {
        resolver: party,
        protocol: policy.id,
        outcome: resolutionOutcome(v.outcome),
        evidence: evidence(v.evidence),
      };
      break;
    case "correct":
      admin();
      if (
        !resolverEligible(target.data, party) ||
        Date.now() >= Date.parse(text(target.data.finalizableAt))
      )
        throw new Error("Correction window is closed.");
      choice = "ResolutionProposal_Correct";
      args = {
        resolver: party,
        roles: policy.id,
        replacementOutcome: resolutionOutcome(v.outcome),
        replacementEvidence: evidence(v.evidence),
      };
      break;
    case "finalize":
      operator();
      if (Date.now() < Date.parse(text(target.data.finalizableAt)))
        throw new Error("Review delay has not elapsed.");
      choice = "ResolutionProposal_Finalize";
      break;
    case "bind":
      operator();
      choice = "MarketReserve_BindResolution";
      args = { resolution: use(find("FinalResolution")) };
      break;
    case "withdrawFees":
      operator();
      choice = "OrderBook_WithdrawFees";
      args = { amount: positive() };
      if (raw(v.amount) > raw(obj(target.data.fees).amount))
        throw new Error("Amount exceeds earned fees.");
      context = true;
      break;
    case "create":
      admin();
      root = policy;
      choice = "Protocol_CreateBinary";
      args = { creator: party, terms: marketTerms(v.terms) };
      break;
    case "reserve":
    case "book": {
      creator();
      const admission = single(
        catalog.contracts.filter(
          (c) =>
            c.kind === "AssetAdmission" &&
            sameInstrument(c.data.instrument, instrument),
        ),
        "AssetAdmission",
      );
      root = single(
        catalog.contracts,
        intent.action === "reserve" ? "PositionRegistry" : "OrderRegistry",
      );
      choice =
        intent.action === "reserve"
          ? "PositionRegistry_CreateReserve"
          : "OrderRegistry_CreateBook";
      args = {
        creator: party,
        protocol: policy.id,
        market: use(target),
        admission: use(admission),
      };
      if (intent.action === "book") args.reserve = use(find("MarketReserve"));
      break;
    }
    case "open":
      creator();
      choice = "Binary_Open";
      args = { protocol: policy.id };
      break;
    case "close":
      creator();
      choice = "Binary_Close";
      args = { protocol: policy.id, reason: text(v.reason) };
      break;
    case "cancelDraft":
      if (target.data.creator !== party)
        throw new Error("Market creator wallet required.");
      choice = "Binary_CancelDraft";
      break;
    case "setFee":
      operator();
      root = policy;
      if (integer(v.amount) > BigInt(1000))
        throw new Error("Fee must be 0–1000 basis points.");
      choice = "Protocol_SetTakerFee";
      args = { replacementFeeBps: text(v.amount) };
      break;
    case "setAdmins":
      operator();
      root = policy;
      {
        const admins = list(v.admins).map(text);
        if (
          admins.length > 64 ||
          !admins.includes(party) ||
          new Set(admins).size !== admins.length
        )
          throw new Error(
            "Administrators must be unique and include the operator.",
          );
        choice = "Protocol_SetAdmins";
        args = { replacementAdmins: admins };
      }
      break;
    default:
      throw new Error("Unsupported Canton action.");
  }
  dependencies.add(root.id);
  // Only these fixed template/choice pairs can reach the wallet; forms cannot
  // choose an arbitrary target template, actAs, factory or transfer recipient.
  return {
    command: {
      ExerciseCommand: {
        templateId: templateId(d, root.kind),
        contractId: cid(root.id),
        choice,
        choiceArgument: args,
      },
    },
    context,
    instrument,
    dependencies: [...dependencies],
  };
}
function resolutionOutcome(value: unknown) {
  if (!["YesWins", "NoWins", "Invalid"].includes(String(value)))
    throw new Error("Choose YES, NO or invalid.");
  return value;
}
function evidence(value: unknown) {
  const e = obj(value);
  if (
    text(e.summary).length > 4096 ||
    !/^(https:\/\/.+|ar:\/\/.+)$/.test(text(e.documentUri)) ||
    !/^[a-f0-9]{64}$/.test(text(e.documentSha256))
  )
    throw new Error("Valid evidence URL and SHA-256 are required.");
  return e;
}
function marketTerms(value: unknown) {
  const t = obj(value);
  text(t.question);
  const r = obj(t.rules);
  text(r.yesCriteria);
  text(r.noCriteria);
  text(r.invalidCriteria);
  text(r.evidenceRequirements);
  evidence({
    summary: t.question,
    documentUri: r.documentUri,
    documentSha256: r.documentSha256,
  });
  text(t.closeAt);
  raw(t.priceTick);
  integer(t.quantityLot);
  integer(t.resolutionDelaySeconds);
  obj(t.collateral);
  return t;
}
