import {
  amount,
  cid,
  integer,
  list,
  marketKey,
  factoryRefKey,
  interfaceId,
  obj,
  orderQuote,
  raw,
  sameMarket,
  scale,
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
  | "clearDeparted"
  | "redeem"
  | "match"
  | "matchComplement"
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
  | "setAdmins"
  | "factoryCreate"
  | "factoryClose"
  | "factoryPropose"
  | "createInviteList"
  | "setInvites"
  | "createClub"
  | "clubInvite"
  | "clubAccept"
  | "clubDecline"
  | "clubRevoke"
  | "clubClear"
  | "clubPolicy"
  | "clubSetAdmin"
  | "clubRemove"
  | "clubLeave"
  | "clubNominate"
  | "clubAcceptOwnership"
  | "setClubRules"
  | "clubApplyRules"
  | "clubSetListing"
  | "clubCloseListing"
  | "clubVerifyListing"
  | "clubRequestJoin"
  | "clubApproveRequest"
  | "clubCloseRequest"
  | "clubJoinOpen"
  | "clubSetShare"
  | "clubWithdrawFees";
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
/** Inputs: a verified party, one current catalog, wallet-visible private contracts
 * and a UI intent. Rejects stale/ambiguous roots, unauthorized roles, ownership
 * mismatches and invalid money/increments. Returns one fixed choice plus the
 * disclosure dependencies; registry preparation and signing happen separately.
 * Ledger checks remain authoritative if state/time changes after this preflight.
 */
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
    clearDeparted: "LimitOrder",
    redeem: "SettledReserve",
    match: "OrderBook",
    matchComplement: "OrderBook",
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
    factoryCreate: "OutcomiaMarketFactory",
    factoryClose: "BinaryMarket",
    factoryPropose: "BinaryMarket",
    createInviteList: "OutcomiaMarketFactory",
    setInvites: "InviteListPolicy",
    createClub: "ClubRegistry",
    clubInvite: "Club",
    clubAccept: "Club",
    clubDecline: "Club",
    clubRevoke: "Club",
    clubClear: "Club",
    clubPolicy: "Club",
    clubSetAdmin: "Club",
    clubRemove: "Club",
    clubLeave: "Club",
    clubNominate: "Club",
    clubAcceptOwnership: "Club",
    setClubRules: "ClubRegistry",
    clubApplyRules: "Club",
    clubSetListing: "Club",
    clubCloseListing: "Club",
    clubVerifyListing: "Club",
    clubRequestJoin: "Club",
    clubApproveRequest: "Club",
    clubCloseRequest: "Club",
    clubJoinOpen: "Club",
    clubSetShare: "OrderBook",
    clubWithdrawFees: "OrderBook",
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
  /** Every indexed order of the target book, from wallet-visible contracts. */
  const snapshotOrders = () =>
    list(target.data.orders)
      .map(obj)
      .map((ref) => {
        const o = owned.find(
          (c) => c.kind === "LimitOrder" && c.id === ref.order,
        );
        if (!o) throw new Error("Incomplete matching snapshot. Refresh.");
        use(o);
        return o;
      });
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
  /** The factory instance that issued a scoped market or proposal. */
  const factoryFor = (scope: unknown) => {
    const wanted = factoryRefKey(scope);
    return single(
      catalog.contracts.filter(
        (c) =>
          c.kind === "OutcomiaMarketFactory" &&
          factoryRefKey(c.data.ref) === wanted,
      ),
      "OutcomiaMarketFactory",
    );
  };
  const factoryAdmin = (factory: Contract) => {
    if (!list(factory.data.admins).includes(party))
      throw new Error("Admin of this market's factory required.");
  };
  /** Restricted markets need the current policy contract named by the market;
   * public markets send no proof. The ledger rechecks everything. */
  const eligibilityFor = (market: Contract, who: string) => {
    const policy = accessPolicy(all, market);
    if (!policy) return null;
    if (excludedBy(policy, who))
      throw new Error(
        policy.kind === "Club"
          ? "Only current club members can trade in this market."
          : "This wallet is not invited to this market.",
      );
    return { policy: use(policy), evidence: [] };
  };
  /** The club factory a club keeps in sync, for admin changes. */
  const clubFactory = (club: Contract) => factoryFor(club.data.factoryRef);
  const clubAdmin = (club: Contract) => {
    if (!list(club.data.admins).includes(party))
      throw new Error("Only club admins can do this.");
  };
  const clubMember = (club: Contract, who: string) => {
    if (!list(club.data.members).includes(who))
      throw new Error("That wallet is not a member of this club.");
  };
  const walletValue = () => {
    const w = text(v.wallet).trim();
    if (!/^[A-Za-z0-9:_-]+::[A-Za-z0-9:_-]+$/.test(w))
      throw new Error("Enter a valid Canton party.");
    return w;
  };
  const notFactoryMarket = () => {
    if (target.data.factory)
      throw new Error("This market is managed through its factory.");
  };
  let interfaceRoot: string | null = null;
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
        eligibility: eligibilityFor(find("BinaryMarket"), party),
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
    case "clearDeparted": {
      // A departed club member's (or uninvited party's) resting order cannot
      // fill. The operator clears it; backing returns to the owner.
      operator();
      if (target.kind !== "LimitOrder") throw new Error("Order required.");
      root = find("OrderBook");
      if (!list(root.data.orders).some((r) => obj(r).order === target.id))
        throw new Error("Order is no longer open.");
      const market = find("BinaryMarket"),
        orderOwner = text(target.data.owner),
        policy = accessPolicy(all, market);
      if (!policy || !excludedBy(policy, orderOwner))
        throw new Error("This owner can still trade in this market.");
      choice = "OrderBook_CancelIneligible";
      args = {
        market: currentMarket(),
        order: target.id,
        policy: use(policy),
        balance: target.data.side === "Buy" ? use(account(orderOwner)) : null,
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
      if (intent.action === "split") {
        args.market = currentMarket();
        args.eligibility = eligibilityFor(find("BinaryMarket"), party);
      } else args.positions = lots().map(use);
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
        orders = snapshotOrders().filter((o) => o.data.outcome === outcome);
      const buy = bestOrder(orders, "Buy"),
        sell = bestOrder(orders, "Sell");
      if (!buy || !sell || raw(buy.data.price) < raw(sell.data.price))
        throw new Error("No crossed orders to match.");
      choice = "OrderBook_MatchBest";
      args = {
        market: currentMarket(),
        outcome,
        buyerBalance: use(account(text(buy.data.owner))),
        sellerBalance: use(account(text(sell.data.owner))),
        buyerEligibility: eligibilityFor(
          find("BinaryMarket"),
          text(buy.data.owner),
        ),
        sellerEligibility: eligibilityFor(
          find("BinaryMarket"),
          text(sell.data.owner),
        ),
      };
      context = true;
      break;
    }
    case "matchComplement": {
      // Complete-set fill between the YES and NO heads of one side: two buys
      // mint pairs (prices sum to at least 1), two sells merge them (at most 1).
      operator();
      if (target.kind !== "OrderBook") throw new Error("Order book required.");
      const side = v.side === "Sell" ? "Sell" : "Buy",
        orders = snapshotOrders().filter((o) => o.data.side === side);
      const yes = bestOrder(
          orders.filter((o) => o.data.outcome === "Yes"),
          side,
        ),
        no = bestOrder(
          orders.filter((o) => o.data.outcome === "No"),
          side,
        );
      const total = yes && no ? raw(yes.data.price) + raw(no.data.price) : null;
      if (total === null || (side === "Buy" ? total < scale : total > scale))
        throw new Error("No complementary orders to match.");
      const market = find("BinaryMarket");
      choice = "OrderBook_MatchComplement";
      args = {
        market: currentMarket(),
        reserve: use(find("MarketReserve")),
        side,
        yesBalance: use(account(text(yes!.data.owner))),
        noBalance: use(account(text(no!.data.owner))),
        yesEligibility: eligibilityFor(market, text(yes!.data.owner)),
        noEligibility: eligibilityFor(market, text(no!.data.owner)),
      };
      context = true;
      break;
    }
    case "propose":
      notFactoryMarket();
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
      notFactoryMarket();
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
    case "correct": {
      const scope = obj(target.data.key).scope;
      let roles = policy.id;
      if (scope) {
        const factory = factoryFor(scope);
        factoryAdmin(factory);
        roles = use(factory);
        if (Date.now() >= Date.parse(text(target.data.finalizableAt)))
          throw new Error("Correction window is closed.");
      } else {
        admin();
        if (
          !resolverEligible(target.data, party) ||
          Date.now() >= Date.parse(text(target.data.finalizableAt))
        )
          throw new Error("Correction window is closed.");
      }
      choice = "ResolutionProposal_Correct";
      args = {
        resolver: party,
        roles,
        replacementOutcome: resolutionOutcome(v.outcome),
        replacementEvidence: evidence(v.evidence),
      };
      break;
    }
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
      if (
        raw(v.amount) >
        raw(obj(target.data.fees).amount) - raw(target.data.clubFees ?? "0")
      )
        throw new Error("Amount exceeds the fees not owed to a club.");
      context = true;
      break;
    case "clubSetShare": {
      operator();
      const bps = Number(text(v.bps));
      if (!Number.isInteger(bps) || bps < 0 || bps > 5000)
        throw new Error("The club share must be 0 to 5,000 basis points.");
      if (bps > 0 && !obj(target.data.key).scope)
        throw new Error("Only club markets carry a club share.");
      choice = "OrderBook_SetClubShare";
      args = { bps: String(bps) };
      break;
    }
    case "clubWithdrawFees": {
      // The owner withdraws through their club, which proves the book is one
      // of the club's markets; the wallet receives the club's fees.
      const scope = obj(target.data.key).scope;
      const club = owned.find(
        (c) =>
          c.kind === "Club" &&
          !!scope &&
          factoryRefKey(c.data.factoryRef) === factoryRefKey(scope),
      );
      if (!club || club.data.owner !== party)
        throw new Error("Only the club owner can withdraw club fees.");
      const amount = positive();
      if (raw(amount) > raw(target.data.clubFees ?? "0"))
        throw new Error("Amount exceeds the fees owed to the club.");
      root = club;
      choice = "Club_WithdrawFees";
      args = { book: use(target), amount };
      context = true;
      break;
    }
    case "create":
      admin();
      root = policy;
      choice = "Protocol_CreateBinary";
      args = { creator: party, terms: marketTerms(v.terms) };
      break;
    case "reserve":
    case "book": {
      notFactoryMarket();
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
      notFactoryMarket();
      creator();
      choice = "Binary_Open";
      args = { protocol: policy.id };
      break;
    case "close":
      notFactoryMarket();
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
    case "factoryCreate": {
      const creation = obj(target.data.policy);
      let proof: RecordValue | null = null,
        club: Contract | undefined;
      if (creation.tag === "ByPolicy") {
        // Club factories: the creator presents the club as creation proof.
        const wanted = factoryRefKey(creation.value);
        club = owned.find(
          (c) => c.kind === "Club" && factoryRefKey(c.data.ref) === wanted,
        );
        if (!club)
          throw new Error("Only club members can create markets here.");
        clubMember(club, party);
        if (
          club.data.marketPolicy !== "AnyMember" &&
          !list(club.data.admins).includes(party)
        )
          throw new Error("Only club admins can create markets in this club.");
        proof = { policy: use(club), evidence: [] };
      } else if (!mayCreate(creation, party))
        throw new Error(
          "This factory's creation policy does not allow this wallet.",
        );
      const terms = standardTerms(v.terms);
      const collateral = obj(terms.collateral);
      if (
        !list(target.data.assets).some((a) =>
          sameInstrument(obj(a).instrument, collateral),
        )
      )
        throw new Error("This factory does not admit that collateral.");
      let access: RecordValue = { tag: "Public", value: {} };
      if (v.access === "club") {
        if (!club) throw new Error("Members-only access needs a club factory.");
        access = { tag: "Restricted", value: obj(club.data.ref) };
      } else if (v.access === "invite") {
        const list_ = owned.find(
          (c) => c.kind === "InviteListPolicy" && c.id === text(v.policy),
        );
        if (!list_ || list_.data.manager !== party)
          throw new Error("Choose an invite list you manage.");
        access = { tag: "Restricted", value: obj(list_.data.ref) };
      }
      interfaceRoot = interfaceId(d, "MarketFactory");
      choice = "MarketFactory_Create";
      args = { creator: party, terms, access, proof };
      break;
    }
    case "factoryClose":
    case "factoryPropose": {
      if (!target.data.factory)
        throw new Error("This market is managed through the protocol root.");
      const factory = factoryFor(target.data.factory);
      factoryAdmin(factory);
      if (intent.action === "factoryClose") {
        if (target.data.status !== "Open")
          throw new Error("Only an open market can close.");
        choice = "Binary_FactoryClose";
        args = { actor: party, roles: use(factory), reason: text(v.reason) };
      } else {
        const t = obj(target.data.terms);
        const earliest = Date.parse(text(t.earliestResolutionAt ?? t.closeAt));
        if (Date.now() < earliest)
          throw new Error("Resolution is not available yet.");
        choice = "Binary_FactoryPropose";
        args = {
          actor: party,
          roles: use(factory),
          outcome: resolutionOutcome(v.outcome),
          evidence: evidence(v.evidence),
        };
      }
      break;
    }
    case "createInviteList": {
      if (!mayCreate(target.data.policy, party))
        throw new Error(
          "This factory's creation policy does not allow this wallet.",
        );
      choice = "OutcomiaFactory_CreateInviteList";
      args = { manager: party, parties: invitees(v.parties) };
      break;
    }
    case "setInvites":
      if (target.data.manager !== party)
        throw new Error("Only the invite list's manager can edit it.");
      choice = "InviteList_Set";
      args = { replacementParties: invitees(v.parties) };
      break;
    case "createClub": {
      const name = text(v.name);
      if (!name || name.trim() !== name || name.length > 64)
        throw new Error(
          "Club names need 1 to 64 characters without outer spaces.",
        );
      const owned = Number(
        (list(target.data.owned)
          .map(list)
          .find((e) => e[0] === party) ?? [])[1] ?? 0,
      );
      if (owned >= Number(text(obj(target.data.rules).maxOwnedClubs)))
        throw new Error(
          "This wallet already owns the maximum number of clubs.",
        );
      choice = "ClubRegistry_CreateClub";
      args = {
        owner: party,
        name,
        kind: v.kind === "PublicClub" ? "PublicClub" : "PrivateClub",
      };
      break;
    }
    case "clubInvite": {
      clubAdmin(target);
      const invitee = walletValue();
      if (list(target.data.members).includes(invitee))
        throw new Error("That wallet is already a member.");
      choice = "Club_Invite";
      args = { inviter: party, invitee };
      break;
    }
    case "clubAccept":
    case "clubDecline": {
      const pending = list(target.data.invitations)
        .map(obj)
        .find((i) => i.invitee === party);
      if (!pending) throw new Error("There is no invitation for this wallet.");
      if (
        intent.action === "clubAccept" &&
        Date.parse(text(pending.expiresAt)) <= Date.now()
      )
        throw new Error("This invitation has expired.");
      choice = intent.action === "clubAccept" ? "Club_Accept" : "Club_Decline";
      args = { invitee: party };
      break;
    }
    case "clubRevoke":
      clubAdmin(target);
      choice = "Club_RevokeInvite";
      args = { actor: party, invitee: walletValue() };
      break;
    case "clubClear":
      if (
        !list(target.data.invitations).some(
          (i) => Date.parse(text(obj(i).expiresAt)) <= Date.now(),
        )
      )
        throw new Error("No invitation has expired.");
      choice = "Club_ClearExpired";
      args = { closer: party };
      break;
    case "clubPolicy":
      clubAdmin(target);
      choice = "Club_SetMarketPolicy";
      args = {
        actor: party,
        replacementPolicy:
          v.policy === "AnyMember" ? "AnyMember" : "AdminsOnly",
      };
      break;
    case "clubSetAdmin": {
      if (target.data.owner !== party)
        throw new Error("Only the club owner can change admins.");
      const member = walletValue();
      clubMember(target, member);
      if (member === target.data.owner)
        throw new Error("The owner always stays an admin.");
      if (
        v.makeAdmin === "true" &&
        !list(target.data.admins).includes(member) &&
        list(target.data.admins).length >= Number(text(target.data.adminCap))
      )
        throw new Error("This club already has the maximum number of admins.");
      choice = "Club_SetAdmin";
      args = {
        wallet: member,
        makeAdmin: v.makeAdmin === "true",
        factory: use(clubFactory(target)),
      };
      break;
    }
    case "clubRemove": {
      clubAdmin(target);
      const member = walletValue();
      clubMember(target, member);
      if (member === target.data.owner)
        throw new Error("The owner cannot be removed.");
      if (
        list(target.data.admins).includes(member) &&
        target.data.owner !== party
      )
        throw new Error("Only the owner can remove an admin.");
      choice = "Club_RemoveMember";
      args = {
        actor: party,
        wallet: member,
        factory: use(clubFactory(target)),
      };
      break;
    }
    case "clubLeave":
      clubMember(target, party);
      if (target.data.owner === party)
        throw new Error("Transfer ownership before leaving.");
      choice = "Club_Leave";
      args = { wallet: party, factory: use(clubFactory(target)) };
      break;
    case "clubNominate": {
      if (target.data.owner !== party)
        throw new Error("Only the club owner can nominate.");
      let nominee: string | null = null;
      if (typeof v.wallet === "string" && v.wallet.trim()) {
        nominee = walletValue();
        clubMember(target, nominee);
        if (nominee === party) throw new Error("Nominate another member.");
      }
      choice = "Club_Nominate";
      args = { nominee };
      break;
    }
    case "clubAcceptOwnership":
      if (target.data.pendingOwner !== party)
        throw new Error("This wallet is not the nominated owner.");
      if (
        list(target.data.admins).length >= Number(text(target.data.adminCap)) &&
        !list(target.data.admins).includes(party)
      )
        throw new Error("This club already has the maximum number of admins.");
      // Ownership moves through the registry, which keeps owned-club counts.
      root = single(catalog.contracts, "ClubRegistry");
      choice = "ClubRegistry_AcceptOwnership";
      args = {
        nominee: party,
        club: use(target),
        factory: use(clubFactory(target)),
      };
      break;
    case "setClubRules": {
      operator();
      const rules = clubRules(v);
      choice = "ClubRegistry_SetRules";
      args = { replacementRules: rules };
      break;
    }
    case "clubApplyRules": {
      operator();
      choice = "Club_ApplyRules";
      args = {
        rules: obj(single(catalog.contracts, "ClubRegistry").data.rules),
      };
      break;
    }
    case "clubSetListing": {
      if (target.data.owner !== party)
        throw new Error("Only the club owner can list the club.");
      if (target.data.kind !== "PublicClub")
        throw new Error("Only public clubs can be listed.");
      const topic = text(v.topic),
        description = typeof v.description === "string" ? v.description : "";
      if (!topic || topic.trim() !== topic || topic.length > 32)
        throw new Error("Topics need 1 to 32 characters without outer spaces.");
      if (description.length > 280)
        throw new Error("Descriptions are at most 280 characters.");
      choice = "Club_SetListing";
      args = {
        visibility:
          v.visibility === "OpenToAll" ? "OpenToAll" : "RequestToJoin",
        topic,
        description,
      };
      break;
    }
    case "clubCloseListing":
      if (target.data.owner !== party)
        throw new Error("Only the club owner can close the listing.");
      if (!target.data.listing) throw new Error("This club is not listed.");
      choice = "Club_CloseListing";
      break;
    case "clubVerifyListing":
      admin();
      if (!target.data.listing) throw new Error("This club is not listed.");
      choice = "Club_VerifyListing";
      args = {
        verifier: party,
        protocol: use(policy),
        verified: v.verified !== "false",
      };
      break;
    case "clubRequestJoin": {
      const listing = target.data.listing ? obj(target.data.listing) : null;
      if (!listing?.verifiedBy || listing.visibility !== "RequestToJoin")
        throw new Error("This club does not accept join requests.");
      if (list(target.data.members).includes(party))
        throw new Error("This wallet is already a member.");
      const note = typeof v.note === "string" ? v.note : "";
      if (note.length > 140)
        throw new Error("Notes are at most 140 characters.");
      choice = "Club_RequestJoin";
      args = { requester: party, note };
      break;
    }
    case "clubApproveRequest":
    case "clubCloseRequest": {
      const requester = walletValue();
      const pending = list(target.data.requests)
        .map(obj)
        .find((r) => r.requester === requester);
      if (!pending)
        throw new Error("There is no join request from that wallet.");
      if (intent.action === "clubApproveRequest") {
        clubAdmin(target);
        if (Date.parse(text(pending.expiresAt)) <= Date.now())
          throw new Error("This join request has expired.");
        if (
          list(target.data.members).length >=
          Number(text(target.data.memberCap))
        )
          throw new Error("This club has reached its member limit.");
        choice = "Club_ApproveRequest";
      } else {
        if (requester !== party) clubAdmin(target);
        choice = "Club_CloseRequest";
      }
      args = { actor: party, requester };
      break;
    }
    case "clubJoinOpen": {
      const listing = target.data.listing ? obj(target.data.listing) : null;
      if (!listing?.verifiedBy || listing.visibility !== "OpenToAll")
        throw new Error("This club is not open to join.");
      if (list(target.data.members).includes(party))
        throw new Error("This wallet is already a member.");
      if (
        list(target.data.members).length >= Number(text(target.data.memberCap))
      )
        throw new Error("This club has reached its member limit.");
      choice = "Club_JoinOpen";
      args = { wallet: party };
      break;
    }
    default:
      throw new Error("Unsupported Canton action.");
  }
  dependencies.add(root.id);
  // Only these fixed template/choice pairs can reach the wallet; forms cannot
  // choose an arbitrary target template, actAs, factory or transfer recipient.
  return {
    command: {
      ExerciseCommand: {
        templateId: interfaceRoot ?? templateId(d, root.kind),
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

/** Mirrors the standard's `mayCreate` for a JSON-encoded CreationPolicy. */
export function mayCreate(policy: unknown, party: string): boolean {
  const p = obj(policy);
  if (p.tag === "AnyParty") return true;
  if (p.tag === "AdminsOnly" || p.tag === "Allowlist")
    return list(p.value).includes(party);
  return false;
}
function invitees(value: unknown) {
  const parties = list(value).map(text);
  if (parties.length > 256 || new Set(parties).size !== parties.length)
    throw new Error("Invite lists hold at most 256 unique parties.");
  return parties;
}
/** Standard MarketTerms for a binary factory market: outcomes YES then NO. */
function standardTerms(value: unknown) {
  const t = obj(value);
  if (
    JSON.stringify(list(t.outcomes)) !== JSON.stringify(["YES", "NO"]) ||
    list(t.outcomeCriteria).length !== 2
  )
    throw new Error("Binary factory markets use the outcomes YES and NO.");
  list(t.outcomeCriteria).forEach(text);
  text(t.question);
  text(t.invalidCriteria);
  text(t.evidenceRequirements);
  evidence({
    summary: t.question,
    documentUri: t.rulesUri,
    documentSha256: t.rulesHash,
  });
  const c = obj(t.collateral);
  text(c.admin);
  text(c.id);
  if (!(Date.parse(text(t.closeAt)) > Date.now()))
    throw new Error("Trading cutoff must be in the future.");
  if (raw(t.priceTick) <= BigInt(0))
    throw new Error("Price tick must be positive.");
  if (integer(t.quantityLot) < BigInt(1))
    throw new Error("Quantity lot must be positive.");
  integer(t.resolutionDelaySeconds);
  return t;
}

/** Best-price, then lowest-acceptance-ID order of one side, as the ledger's
 * planner selects it. Example: sells at 0.40 (#2) and 0.40 (#1) pick #1. */
function bestOrder(orders: Contract[], side: string) {
  return orders
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
}

/** The current policy contract of a restricted market (its club or invite
 * list), or null for a public market. Throws when the policy is not visible. */
export function accessPolicy(all: Contract[], market: Contract) {
  const access = market.data.access;
  if (!access) return null;
  const wanted = factoryRefKey(access);
  // Club markets: the club roster is the policy; no extra evidence.
  const club = all.find(
    (c) => c.kind === "Club" && factoryRefKey(c.data.ref) === wanted,
  );
  if (club) return club;
  return single(
    all.filter(
      (c) =>
        c.kind === "InviteListPolicy" && factoryRefKey(c.data.ref) === wanted,
    ),
    "InviteListPolicy",
  );
}

/** Mirrors the ledger's `excludes`: a club excludes parties off its roster;
 * an invite list everyone except its manager and invitees. */
export function excludedBy(policy: Contract, who: string) {
  return policy.kind === "Club"
    ? !list(policy.data.members).includes(who)
    : policy.data.manager !== who && !list(policy.data.parties).includes(who);
}

/** Club rules from a form: every limit a whole number within the contract
 * bounds (member caps up to 256, admins up to 64). */
export function clubRules(values: RecordValue) {
  const read = (name: string, max: number) => {
    const n = Number(text(values[name]));
    if (!Number.isInteger(n) || n < 1 || n > max)
      throw new Error(`Club rules: ${name} must be between 1 and ${max}.`);
    return String(n);
  };
  return {
    publicMemberCap: read("publicMemberCap", 256),
    privateMemberCap: read("privateMemberCap", 256),
    maxOwnedClubs: read("maxOwnedClubs", 1000),
    maxClubAdmins: read("maxClubAdmins", 64),
    clubShareBps: (() => {
      const n = Number(text(values.clubShareBps ?? "0"));
      if (!Number.isInteger(n) || n < 0 || n > 5000)
        throw new Error("Club rules: clubShareBps must be between 0 and 5000.");
      return String(n);
    })(),
  };
}
