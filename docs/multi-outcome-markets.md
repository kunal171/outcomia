# Multi-outcome prediction markets

Status: market creation and complete-set custody implemented and tested locally.
`state/multi_outcome.rs` defines immutable terms and new market/position layouts;
`multi_outcome.rs` validates terms and computes exact liabilities. New instructions
create/open/freeze markets and split/merge funded complete sets. Outcome-specific
orders, resolution/redemption instructions, UI and deployment remain outstanding.

## Scope

A market has 2–8 named outcomes and exactly one winner. For example, an election
with candidates A, B and C. Markets with several simultaneous winners need a
different payout model and are outside this milestone.

Outcome IDs are immutable zero-based list indices. Names and list order are fixed
before opening; otherwise an existing order could silently refer to a different
candidate. Invalid is a resolution result, not another asset that users trade.
An ID is valid only relative to the actual market's outcome count. Structural
Borsh decoding does not perform that economic validation.

The eight-outcome cap bounds account sizes, complete-set work and validation
costs. It is an initial engineering limit, not a claim that eight outcomes fit
within the current transaction budget. Measure that when instructions exist.

## Collateral and complete sets

Let N be the outcome count, P the face payout in collateral atoms, and Q the
number of complete sets. Locking Q × P creates Q contracts for every outcome.
Merging Q of every outcome burns those contracts and returns Q × P.

A contract for the winning outcome pays P atoms; a losing contract pays zero.
A market with three outcomes does not need three times the backing for a single
complete set: exactly one of its three contracts wins.

Shared asset wallets remain the funding source. Collateral reserved for outcome
payouts, free trader collateral, order escrow and earned fees stay separately
accounted. Moving a contract between traders does not create more reserve.

## Invalid results and exact refunds

Invalid refunds an equal share of face value to each outcome. Every accepted
quantity must be a multiple of the immutable contract lot L, and initialization
must require:

`(L × P) % N == 0`

Use checked/widened integer arithmetic, not floating point. Matching, splitting,
merging and redemption must preserve the lot rule; applying it only to initial
placement is insufficient.

Example: N=3 and P=1,000,000 atoms (one six-decimal collateral token).
A one-contract lot cannot support exact equal Invalid refunds. L=3 works:

| Operation | Result |
| --- | --- |
| Split three complete sets | Lock 3 tokens; receive 3 A, 3 B and 3 C |
| A wins; redeem 3 A | Receive 3 tokens |
| Invalid; redeem 3 of any outcome | Receive 1 token |
| Merge 3 A + 3 B + 3 C before final settlement | Receive 3 tokens |

This avoids unequal dust allocation and claimant-order dependence. The tradeoff
is a larger minimum quantity for some outcome counts. With four outcomes and
six-decimal collateral, L=1 already permits exact quarter-token refunds. The UI
must show the actual minimum quantity and face payout before order submission.
Never silently round a payout or use another trader's cash to cover a remainder.

## Trading and resolution

Each outcome has independent buy/sell price priority and FIFO queues. A buy for
A matches a sell for A. Cross-outcome matching is a separate later feature;
several price displays do not imply shared liquidity.

Reuse shared wallet custody, bounded matching and signed fee quotes, with new
market/account namespaces and explicit outcome ID checks. Resolution follows the
agreed creator/admin, review-delay and fallback model, but chooses a winning
outcome ID or Invalid. Owners retain cancellation and withdrawal rights after
closure. Redemption must burn claimed positions once and reconcile actual vault
backing, including contracts released by canceled sell orders.

## Compatibility

Do not extend or reorder `PredictionOutcome`, `PredictionResolution` or
`SharedOutcome` to reinterpret deployed binary accounts. New multi-outcome
layouts and PDA namespaces will be specified before their initializer is added.
Existing YES/NO markets and their clients continue using their current types.
Nothing in this foundation requires a devnet upgrade.

## Account layouts and validation

These new accounts do not reinterpret existing binary data:

| Account | Maximum Borsh payload | With 8-byte discriminator | Seeds |
| --- | ---: | ---: | --- |
| `MultiOutcomeMarket` | 1,440 bytes | 1,448 bytes | `multi_market`, market ID |
| `MultiOutcomePosition` | 193 bytes | 201 bytes | `multi_position`, market, owner |

The market stores immutable terms, a pending/final resolution, eight outstanding
supply counters and reserve accounting. A position stores eight free and eight
locked contract quantities. Cash remains in the shared per-asset account.
Outcome count is derived from the immutable label list, rather than maintaining
a second counter that could disagree. Labels are distinct exact UTF-8 strings,
trimmed and at most 64 bytes; this does not normalize Unicode or prevent visually
confusable names. Rules hashes commit the exact published document bytes.

Only the first N quantity slots are active; the rest must be zero. Active
quantities must follow the lot rule. Before resolution all active supplies must
be equal: every complete-set split/merge changes them equally. After resolution,
claims reduce them independently. Remaining liability is the winning supply
multiplied by P, or the sum of exact per-outcome Invalid refunds. Zero-valued
losing positions can remain after the cash reserve reaches zero and must still
be clearable by their owner.

The creation validator checks labels, payout/tick/lot, resolver, optional windows,
review-delay overflow and rules commitments. It also rejects terms where one
complete-set lot cannot fit within u64 collateral capacity. Arithmetic widens
to u128 before multiplication and narrows only after any exact division.

These are pure checks, not authorization or proof of token custody. The initializer uses chain Clock, requires the active-admin creator as resolver,
checks the legacy SPL mint and canonical vault accounts, and fixes the terms.
Custody derives economics from the actual market, verifies ownership and compares
liability with recorded and physical reserve backing. Future trading and claim
handlers must preserve those relationships too.

## Implemented custody flow

1. `initialize_multi_outcome_market` creates a Draft, canonical SPL reserve and
   metadata atomically. The creator must be an active protocol admin. A winning
   contract pays one actual collateral token (`10^mint.decimals` atoms); the lot
   rule makes equal Invalid refunds exact. Zero-decimal collateral cannot offer
   a valid sub-face raw price tick in this first version.
2. `initialize_multi_outcome_position` creates an empty position for its signer.
   It does not require an admin or an Open market and rejects duplicates.
3. `open_multi_outcome_market` requires the same active-admin creator and a Draft
   before cutoff. Only status changes; it does not create a trading book yet.
4. `multi_outcome_complete_set(quantity, split)` moves actual SPL backing between
   the shared mint vault and this market's reserve. Splitting debits free cash
   and issues Q of each active outcome; merging burns Q free contracts from
   every outcome and credits shared free cash. Locked cash/contracts are excluded.
5. `close_multi_outcome_trading` freezes an Open market under its active-admin
   creator. Splits stop at closure/cutoff. Owner merging remains available while
   Open/Frozen/Proposed, without an admin check. Resolved markets must use the
   separate future redemption path; they cannot merge against final liabilities.

Each quantity vector is validated, including zero inactive slots. Checked state
updates are calculated before the token CPI. A rejected CPI or serialization
failure rolls back the whole transaction. The reserve must physically cover its
recorded liability; exact equality is deliberately not required because anyone
can donate SPL tokens to a vault. Donations create no claims and cannot block
legitimate exits. A donation-recovery instruction is not part of this milestone.

Each successful creation, lifecycle change, position initialization and complete-
set movement emits a dedicated multi-outcome event. Indexer decoding and client
rollout must include these before enabling the feature publicly.

## Creation transaction size

Tests serialize signed legacy creation transactions for 2–8 short outcome labels
and confirm they fit within 1,232 bytes. Maximum account allocation is not the
maximum transport size: combining all maximum label/URI lengths and optional
fields exceeds a single packet. The future creation UI must check the assembled
transaction and request shorter fields or use a separately designed staged-terms
flow. Staged configuration is not implemented. Do not present every combination
of per-field allocation bounds as a supported single-transaction form.

## Verification

The local Rust suite passes 83 unit tests. The new nine checks cover maximum
serialization sizes and distinct discriminators, UTF-8 limits, bad schedules,
precision, unused slots, overflow and supply mismatches. A 224-case grid spans
2–8 outcomes and 32 complete-set quantities, checking every winner and Invalid.
Sequential claims reconcile each payout against the remaining liability;
separate claims equal batched claims. Existing binary enum/layout tests pass.
A separate 17-test LiteSVM suite now executes the SBF instructions with actual
SPL transfers. It covers lifecycle/role gates, creation rollback, wrong accounts,
shared funding, duplicates, exact split/merge/withdrawal, frozen-vault rollback,
physical underbacking and unsolicited donations. The complete program suite
passes 365 tests, including existing binary/spot flows; strict Clippy across all
targets and the Anchor build also pass. No live deployment is claimed.

Run `anchor build` before `cargo test -p outcomia`, because LiteSVM tests embed
the generated SBF artifact. These are local checks and do not deploy anything.

## Delivery checkpoints

1. **Foundation (implemented locally):** bounded IDs, resolution types, wire-format tests and this design.
2. **State and arithmetic (implemented locally):** immutable terms/layouts, lot/precision validation,
   exact payout helpers and conservation tests.
3. **Custody (implemented locally):** market creation, shared-wallet complete-set split/merge and exits.
4. **Trading:** outcome-specific placement, cancellation, FIFO matching and fees.
5. **Resolution and UI:** proposals, finalization, claims, creation/discovery and
   full-lifecycle tests. Deployment and live smoke are separate release steps.

Clubs/private participation and governance follow this feature. Their access
policies must preserve owner exits and must not alter collateral payout rules.
