# Multi-outcome prediction markets

Status: contracts, linked price-time books, multi-maker transaction builders,
creation/discovery/trading/claims UI, and indexer event decoding are implemented
and checked locally. The shared app exposes `/predictions/multi` and
`/predictions/multi/new`. Transactions require both
`NEXT_PUBLIC_SHARED_BALANCES_ENABLED=true` and
`NEXT_PUBLIC_MULTI_OUTCOME_ENABLED=true`. The matching program was deployed to
devnet on 21 November 2026 and passed a live two-wallet lifecycle smoke test
(see [deployment](deployment.md)). Production enabled the UI flag the same day.
Production has no indexer configured, so multi-outcome screens read accounts
directly over RPC; indexed history arrives when an indexer is deployed.

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
costs. Local LiteSVM tests now measure signed legacy transaction size and compute
for eight-outcome creation, custody, placement, atomic matching, resolution and
redemption. These measurements cover the documented fixtures, not every possible
account/label combination or production throughput.

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
outcome ID or Invalid. Binary and multi-outcome markets share one lifecycle
implementation (`programs/outcomia/src/resolution.rs`), including the per-phase
correction deadline described in
[shared balances and settlement](shared-balances-resolution.md#resolution). Owners retain cancellation and withdrawal rights after
closure. Redemption must burn claimed positions once and reconcile actual vault
backing, including contracts released by canceled sell orders.

## Compatibility

Do not extend or reorder `PredictionOutcome`, `PredictionResolution` or
`SharedOutcome` to reinterpret deployed binary accounts. New multi-outcome
layouts and PDA namespaces are separate from existing binary accounts.
Existing YES/NO markets and their clients continue using their current types.
The new multi-outcome instructions require a separate deliberate program upgrade;
that release step has not been performed.

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
liability with recorded and physical reserve backing. Trading and claim
handlers enforce those same accounting relationships.

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
   separate redemption path; they cannot merge against final liabilities.

Each quantity vector is validated, including zero inactive slots. Checked state
updates are calculated before the token CPI. A rejected CPI or serialization
failure rolls back the whole transaction. The reserve must physically cover its
recorded liability; exact equality is deliberately not required because anyone
can donate SPL tokens to a vault. Donations create no claims and cannot block
legitimate exits. A donation-recovery instruction is not part of this milestone.

Nine multi-outcome event types cover creation, lifecycle, positions, complete
sets, orders, fills, fees, resolution and redemption. The indexer decodes all nine
with independent wire fixtures and rejects malformed/trailing bytes. Query
projections and an indexing API remain outside this change.

## Linked order books and atomic batches

`MultiOutcomeBook` stores 16 roots: a bid and ask ladder for each of eight possible
outcomes. Every `MultiOutcomeOrder` has reciprocal previous/next links. Orders
are sorted by maker price, then increasing acceptance ID at equal prices. This
is an order-level ladder, without a separate aggregated price-level account.
There is no 64-order cap or book-wide vector scan. Placement validates the exact
insertion neighbors; cancellation and full fills repair the adjacent links.
One integration test places 70 orders and exercises head/middle/tail removal
and rollback with an unrelated neighbor.

The browser validates all reachable links, market/PDA identities, counts and
priority before planning a transaction. It packs up to three maker fills, then
a resting remainder only when no crossing maker remains. A packet-size limit
may reduce that batch. Unsubmitted quantity remains explicit for a fresh retry;
the client never skips a crossing FIFO order or silently broadcasts another
transaction. The program revalidates the live queue. A stale second instruction
rolls back all earlier fills in the transaction.

The former bounded multi-outcome book layout was local-only. Its replacement
changes multi-outcome book/order layouts and instruction accounts. Rebuild the
program and sync the app IDL together. Deployed binary/spot layouts and error
codes remain unchanged; the obsolete capacity error retains its ABI number.

## Creation transaction size and staged terms

Short-label creation transactions for all 2–8 outcomes fit within 1,232 bytes.
Combining maximum-length labels, URI and optional fields exceeds that legacy
packet limit. The UI checks every assembled transaction before wallet approval.
It uses direct creation when it fits, otherwise uploads serialized terms in
contiguous chunks of at most 600 bytes to the creator's canonical buffer.

Final creation binds the exact SHA-256 of that buffer and runs the normal
active-admin, mint, time, label, lot and reserve validation. Uploads alone create
no market or customer claims. Wrong owners, offsets and hashes fail. The creator
can close the buffer to recover rent; the UI does this after creation and also
finds abandoned buffers on-ledger for recovery after a reload. Terms become
immutable only in the created market. Each upload/creation requires its own
wallet approval; no staged submission is retried automatically.

Creation follows the binary prediction-market layout: Market details, a shared
structured Market rules editor, JSON preview/download, and explicit review.
Each named outcome has its own winning criteria; common evidence, Invalid,
timing and fallback policies use the same editor as binary markets. The full
question and exact generated JSON bytes are hashed, with the ordered labels
and Invalid refund policy checked before upload. The default flow publishes
rules through the existing Arweave/Turbo message-signing path, verifies the
returned bytes, and saves a reusable upload receipt. An advanced option accepts
an existing HTTPS/Arweave document only when its bytes match the generated JSON.
Contract lot overrides are under Advanced trading settings; leaving the field
blank chooses the smallest exact Invalid refund lot. Editing a form field or
changing the creator wallet clears review approval. Splits/merges, open-order cancellation,
resolution/correction/finalization and redemption are available on market detail.
Collateral funding reuses the existing shared-wallet controls. The shared Wallet
and Orders routes include multi-outcome positions and orders, and the asset
catalog includes collateral listed only by a multi-outcome market. Super-admins
can withdraw only the current book's accrued fees from market detail.

## Local verification

`anchor build`, `cargo test -p outcomia` and strict all-target Clippy pass locally.
The full program suite has 379 tests, including 14 multi-outcome order/staging
tests and 17 custody tests. Indexer tests pass 75 regular checks and eight
PostgreSQL integration checks against an isolated local database. Client tests use the
real IDL to check tuple OutcomeIds, exact fees, reciprocal links, self-trades,
lots, safe remainders, maximum terms and signed packet sizing.

The eight-outcome budget fixture reports:

| Operation | Signed legacy bytes | Compute units |
| --- | ---: | ---: |
| Short-label creation | 842 | 35,270 |
| Complete-set split | 484 | 37,683 |
| First resting order | 404 | 35,521 |
| Same-price append | 436 | 39,255 |
| Two atomic maker fills | 536 | 90,848 |
| Proposal | 303 | 13,208 |
| Finalization | 211 | 10,511 |
| Redemption | 539 | 36,222 |
| Staged creation, maximum labels/URI | 569 | 46,956 |

Run `anchor build` before tests; LiteSVM embeds `target/deploy/outcomia.so`.
Run `npm --prefix app run idl:sync` after building and `npm --prefix app run
idl:check` to compare the compiled ABI. IDL sync preserves top-level entry order
and documentation, while instruction accounts, fields and variants retain their
generated wire order.

`npm --prefix app run test:multi-outcome` checks the client. The local browser
fixture uses an ephemeral wallet and mock RPC, blocks external requests, and
exercises Wallet/Orders discovery, cancellation, rejected wallet approvals,
capped matching and exact remainder retry, fees, proposal/finalization, claims,
creation with published-rule verification, review reset, abandoned-upload recovery,
navigation cancellation and mobile layout. It never reads the CLI keypair.
The audit also runs this flow against a feature-enabled production build and a
separate disabled production build that must submit no transactions. See the
[audit record](multi-outcome-audit.md).

```bash
# Terminal 1
OUTCOMIA_BUILD_DIR=.next-multi-browser NEXT_PUBLIC_SHARED_BALANCES_ENABLED=true \
NEXT_PUBLIC_MULTI_OUTCOME_ENABLED=true npm --prefix app run dev -- \
  --hostname 127.0.0.1 --port 3017
# Terminal 2 (provide locally installed Playwright/Chromium paths if needed)
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
MULTI_BROWSER_EXECUTABLE=/path/to/chromium \
node app/scripts/multi-outcome-browser.test.mjs
```

Screenshots go to ignored `target/multi-browser-artifacts`. Local mocks do not
establish public-network deployment, wallet compatibility or live execution.

## Delivery checkpoints

1. **Foundation (implemented locally):** bounded IDs, resolution types, wire-format tests and this design.
2. **State and arithmetic (implemented locally):** immutable terms/layouts, lot/precision validation,
   exact payout helpers and conservation tests.
3. **Custody (implemented locally):** market creation, shared-wallet complete-set split/merge and exits.
4. **Trading (implemented locally):** linked price-time placement, cancellation, atomic bounded client matching and fees.
5. **Resolution and UI (implemented locally):** proposals, finalization, claims, creation/discovery and
   full-lifecycle tests. Deployment and live smoke are separate release steps.

Clubs/private participation and governance follow this feature. Their access
policies must preserve owner exits and must not alter collateral payout rules.
