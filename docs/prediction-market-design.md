# Prediction Market Design

Status: account-layout milestone implemented locally. Prediction instructions,
trading and resolution remain planned; prediction markets cannot be created yet.

The first implementation is in `programs/tidebook/src/state/prediction.rs`:
outcome, resolution, lifecycle and resolver-phase enums, plus `PredictionMarket`
and `PredictionPosition`. PDA helpers live in `src/pda.rs`. Existing spot
account layouts are unchanged.

`PredictionMarket` reserves 834 payload bytes (842 including its Anchor
discriminator), with a 200-byte limit for each URI. `PredictionPosition` uses
113 payload bytes (121 including its discriminator). These are Borsh sizes,
not Rust in-memory struct sizes. URI limits and state rules will be enforced by
future instruction handlers; `InitSpace` only calculates allocation.

This design adds binary prediction markets to Tidebook without creating YES and
NO SPL tokens. A market uses one collateral mint, such as test USDC. YES and NO
are internal positions recorded by the program.

The editable diagram is
[`diagrams/prediction-market-architecture.drawio`](diagrams/prediction-market-architecture.drawio).

## What the existing platforms teach us

### Polymarket

Polymarket represents a binary market as two outcome positions. One unit of
collateral can be split into one YES plus one NO position. A complete pair can
be merged back into collateral, and resolved positions can be redeemed for
their payout. Its CLOB matches off-chain and settles atomically on-chain.

This gives us the most important accounting rule:

```text
1 collateral payout unit <-> 1 YES position + 1 NO position
```

Polymarket also separates the short market title from its full resolution
rules. The rules identify the source, end time, and treatment of edge cases.
Resolution is a separate lifecycle from trading.

### Kalshi

Kalshi uses fully cash-collateralized event contracts. Its public order book
shows YES bids and NO bids. The other side can be derived because the two prices
are complementary:

```text
YES bid at 0.60 = implied NO ask at 0.40
NO bid at 0.35  = implied YES ask at 0.65
```

This is useful for a compact UI. It does not mean Tidebook should immediately
copy Kalshi's bid-only matching model. Tidebook already has explicit bid and ask
queues, and keeping them explicit makes collateral checks easier to audit.

### Tidebook's choice

Tidebook will use Polymarket-style complete-set accounting with internal
positions, explicit bid and ask books, and Tidebook's existing bounded on-chain
FIFO matching.

| Area | Tidebook decision |
| --- | --- |
| Collateral | One SPL mint and one program vault per prediction market |
| Outcomes | Internal `Yes` and `No` balances; no outcome token mints |
| Order book | One bid/ask book for YES and one bid/ask book for NO |
| Matching | Best-price FIFO, validated and settled on-chain |
| Price | Collateral atoms paid for one winning-payout contract |
| Resolution | Trusted resolver for the research version; oracle adapter later |
| Long rules | Immutable URI plus content hashes stored on-chain |

## User-facing meaning

One contract pays one collateral token if its outcome wins and zero if it
loses. For a six-decimal USDC-style mint:

```text
payout_per_contract = 1_000_000 raw collateral atoms
YES price 650_000    = 0.65 collateral = 65% displayed probability
NO price 350_000     = 0.35 collateral = 35% displayed probability
```

The phrase "one USDC equals one vote" is misleading here. Traders do not cast
governance votes. They buy positions at a market price between zero and the
one-token payout. One deposited USDC can instead be split into one fully backed
YES/NO pair.

The first version should use whole contracts. Fractional contracts add another
fixed-point scale and more rounding paths, so they can be added later.

## Accounts

### `PredictionMarket`

```text
seeds = ["prediction_market", market_id]

market_id
authority
resolver
fallback: Option<PredictionFallback { resolver, available_ts, deadline_ts: Option<i64> }>
collateral_mint
collateral_vault
metadata
question_hash
rules_hash
rules_uri
close_ts
earliest_resolution_ts: Option<i64>
resolution_delay_seconds
resolution_phase
status
proposal: Option<PredictionProposal { outcome, proposed_at, evidence_uri, evidence_hash }>
final_outcome: Option<PredictionResolution>
payout_per_contract
price_tick
yes_supply
no_supply
backing_reserve
open_order_count
bump
```

Absent values have explicit meanings:

- `earliest_resolution_ts: None`: proposals can begin at `close_ts`.
- `fallback: None`: only the primary resolver can propose, with no proposal
  deadline and no automatic timeout payout.
- `fallback.deadline_ts: None`: the fallback exists, but its proposal window has
  no end and there is no automatic timeout payout.
- `proposal: None`: no outcome, timestamp or evidence has been submitted.
- `final_outcome: None`: payouts are not finalized.

Grouping fallback configuration and proposal data prevents partially populated
records. Resolver keys, collateral identity, rule references, close time, payout
size and price tick remain mandatory. Zero balances and zero supply are valid
numeric values, so those fields do not need `Option`. Allocations reserve the
maximum size even when optional fields are absent.

`market_id` is a creator-supplied 32-byte identifier unique within this program,
stored in the account to reconstruct its PDA seeds. The title remains in
`MarketMetadata`. The full question and
rules can be much longer, so they belong in an Arweave JSON document at
`rules_uri`. `rules_hash` is SHA-256 of the exact uploaded document bytes;
`question_hash` hashes the UTF-8 question string without normalization. The UI
verifies both before displaying the document as verified.

The JSON should contain at least:

```json
{
  "schemaVersion": 1,
  "question": "Will ...?",
  "description": "...",
  "resolutionSource": "https://...",
  "resolutionRules": {
    "yesCriteria": "Exact condition for YES",
    "noCriteria": "Exact condition for NO",
    "invalidCriteria": "When neither outcome can be established",
    "evidenceRequirements": "Required records, observation times and sources",
    "conflictingEvidencePolicy": "Source priority and treatment of revisions"
  },
  "closeTimestamp": 1900000000,
  "earliestResolutionTimestamp": 1900003600,
  "primaryResolver": "<public key>",
  "fallback": {
    "resolver": "<public key>",
    "availableTimestamp": 1900086400,
    "proposalDeadlineTimestamp": 1900172800,
    "activation": "No primary proposal exists at the activation time",
    "procedure": "Fallback submits evidence under the same criteria",
    "noProposalOutcome": "Invalid after the proposal deadline"
  },
  "resolutionDelaySeconds": 3600,
  "edgeCases": "Source outages, cancellations, corrections and ambiguity"
}
```

For markets without an extra wait after close, `earliestResolutionTimestamp`
is `null`. For primary-only markets, `fallback` is `null`. A configured fallback
without an end time uses `proposalDeadlineTimestamp: null` and
`noProposalOutcome: "No automatic timeout; await resolver"`. These choices are
fixed before opening and must be shown in the UI. Optional configuration cannot
be filled in later merely because an administrator wants to change the rules.

The creation client checks that the document's timestamps and resolver keys
match the submitted on-chain configuration. Program code cannot fetch or
evaluate an Arweave document: clients validate the document, while the program
enforces its stored keys, timestamps and transitions. These economic terms and document references
are fixed before opening. A new Arweave upload cannot replace existing terms.

An evidence URI and content hash accompany each proposal and correction.
Evidence records are separate from the original rules. A trusted resolver still
judges whether that evidence satisfies the criteria; a hash proves commitment,
not truth. The UI shows this trust model and the program upgrade authority.

### `PredictionPosition`

```text
seeds = ["prediction_position", prediction_market, owner]

market
owner
collateral_free
collateral_locked
yes_free
yes_locked
no_free
no_locked
bump
```

The collateral fields are claims against the single market vault. Outcome
fields are program accounting units, not SPL balances. Ask orders move outcome
units from free to locked. Bid orders move collateral from free to locked.

### `PredictionPriceLevel` and `PredictionOrder`

The current spot accounts assume a base mint, quote mint, and `TraderBalance`.
Reusing them directly would require a fake base mint and still would not model
both outcomes. Prediction markets therefore need separate accounts at first:

```text
PredictionPriceLevel seeds =
  ["prediction_level", market, outcome, side, price]

PredictionOrder seeds =
  ["prediction_order", market, order_id]
```

Both accounts keep the same sorted-level and FIFO-link rules as the spot book.
Pure linked-list validation helpers can be shared later, after both versions are
working.

## Core instructions

### Market setup

1. `initialize_prediction_market`
2. `initialize_prediction_position`
3. `deposit_prediction_collateral`
4. `withdraw_prediction_collateral`

Initialization creates the market, collateral vault, metadata, and fee account
in one transaction. `MarketKind::Prediction` becomes available only through
this instruction; the existing spot initializer must continue rejecting it.

### Position creation

`split_collateral(contracts)` moves
`contracts * payout_per_contract` from the trader's free collateral into the
market's backing reserve, then credits the same number of YES and NO positions.

`merge_complete_set(contracts)` burns equal free YES and NO positions and
returns the corresponding reserve to free collateral. Locked positions cannot
be merged.

### Trading

`place_prediction_order(outcome, side, price, quantity)` checks:

- the market is open and before `close_ts`;
- `0 < price < payout_per_contract`;
- price follows `price_tick`;
- a bid can lock `price * quantity` collateral plus its maximum fee;
- an ask can lock the requested YES or NO quantity;
- the supplied price-level and FIFO neighbours are canonical.

Matching transfers an internal outcome position from seller to buyer and moves
the maker-price collateral from buyer to seller. It does not transfer SPL
tokens because both traders already hold claims against the same vault.

Cancellation remains available after the market freezes or resolves. It
releases only the unfilled collateral or positions. Redemption initially
requires positions to be free, so users cancel resting orders before redeeming.

### Resolution and redemption

The research version uses a stored resolver key and makes that trust explicit:

1. All placement and matching instructions reject `now >= close_ts`, even if
   nobody has called the permissionless freeze instruction yet.
2. At `earliest_resolution_ts` (or `close_ts` when absent), the primary resolver
   may propose `Yes | No | Invalid`, with an evidence URI and hash. If configured,
   its proposal window ends at `fallback.available_ts`; otherwise it has no end.
3. When fallback is configured and no primary proposal exists at its activation
   time, anyone may activate it. The primary window stays closed even if
   activation is delayed. Only the fixed fallback resolver may then propose,
   before `fallback.deadline_ts` when that deadline exists.
4. Every proposal waits `resolution_delay_seconds`. Only the resolver for the
   active phase may correct it during that delay; each correction records new
   evidence and restarts the full delay. Corrections must also occur before
   that resolver's proposal deadline when configured. Super-admin has no separate outcome
   override.
5. Anyone may finalize after the delay. A timely proposal may finalize after
   its proposal deadline. If a primary proposal exists, fallback does not
   replace it; this first version handles resolver silence, not disputes.
6. If a fallback deadline exists and neither resolver proposed by it, anyone may finalize
   the precommitted `Invalid` outcome. Timeout settlement must reject an
   existing proposal, and timeout evidence is the on-chain absence of one.
7. Traders redeem free outcome positions into free collateral, then withdraw.

Initialization uses `effective_earliest = earliest_resolution_ts.unwrap_or(close_ts)`
and requires `close_ts <= effective_earliest`. If fallback exists, it also requires
`effective_earliest < fallback.available_ts`. If its deadline exists,
`fallback.available_ts < fallback.deadline_ts` is required. The resolution delay
must be positive. Resolver windows use inclusive starts and
exclusive ends. Proposal, correction, activation and finalization transitions
are atomic, with events that include the phase, timestamps and evidence hashes.

The timeout policy is a deliberate research compromise. A resolver capable of
withholding evidence could benefit from a 50/50 payout. Public deployment needs
a stronger dispute process; the UI must disclose the committed timeout policy.
Without fallback or without its deadline, resolver silence can leave unpaired
outcome positions unresolved indefinitely. Users can still cancel orders,
withdraw free collateral and merge free complete sets before resolution, but
cannot redeem unpaired outcomes. No administrator may invent a timeout refund
after opening.

`Invalid` pays half to YES and half to NO. The initializer must therefore
require an even `payout_per_contract`. Later, the trusted resolver can be
replaced by an oracle adapter without changing positions or order books.

An optimistic, bonded dispute system similar to UMA is deliberately outside the
first implementation. A delay without a real challenger or adjudicator is not
decentralized resolution and must not be presented as one.

## State machine

```text
Draft -> Open -> Frozen -> Proposed -> Resolved
                   |          |
                   +----------+---- proposal correction before finalization

Open:      split, merge, trade, cancel, deposit, withdraw
Frozen:    cancel, merge, deposit, withdraw
Proposed:  cancel, merge, deposit, withdraw
Resolved:  cancel, redeem, withdraw
```

New orders and matching stop at `Frozen`. A resolved market cannot return to an
earlier state.

The timestamp gate also closes trading while the stored status is still `Open`.
Fallback is a resolution phase within `Frozen`/`Proposed`, rather than reopening
trading. A missing proposal can move `Frozen` directly to `Resolved(Invalid)`
after a configured fallback deadline. With no deadline there is no timeout
transition.

## Later feature: atomic position switching

A trader may sell free YES positions and use the net proceeds to buy NO, or
perform the reverse, within the same prediction market. This is ordinary
trading composed into one transaction. It requires counterparties on both
books; switching does not guarantee an exit or restore the original purchase
price.

For example, buying 100 YES at 0.60 costs 60 collateral tokens. Selling at 0.20
returns 20 before fees. The 40-token loss is the difference between purchase
cost and sale proceeds, not another charge. At a NO ask of 0.80, those proceeds
buy at most 25 whole NO contracts before fees.

The client composes bounded sell instructions followed by bounded buy
instructions. Sale proceeds credit free collateral before the buy debits it.
A final program guard enforces the signed minimum sold quantity, minimum net
sale proceeds, minimum destination quantity and maximum additional collateral
spend. Any failed fill or guard rolls back the complete transaction. Normal
network transaction fees can still be charged on failure.

Both legs enforce `now < close_ts`, canonical FIFO priority, self-trade
prevention and trading fees. The default route uses only sale proceeds; using
existing free collateral requires an explicit spend allowance. In this version
neither leg posts a remainder. If account or compute limits cannot accommodate
the route, reduce the size or use separate trades without an atomic guarantee.
This feature follows the tested prediction-market lifecycle.

## Accounting invariants

Before resolution:

```text
yes_supply == no_supply
backing_reserve == yes_supply * payout_per_contract

vault amount ==
  sum(collateral_free)
  + sum(collateral_locked)
  + backing_reserve
  + accrued_protocol_fees
```

Ask-locked positions remain part of `yes_supply` or `no_supply`; they are not an
extra vault claim. Trading changes ownership but not total supply or backing.

After resolution:

```text
backing_reserve ==
  yes_supply * yes_payout
  + no_supply * no_payout
```

Every split, merge, fill, cancellation, resolution, and redemption must preserve
these equations with checked `u128` intermediate arithmetic.

## What we will not do in the first version

- create transferable YES or NO SPL tokens;
- support more than two outcomes;
- support fractional contracts;
- allow rule changes after opening;
- resolve from a general web URL inside the Solana program;
- claim that a trusted resolver is censorship-resistant;
- reuse spot accounts by pretending collateral is a base asset;
- add AMM liquidity before the CLOB lifecycle is tested end to end.

## Implementation sequence

1. Add prediction enums, accounts, sizes, and PDA tests.
2. Initialize a market with one collateral vault and immutable rule hashes.
3. Add position ledgers plus deposit and withdrawal.
4. Add split and merge with conservation tests.
5. Add YES/NO price levels, FIFO orders, and cancellation.
6. Add bounded matching and fees.
7. Add freeze, propose, finalize, invalid outcome, and redemption.
8. Add typed events and indexer decoding.
9. Add the market page, probability display, positions, and redemption UI.
10. Run a complete devnet lifecycle before considering an oracle adapter.
11. Add same-market atomic position switching, with execution limits, fee and
    insufficient-liquidity rollback tests.

## Sources

- [Polymarket: How Positions Work](https://docs.polymarket.com/trading/positions/how-positions-work)
- [Polymarket: Prices and Orderbook](https://docs.polymarket.com/concepts/prices-orderbook)
- [Polymarket: Order Lifecycle](https://docs.polymarket.com/concepts/order-lifecycle)
- [Polymarket: Resolution](https://docs.polymarket.com/concepts/resolution)
- [Polymarket CTF Exchange overview](https://github.com/Polymarket/ctf-exchange/blob/main/docs/Overview.md)
- [Kalshi: Orderbook Responses](https://docs.kalshi.com/getting_started/orderbook_responses)
- [Kalshi: Working with Event Contracts](https://news.kalshi.com/p/what-are-event-contracts)
- [Kalshi regulatory rulebooks](https://kalshi.com/regulatory/rulebook)

Prediction markets are regulated differently across jurisdictions. This design
is for protocol research and does not establish legal or production readiness.
