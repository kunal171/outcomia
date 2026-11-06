# Shared balances and prediction settlement

## Shared wallet

One `AssetBalance` belongs to `(owner, mint)`. It holds available and locked
atoms for that asset across all shared-wallet books. Depositing once makes free
USDC available to both SOL/USDC and BTC/USDC. An order moves only its required
asset from available to locked; cancellation releases only the unfilled lock.

One SPL vault per mint backs these claims. Vault authority is a PDA, never an
administrator wallet. Matching changes internal claims without a token CPI.
Fees belong to the book that earned them and cannot be withdrawn as user cash.

Prediction YES/NO positions and reserves remain specific to their question.
Splitting transfers global collateral into the question's existing reserve
vault; merging or redemption transfers backing out and credits global cash.
A reserve cannot fund another market's order or withdrawal.

## Existing devnet accounts

Existing market/position layouts and recovery instructions remain intact.
Shared-wallet books use their own root, order and level PDAs. They never
reinterpret legacy locks as global money or overwrite an existing order queue.
Users can cancel legacy orders, then move free legacy deposits to their shared
wallet with an owner-signed transfer. Shared balances start at zero; they are
credited only when real tokens arrive. The UI identifies legacy balances and
orders and never adds them twice.

Shared books are a new execution path. Existing per-market books are not
silently mixed with their liquidity. The transition UI provides explicit
migration and cancellation rather than pretending older funds were upgraded.

## Conservation

For each mint:

```text
shared vault = sum(global free + global locked) + sum(shared-book fees)
```

For each prediction market before resolution:

```text
reserve vault = legacy free/locked cash + backing reserve + legacy fees
backing reserve = YES supply * payout = NO supply * payout
```

After resolution:

```text
backing reserve = YES supply * YES payout + NO supply * NO payout
```

Global locked cash backs spot orders and prediction buy orders. Prediction
sell orders lock whole outcome contracts in the market position. Fills must
preserve the corresponding vault equation across both traders and fees.

## Resolution

The fixed creator/primary resolver proposes YES, NO or Invalid while an active
admin, after trading closes and the earliest resolution time. Corrections
restart the review delay and must respect the same proposal window.

The configured fallback handles resolver silence. Activation and finalization
are permissionless; proposing/correcting still requires the configured resolver
and an active admin record. A timely primary proposal cannot be replaced by
fallback. A configured fallback deadline with no proposal enables the committed
Invalid outcome. No deadline means no automatic timeout.

Anyone can finalize a mature proposal. The caller cannot choose a different
outcome. Admin revocation after proposal must not trap claims. YES pays the
whole payout on Yes, NO on No; Invalid pays half to each. Payout must be even.
Redeeming burns only the owner's free contracts, decreases supply and reserve,
and credits the same owner's shared asset balance. Locked contracts must be
canceled first. Repeating redemption cannot pay the same contracts twice.

## Tradeoffs and checks

A shared wallet improves capital reuse. A trader's same-mint account becomes a
shared writable account across markets, so those transactions can contend.
Vaults are writable during custody moves, not ordinary matching. Legacy
recovery adds temporary client complexity but avoids deleting existing claims.

Coverage must include cross-market spending, duplicate initialization, wrong
owners/mints/vaults, shared/legacy conservation, frozen-order cancellation,
rounding/fees, stale FIFO hints, deadlines, fallback/corrections, repeated claims
and transaction-wide rollback. New clients remain gated until the matching
program is deployed. Prediction-specific typed indexing is a separate task;
source ingestion must be extended before new event types are emitted publicly.

## Instruction map

| Operation | Instruction | Who signs |
| --- | --- | --- |
| Create mint ledger / deposit / withdraw | `initialize_asset_balance`, `deposit_asset`, `withdraw_asset` | Asset owner |
| Move old free cash | `migrate_spot_asset`, `migrate_prediction_asset` | Asset owner |
| Enable a shared book | `initialize_shared_book` | Stored market creator, active admin |
| Place / fill / cancel | `place_shared_order`, `match_shared_order`, `cancel_shared_order` | Trader / taker / order owner |
| Withdraw book fees | `withdraw_shared_fees` | Protocol super-admin |
| Drain book before shutdown | `close_shared_book` | Stored creator, active admin |
| Move backing into/out of complete sets | `shared_complete_set` | Position owner |
| Stop trading early | `close_prediction_trading` | Stored creator, active admin |
| Propose / correct outcome | `propose_prediction` | Current configured resolver, active admin |
| Advance a clock | `advance_prediction` | No authority signature required |
| Burn claims and receive payout | `redeem_prediction` | Position owner |

`advance_prediction` actions: 0 freezes at the published cutoff; 1 activates
fallback; 2 finalizes a mature proposal; 3 applies Invalid after a configured
fallback deadline with no proposal. A correction is allowed strictly before
maturity and restarts the full delay. Earliest proposal time and fallback
windows use inclusive starts and exclusive proposal/correction deadlines.
Finalization never depends on the resolver still being an admin.

A source spot market cannot close while its shared root exists. Drain orders
and fees, pause the source, close the root, then close the source. A prediction
root requires Resolved state, no orders and no fees. Global user cash is never
closed with a market. Historical orders remain. Recreating a used root under
the same source resets its ID counter and collides with retained order accounts;
do not reuse a closed source market. No historical order can be overwritten.

## Examples

- Deposit 100 USDC once. A 30-USDC bid in SOL/USDC leaves 70 available for
  BTC/USDC. Canceling that bid releases exactly 30, preserving other locks.
- Split 4 pairs at a 1-USDC payout: shared cash falls by 4 USDC and the question
  reserve gains 4; the owner receives 4 YES and 4 NO.
- If YES resolves, 2 free YES redeem for 2 USDC; free NO can be burned for zero.
  If Invalid resolves, 3 YES plus 2 NO pay 2.5 USDC. Each burned claim pays once.

## Rollout

1. Run `anchor build`, `anchor test --skip-deploy` and strict Clippy.
2. Run the app type check, shared-planner, wallet and prediction tests, and build.
3. Upgrade the program explicitly. This branch does not deploy it automatically.
4. On devnet, initialize a shared asset balance and book, deposit a small amount,
   trade from a second wallet, cancel, withdraw, and complete a short prediction
   through proposal, finalization and redemption. Check both vault equations.
5. Set `NEXT_PUBLIC_SHARED_BALANCES_ENABLED=true` and
   `NEXT_PUBLIC_PREDICTION_RESOLUTION_ENABLED=true`, then rebuild the app.

The flags default false. Existing legacy trading and recovery remain available.
The new path emits ordinary fill log messages, not new typed Anchor events;
the existing indexer must not be described as indexing these account changes.
A remainder whose value rounds down to zero quote atoms stays free; it is not
posted and does not roll back successful fills.
Typed shared/prediction event coverage and read projections remain follow-up work.
The shared book is a separate liquidity pool during transition, and global
cash introduces same-mint write contention. No migrations run automatically.

## Verification (6 November 2026)

The full Rust suite passes 335 tests, including 16 shared custody, trading and
settlement tests. Anchor build and strict Clippy pass. The app has nine shared
planner/encoding tests, 63 existing prediction tests, and portfolio tests using
real account decoding and mocked RPC. Both rollout configurations build.

Local browser fixtures check desktop/mobile layout, zero-free withdrawal,
closed-market entry, proposal maturity, redemption controls and retained history.
Their wallet cannot sign. These checks do not replace the devnet smoke test.
Market discovery reads shared-book heads/counts when enabled; old prices and
recovery controls are explicitly labeled legacy. A shared-book midpoint is an
indicative quote, not a last trade. Closed-book history stays visible without
guessing lost token precision. Direct account scans can grow with history;
read projections and typed event coverage remain separate indexer work.
