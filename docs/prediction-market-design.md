# Prediction Market Design

Status: draft and wallet-position initialization, creation validation and
collateral deposits/withdrawals and complete-set splitting/merging are implemented
locally, along with active-admin creator-controlled market opening and first
resting orders on empty sides, same-price FIFO append and sorted new-price insertion. Cancellation, matching
and resolution remain planned. This program version
has not been deployed to devnet.

The first implementation is in `programs/tidebook/src/state/prediction.rs`:
outcome, resolution, lifecycle and resolver-phase enums, plus `PredictionMarket`
and `PredictionPosition`. PDA helpers live in `src/pda.rs`. Existing spot
account layouts are unchanged.

Order storage is defined in `src/state/prediction_book.rs`: `PredictionOrderBook`,
`PredictionPriceLevel` and `PredictionOrder`. Rust and browser PDA helpers agree
on fixed test vectors. Draft creation now initializes `PredictionOrderBook`
atomically. Empty-side placement, same-price FIFO append and new-price insertion
are implemented locally; cancellation and matching remain unavailable.

`PredictionMarket` reserves 834 payload bytes (842 including its Anchor
discriminator), with a 200-byte limit for each URI. `PredictionPosition` uses
113 payload bytes (121 including its discriminator). These are Borsh sizes,
not Rust in-memory struct sizes. Creation enforces URI bounds and configuration
rules; future handlers will enforce lifecycle transitions. `InitSpace` only
calculates allocation.

`programs/tidebook/src/prediction_config.rs` validates proposed creation terms
without account allocation or network access. It requires a future close time,
ordered optional resolution windows, nonzero resolver keys, a distinct fallback
resolver, positive representable delay, and timestamp arithmetic without overflow.
Payout must be positive and even. Price tick must be positive, below payout,
and divide payout exactly so complementary prices share the same grid. Rule
references must fit the URI bound, use printable ASCII without whitespace and
start with `ar://` or `https://` with a nonempty target. Both content commitments
must be nonzero. This is not full URL validation or document verification.

Tests cover valid optional configurations, boundary timestamps, delay overflow,
payout/tick constraints, resolver keys, URI bounds and missing hashes. The draft
initializer calls the validator using Solana Clock and separately checks the
admin role, SPL mint, vault authority and canonical account addresses. Proposal
instructions must repeat checked timestamp arithmetic at the actual proposal
time, especially when a resolver window has no deadline.

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
| Resolution | Creator is the trusted primary resolver; predeclared optional fallback; oracle adapter later |
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

The rules document's `primaryResolver` must equal the creator wallet. Both the
client and draft initializer enforce this; the uploaded bytes are never rewritten
to make a mismatched document appear valid. The creation client checks that the document's timestamps and resolver keys
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

`initialize_prediction_position` is implemented. The wallet signs and pays rent
for its canonical `["prediction_position", market, owner]` account. The program
validates the prediction-market discriminator and its market-ID seeds, then
sets all six balances to zero. Existing ledgers are rejected rather than reset.
No admin role, mint, token account or vault is required, and market data stays
read-only. Ledger creation is allowed in every lifecycle status because it
creates no claims; funding and trading must enforce their own status rules.

The prediction detail page shows a connected wallet's six balances or an
initialization button after a successful read confirms the account is absent.
Read failures remain errors. Confirmation triggers an account reload. Wallet,
market and RPC changes reset the panel's action state, and canceled reads cannot
replace data in the new panel. The same rollout flag gates position creation;
it must be enabled only after deploying a program containing both initializers.
Deposits, withdrawals and split/merge use the separate funding rollout gate.

### Prediction order-book accounts (layouts implemented locally)

The current spot accounts assume a base mint, quote mint, and `TraderBalance`.
Reusing them directly would require a fake base mint and still would not model
both outcomes. Prediction markets use separate order-book layouts:

```text
PredictionOrderBook seeds =
  ["prediction_book", market]

PredictionPriceLevel seeds =
  ["prediction_level", market, outcome, side, price_le]

PredictionOrder seeds =
  ["prediction_order", market, order_id_le]
```

The outcome seed is ASCII `yes` or `no`; the side is `bid` or `ask`. Price and
order ID are exactly eight little-endian bytes. They never pass through a
JavaScript Number, which cannot represent every u64. These address helpers do
not validate market ticks or trading rules; placement must do that separately.

The root stores its market, one shared `next_order_id`, four optional best-price
heads and a bump. The four heads are YES bid, YES ask, NO bid and NO ask. A new
root will start at ID 1. IDs must never reset or wrap while the market exists.
`PredictionMarket.open_order_count` remains the sole market-wide order count.

A level stores market/outcome/side/price, better/worse prices, first/last order,
remaining quantity, order count, rent payer and bump. Better means a higher bid
or lower ask. Orders at one price form a doubly linked FIFO queue: new orders
append at the tail and matching starts at the head. Neighbor links must never
cross an outcome, side or price boundary.

An order stores its owner, market, ID, outcome, side, raw price, level address,
previous/next order, submitted/remaining quantities, locked collateral, status
and bump. Quantities are whole contracts. For bids, locked collateral uses mint
atoms and includes any reserved fee budget. For asks, it counts the chosen
outcome's whole contracts. Future fills/cancellation must use those exact units.

| Account | Payload | With Anchor discriminator |
| --- | ---: | ---: |
| `PredictionOrderBook` | 77 bytes | 85 bytes |
| `PredictionPriceLevel` | 175 bytes | 183 bytes |
| `PredictionOrder` | 206 bytes | 214 bytes |

These are maximum Borsh lengths, including Option tags and payloads. An absent
link is `None`, not a zero-key sentinel. Account discriminators separate the
prediction layouts from similar-looking spot accounts.

Tradeoffs: the root adds one account and its rent, but avoids changing existing
market layouts. One shared counter gives market-wide order identity and a
simple index; placements will contend on the writable root. Per-order and
per-level accounts keep edits bounded but cost rent and require clients to
supply validated neighbors. All four queues remain independent: complementary
YES/NO prices do not automatically match against each other in this version.

Draft creation initializes the root atomically with the market, collateral
vault, metadata and fee account. The creator pays rent for the 85-byte root.
It stores the canonical market and bump, starts `next_order_id` at 1 and sets
all four best-price heads to `None`. Plain Anchor `init` rejects an existing
account; there is no `init_if_needed` or reset route. A failure anywhere in
creation, or later in the same transaction, rolls back the complete account graph.

The generated IDL now exposes `PredictionOrderBook`, and the browser account
reader registers it. Draft creation supplies its canonical PDA in the same
instruction. The detail page shows the root account, next order ID and best-price
heads. Missing roots on older drafts are reported explicitly, not displayed as
an initialized empty book; RPC failures remain errors. This version provides no
backfill/reset instruction for older drafts. Create a fresh draft for the new
order flow. Existing market/position layouts and funds are unchanged.

`PredictionPriceLevel` and `PredictionOrder` are exposed through the placement
instruction and registered in the frontend reader. Order submission is a separate
rollout gate; it remains disabled on public deployments while cancellation is missing.

The new tests cover maximum/optional serialization, outcome/side isolation,
spot discriminator rejection, integer boundaries, namespace separation and
shared Rust/TypeScript PDA vectors. They do not prove queue mutation or matching
correctness; those require the placement and matching instructions.
Initialization tests additionally cover canonical binding, the empty root,
unchanged roots on duplicate creation/opening, pre-existing account rejection,
whole-graph rollback and the enlarged creation transaction's packet size.

These accounts follow the spot book's sorted-level and FIFO-link design.
Pure linked-list validation helpers can be shared later, after both versions are
working.

## Core instructions

### Market setup

1. `initialize_prediction_market`
2. `initialize_prediction_position`
3. `deposit_prediction_collateral`
4. `withdraw_prediction_collateral`
5. `open_prediction_market`

Initialization creates the market, collateral vault, metadata, fee account and book
in one transaction. `MarketKind::Prediction` becomes available only through
this instruction; the existing spot initializer must continue rejecting it.

`initialize_prediction_market` is implemented for the draft milestone. It checks
the caller's active `AdminRecord`, validates configuration with Solana Clock,
and creates all five accounts atomically. Any validation failure rolls back
account creation and token CPIs. The vault uses the existing canonical
`["vault-authority", market]` signer and `["vault", market, collateral_mint]`
address. The admin pays rent but does not control the vault's token authority.
Mint decimals must make `payout_per_contract` exactly one collateral token;
zero-decimal mints cannot satisfy the exact Invalid half-payout rule.

The result is `Draft`, with zero supplies, reserve, fees and orders, primary
resolution phase, and no proposal or final outcome. Its book starts at order
ID 1 with four absent best prices. Metadata uses `YES-NO` as
the internal base label and immutable `Prediction` classification. The fee
record reuses `MarketFees`, with collateral in its `quote_mint` field. Existing
spot deposit, matching, metadata-update and fee-withdrawal instructions require
the spot `Market` discriminator and cannot operate on prediction accounts.
Opening and funding use separate instructions. Term updates and account closure
are not implemented. Creation events and indexer event decoding are deferred.

The frontend foundation includes `/predictions`, `/predictions/new`, and
`/predictions/[address]`. The create form reads the original uploaded Arweave
JSON file, validates its structured rules, computes both hashes, derives mint
precision and creates a draft. It does not upload to Arweave or establish that
the URI serves those same bytes. The terms page displays hashes and on-chain
configuration, without claiming the remote question has been verified.

Draft and position creation are disabled unless
`NEXT_PUBLIC_PREDICTION_DRAFTS_ENABLED=true`. Enable
that flag only after deployment of this program version, then rebuild Next.js.
It is a rollout switch rather than an authorization mechanism; on-chain admin
constraints always apply to draft creation, while position creation requires
the owner's signature. Reads remain public and distinguish RPC errors from
an empty result. UI trading actions are not exposed yet.

### Opening (implemented locally)

`open_prediction_market()` takes the stored authority's signature, the canonical
prediction-market PDA and the authority's canonical active `AdminRecord`. It
also requires the stored primary resolver to equal that creator. It accepts only Draft status and a chain Clock
strictly before `close_ts`. At the exact closing second, opening fails.
Success changes only status to Open: rule hashes, resolver windows, vault
identity, balances and aggregate backing do not change. No deposit or complete
set is required first. Repeated calls and attempts to reopen Frozen, Proposed
or Resolved markets fail.

Opening requires both the creator authority and current active admin membership.
Another admin or super-admin has no override merely because of that role.
Disabling or removing the creator's admin record blocks opening. Re-enabling
the same creator permits opening again if the market is still Draft and before
close. This does not disable that wallet's trader withdrawals. An older draft
with a different primary resolver cannot open under this version; recreate it
with matching rules rather than rewriting its committed terms.

The detail page shows lifecycle controls only to the connected market authority,
and disables opening if its admin role is inactive, missing, loading or unreadable.
`NEXT_PUBLIC_PREDICTION_OPENING_ENABLED` defaults false and also requires the
draft rollout flag. Enable it only after deploying the opening instruction.
The client checks the displayed close time and reads fresh terms and the canonical
admin record before signing;
on-chain checks remain authoritative. Confirmation reloads the market and its
position controls. If that read fails, the receipt remains visible and asks for
a refresh instead of inventing a status or reporting the confirmed opening as
failed. Opening currently enables splitting; order placement and settlement
remain unimplemented and the UI says so.

Tests use actual initialized drafts, check unchanged vault/metadata/fee data,
status-only mutation, disabled/removed/substituted/corrupt admin records,
creator versus admin/resolver roles, unsigned accounts,
canonical addresses, account type, close boundaries and whole-transaction
rollback. Collateral round-trip tests now open through this instruction.

### Collateral deposits (implemented locally)

`deposit_prediction_collateral(amount)` requires the position owner's signature,
the canonical prediction-market PDA, the canonical market/wallet position with
matching stored ownership fields, and a legacy SPL source owned by that wallet.
The mint must equal `market.collateral_mint`. The destination must both match
`market.collateral_vault` and derive from `["vault", market, collateral_mint]`,
with the canonical vault-authority PDA as its SPL owner.

Deposits accept Draft, Open, Frozen and Proposed markets. Resolved markets reject
new deposits. The instruction checks positive amount, source funds and checked
addition to `collateral_free`, then calls SPL `TransferChecked` using the mint's
decimals. Only a successful transfer is credited. Other collateral buckets,
outcome quantities, reserve, fees and market state remain unchanged. A failure
rolls back the complete transaction, including preceding deposits in a batch.
SPL token transfers use the wallet signature; the vault authority does not sign
incoming deposits. No YES/NO positions are issued by depositing.

The position panel displays the aggregate collateral balance across wallet token
accounts, accepts exact human-unit amounts, and selects a single owned token
account with enough funds for the transfer. If funds are fragmented across
accounts, selection reports an error; the client does not silently consolidate
them. Wallet read failures disable deposits; position read failures disable all
position actions. Withdrawals do not depend on reading the wallet balance.
Confirmation reloads both
the wallet balance and ledger. Transactions still revalidate all accounts and
amounts because browser balances can become stale.

`NEXT_PUBLIC_PREDICTION_FUNDING_ENABLED` defaults to false and requires the draft
rollout flag as well. It may be enabled explicitly for local tests against the
new binary. Keep it false against older deployments; enable it only after
deploying deposits, withdrawals and complete sets together. This UI flag is not an
on-chain security boundary. Events/indexer integration remain a later milestone.

LiteSVM tests cover successful credits, repeated and multi-wallet conservation,
non-resolved status funding, resolved rejection, signatures, source ownership,
mint/vault/position binding, overflow, insufficient funds, SPL frozen-account
failure and whole-transaction rollback. Client tests cover amount limits and
IDL encoding of the exact atomic amount and account roles.

### Free-collateral withdrawals (implemented locally)

`withdraw_prediction_collateral(amount)` requires the wallet signature, its
canonical position and the market's canonical mint, vault and authority. The
destination must be a legacy SPL token account owned by that wallet and using
the collateral mint. The browser creates the associated token account
idempotently in the same transaction if needed; the wallet pays its SOL rent.
The instruction itself also accepts other valid wallet-owned token accounts.

Only positive amounts up to `collateral_free` can leave the vault. The vault
authority signs `TransferChecked` with its canonical PDA seeds. The transfer
and debit are atomic; locked collateral, outcome balances, reserve and fees
remain unchanged. Withdrawals work in every lifecycle status, including after
close and resolution. They do not redeem outcomes. Failed wallet-balance reads
do not block withdrawing a known free balance, but position read errors do.

### Complete sets (implemented locally)

`split_prediction_complete_set(quantity)` takes a positive whole number of
pairs. It requires Open status and `Clock.unix_timestamp < close_ts`. Each pair
debits `payout_per_contract` atoms from free collateral, increases backing by
the same amount, and adds one YES and one NO to both the wallet and market
supplies. It creates internal positions, not SPL token mints.

`merge_prediction_complete_set(quantity)` burns equal quantities of free YES
and NO, decreases both supplies and reserve, and credits their full backing to
free collateral. Open, Frozen and Proposed markets allow merging, including
after close. Draft and Resolved markets reject it; resolved markets will use
outcome redemption. Locked outcomes cannot be merged. A complete pair has a
fixed payout regardless of the eventual result, so no oracle price is needed.

Example with six-decimal collateral: deposit 10 tokens, split 3 pairs, then
merge 1 pair. The wallet has 8 free collateral, 2 YES and 2 NO, and the market
reserves 2 tokens. Withdrawing 8 leaves the 2-token backing in the vault.

Splitting and merging do not transfer SPL tokens. Every multiplication, credit,
debit, supply and reserve change uses checked arithmetic. The market is writable
because it stores aggregate supply and backing: this serializes operations
within a market, but makes exact reserve accounting simple. No protocol fee is
charged for either conversion. Trading fees belong to matching, added later.

The UI takes whole pairs separately from decimal cash amounts, shows the exact
collateral reserved/released, and refreshes position and reserve after confirmation.
It rejects fractional contracts and excludes locked balances when checking funds.
Chain checks remain authoritative if prices, timestamps or balances change.
The authority can open a new draft through `open_prediction_market`; integration
tests use that transition before splitting rather than directly setting Open.

Tests cover full and partial round trips, two-wallet conservation and isolation,
all lifecycle gates, the exact close boundary, locked funds, zero amounts,
overflow/underflow, unsigned or substituted accounts, SPL CPI failure and batch
rollback. Typed events/indexer decoding remain a later milestone.

### First resting order (implemented locally)

`place_prediction_order(order_id, outcome, side, price, quantity)` is callable
by any signing trader with an initialized position. No admin record is needed.
It requires canonical market, position and book accounts with matching stored
ownership, Open status and a chain Clock strictly before close. Quantity is a
positive whole u64. Price is positive, below payout and divisible by the tick.

This first path accepts only an empty selected outcome/side list. A buy at or
above that outcome's best ask, or a sell at or below its best bid, is rejected.
There is no cross-outcome matching. Same-price append uses its own instruction;
new-price insertion uses a separate instruction, and crossing orders still need matching. The program does not silently create a crossed
book or skip existing priority.

A buy locks exactly `price * quantity` collateral atoms. A sell locks exactly
`quantity` free YES or NO contracts. Already locked assets are unavailable for
new orders. Free-to-locked movement preserves the trader's total claim; vault
tokens, payout reserve, outcome supply and accrued fees are unchanged. Resting
placement charges no taker fee and reserves no extra fee budget in this step.

The instruction creates a canonical level and order using plain Anchor `init`.
The level has one order, no price neighbors, and the same first/last order key.
The order has Open status, its full submitted quantity remaining and no FIFO
neighbors. The selected book head becomes its price, the global next ID advances,
and the market open-order count increases. All arithmetic is checked and all
mutations/account allocations roll back together on failure. An ID must match
the book's next positive ID; stale, reused or overflowing IDs cannot reset state.

The position panel exposes a buy/sell form with a YES/NO selector, decimal price
and whole contracts. It displays the exact amount to lock, re-reads market/book/
position before signing, and refreshes public heads and wallet position balances
after confirmation. A stale concurrent submission still fails on chain and must
refresh/retry. The receipt is held outside the loading form so refreshing cannot
erase a confirmed transaction.

`NEXT_PUBLIC_PREDICTION_ORDERS_ENABLED` defaults false and requires the draft and
funding flags. It is for explicit local resting-order tests only until cancellation
and matching are implemented/deployed. Orders already placed cannot be canceled
in this version, so their claims stay locked. This flag is rollout, not on-chain
authorization. Do not enable public order entry with this incomplete lifecycle.

Example: buying 10 YES at 0.60 locks 6 collateral tokens. Selling 10 YES locks
10 existing YES contracts, not 6 collateral tokens. Splitting may create those
YES contracts first; an uncovered sell is rejected.

Tests use a non-admin trader with real initialization/opening, deposit and split
instructions. They cover all four heads, linked-account contents, unchanged
custody/backing/fees, role independence, invalid timing/grid/quantity, funding
shortfalls, occupied/crossing rejection, checked arithmetic, account binding,
ID reuse and full rollback of multi-instruction placements. Client tests check
preflight bounds, exact units, account metadata, enum encoding and packet size.

### Same-price FIFO append (implemented locally)

`append_prediction_order(order_id, outcome, side, price, quantity)` uses the
same signer, canonical market/position/book, lifecycle, price, quantity, ID and
funding rules as empty-side placement. Those rules live in a shared internal
module so the two instructions cannot silently disagree about funding or close
time. A canonical existing level and its current tail are additionally required.

The level's stored market/outcome/side/price must match its seeds. Its endpoints
and counters must describe a nonempty queue. The supplied tail must be a
canonical prediction order for this market and equal `level.last_order`. It
must be Open with positive remaining quantity, matching outcome/side/price/level,
no next order and an older ID. Single-order queues require first = last, no
previous link and an exact remaining total; longer queues require a distinct
first order and a previous link on the tail. The best level has no better
neighbor; a non-best level must retain a better link and agree with best-price
ordering. These bounded checks do not traverse or re-audit the entire price list;
insertion and future cancellation must preserve that program-owned structure.

The new order receives `previous_order = old_tail` and `next_order = None`.
Only `old_tail.next_order` changes on the existing order. The level keeps its
first order, rent payer and price neighbors, moves its last pointer to the new
order and adds the new remaining quantity and order count. The book heads stay
unchanged while its ID and market-wide order count advance. Counter overflow,
insufficient funds or stale links roll back all changes and new account rent.
Tokens, backing, supplies and accrued fees do not move.

The tail may belong to another trader: Bob can append after Alice without her
signature. Alice's balances and every order field except `next_order` stay
unchanged. Bob signs, locks only his own free cash/contracts and pays rent only
for his new order. Appending never buys an earlier position in the FIFO queue.

The form reads the canonical requested price level. If it exists, it reads the
stored last order and chooses append. If it is absent and that side is empty,
it chooses first placement. An absent price on an occupied side selects sorted
insertion using the neighboring levels described below. RPC/decode failure never
falls back to another path. Before signing, the client reads fresh market,
position, book, level and tail data; another transaction can still invalidate
that snapshot, in which case the chain rejects it atomically and the user retries.

The existing order rollout flag remains false publicly while cancellation is
missing. Tests verify three-order FIFO queues for both outcomes and sides,
different traders, unchanged maker balances, reserve conservation, substituted
and stale tails, corrupt endpoints/identity, timing/funding/counter failures,
real cross-outcome orders, signatures and multi-append rollback. Client tests
cover routing, failed RPC reads, queue preflight, account roles and packet size.

### New-price insertion (implemented locally)

`insert_prediction_order(order_id, outcome, side, price, quantity)` creates a
new level and its first order on an occupied side. It uses the shared price,
time, funding and counter checks. Existing levels must use append; Anchor
`init` prevents overwriting an existing queue. Empty sides use first placement.

Buys sort highest first; sells sort lowest first. The client supplies:

| Position  | Better neighbor    | Worse neighbor |
| --------- | ------------------ | -------------- |
| New best  | Absent             | Current best   |
| Middle    | Previous level     | Next level     |
| New worst | Current last level | Absent         |

Each neighbor must be a canonical prediction level for the market, outcome and
side, with an active queue. Middle insertion requires reciprocal links proving
that the levels are adjacent. Best insertion verifies the book head; worst
insertion requires the better neighbor's terminal link. Strict ordering prevents
equal prices and reversed hints. Invalid hints return `InvalidPredictionPriceLevel`;
Anchor rejects duplicate mutable neighbors before the handler runs.

The instruction rewires both neighbors and creates the one-order FIFO queue.
Only a new best changes the head. Funding, IDs, counts and links commit together;
a stale hint or later failing instruction rolls everything back, including new
accounts. Existing traders need not sign and their balances do not change.
No token transfer, reserve change or fee accrual occurs.

This costs two new rent-funded accounts and up to two neighbor write locks.
On-chain insertion is O(1). The browser follows the existing list from its head,
validates reciprocal links and ordering, and stops after 128 levels. This bounded
off-chain search is O(n); exceeding its limit disables submission rather than
guessing a gap. A future indexer can supply hints without changing on-chain
validation. RPC/decode errors propagate, and pre-signing reads refresh hints;
concurrent changes can still require a retry.

Tests cover best/middle/worst insertion on all four lists, FIFO append at an
inserted middle price, unrelated traders, funding and lifecycle failures,
crossing rejection, forged identities, stale/nonadjacent hints, counter bounds
and transaction rollback. Client tests cover routing, bad links, the search cap,
RPC failures, optional-account encoding and transaction size.

### Trading still to implement

The resting paths above are implemented without taker fees. Future crossing
orders need bounded matching, fee checks and a safe resting-remainder path.

Matching will transfer an internal outcome position from seller to buyer and move
the maker-price collateral from buyer to seller. It does not transfer SPL
tokens because both traders already hold claims against the same vault.

Cancellation must remain available after the market freezes or resolves. It will
release only the unfilled collateral or positions. Planned redemption initially
requires positions to be free, so users cancel resting orders before redeeming.

### Resolution and redemption

The creator is the trusted primary outcome decision-maker. The initializer
already binds `resolver == authority`; proposal, finalization and redemption
instructions are still planned. The permissions for those instructions are:

| Action | Required permission |
| --- | --- |
| Create draft | Active admin |
| Open | Stored creator and active admin; enforced now |
| Administrative trading closure | Stored creator and active admin; planned |
| Primary outcome proposal/correction | Stored creator and active admin; planned |
| Fallback proposal/correction | Predeclared fallback resolver and active admin; planned |
| Finalize after review delay | Anyone may execute the fixed result; cannot choose or replace it; planned |
| Claim payout | Owner of the winning positions; no admin role; planned |
| Withdraw free collateral | Position owner; no admin role; enforced now |

Administrative trading closure stops new orders; it does not destroy collateral
or pay out claims. The fixed close timestamp must also stop placement and
matching automatically, without waiting for an admin transaction. A later
account-deletion instruction must require the creator and active admin status
and reject outstanding orders, cash claims, outcome claims, reserves or fees.
Neither trading closure nor admin revocation may block trader cancellation,
withdrawal or redemption. These prediction-closure instructions are not yet
implemented; the spot `close_market` instruction cannot close a prediction account.

The planned settlement flow is:

1. All placement and matching instructions reject `now >= close_ts`, even if
   nobody has called the permissionless freeze instruction yet.
2. At `earliest_resolution_ts` (or `close_ts` when absent), the creator, while
   still an active admin, may propose `Yes | No | Invalid`, with an evidence URI and hash. If configured,
   its proposal window ends at `fallback.available_ts`; otherwise it has no end.
3. When fallback is configured and no primary proposal exists at its activation
   time, anyone may activate it. The primary window stays closed even if
   activation is delayed. Only the fixed fallback resolver, while an active admin, may then propose,
   before `fallback.deadline_ts` when that deadline exists.
4. Every proposal waits `resolution_delay_seconds`. Only the resolver for the
   active phase, still an active admin, may correct it during that delay; each correction records new
   evidence and restarts the full delay. Corrections must also occur before
   that resolver's proposal deadline when configured. Super-admin has no separate outcome
   override.
5. Anyone may finalize after the delay, including a winning trader. This only
   accepts the already proposed outcome; the caller cannot choose YES or NO.
   Admin revocation after a valid proposal must not block finalization or claims.
   A timely proposal may finalize after
   its proposal deadline. If a primary proposal exists, fallback does not
   replace it; this first version handles resolver silence, not disputes.
6. If a fallback deadline exists and neither resolver proposed by it, anyone may finalize
   the precommitted `Invalid` outcome. Timeout settlement must reject an
   existing proposal, and timeout evidence is the on-chain absence of one.
7. Traders redeem free outcome positions into free collateral, then withdraw.
   They do not need an admin transaction or admin role to claim their winnings.

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

The remaining implementation is grouped into four milestones. Each includes
its tests, frontend and documentation; grouping does not remove the safety checks.

1. **Collateral recovery — implemented locally.** Position ledgers, deposits and
   withdrawals, with owner checks and atomic SPL custody.
2. **Complete sets — implemented locally.** Split/merge with exact backing,
   free/locked separation and conservation tests.
3. **Trading — started locally.** Opening, atomic book initialization, empty-side
   placement, same-price FIFO append and new-price insertion are implemented. Next: cancellation,
   bounded matching, fees, trading UI, typed events and indexer decoding.
4. **Resolution and integration.** Freeze, propose, finalize, fallback/Invalid
   handling, redemption and its UI. Add atomic position switching with execution
   limits and rollback tests, then run a full devnet lifecycle. Oracle adapters
   remain outside the first version.

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
