# Multi-outcome prediction markets

Status: foundation only. `state/multi_outcome.rs` defines bounded outcome IDs
and single-winner resolution types. No account initializer, trading instruction,
UI or deployed multi-outcome market exists yet.

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

## Delivery checkpoints

1. **Foundation:** bounded IDs, resolution types, wire-format tests and this design.
2. **State and arithmetic:** immutable terms/layouts, lot/precision validation,
   exact payout helpers and conservation tests.
3. **Custody:** market creation, shared-wallet complete-set split/merge and exits.
4. **Trading:** outcome-specific placement, cancellation, FIFO matching and fees.
5. **Resolution and UI:** proposals, finalization, claims, creation/discovery and
   full-lifecycle tests. Deployment and live smoke are separate release steps.

Clubs/private participation and governance follow this feature. Their access
policies must preserve owner exits and must not alter collateral payout rules.
