# Multi-outcome prediction markets

Status: state and arithmetic implemented locally. `state/multi_outcome.rs`
defines outcome IDs, immutable terms and new market/position layouts.
`multi_outcome.rs` validates creation terms and calculates exact collateral
liabilities. No account initializer, trading instruction, UI or deployed
multi-outcome market exists yet.

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

| Account | Maximum Borsh payload | With 8-byte discriminator | Planned seeds |
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

These are pure checks, not authorization or proof of token custody. Initializers
must use chain Clock, verify an active-admin creator/resolver and canonical SPL
mint/vault accounts, and freeze the validated terms. Trading/custody handlers must
derive economics from the actual market, verify ownership and compare liability
against both the recorded reserve and the physical vault. No caller-supplied
array or helper return value can establish those account relationships.

## Verification

The local Rust suite passes 82 unit tests. The new nine checks cover maximum
serialization sizes and distinct discriminators, UTF-8 limits, bad schedules,
precision, unused slots, overflow and supply mismatches. A 224-case grid spans
2–8 outcomes and 32 complete-set quantities, checking every winner and Invalid.
Sequential claims reconcile each payout against the remaining liability;
separate claims equal batched claims. Existing binary enum/layout tests pass.
These checks do not exercise SPL transfers, new instruction authorization or a
live multi-outcome market; those paths are not implemented.

## Delivery checkpoints

1. **Foundation (implemented locally):** bounded IDs, resolution types, wire-format tests and this design.
2. **State and arithmetic (implemented locally):** immutable terms/layouts, lot/precision validation,
   exact payout helpers and conservation tests.
3. **Custody:** market creation, shared-wallet complete-set split/merge and exits.
4. **Trading:** outcome-specific placement, cancellation, FIFO matching and fees.
5. **Resolution and UI:** proposals, finalization, claims, creation/discovery and
   full-lifecycle tests. Deployment and live smoke are separate release steps.

Clubs/private participation and governance follow this feature. Their access
policies must preserve owner exits and must not alter collateral payout rules.
