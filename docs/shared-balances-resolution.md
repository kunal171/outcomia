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
