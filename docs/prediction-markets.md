# Prediction markets

Outcomia has binary (YES/NO) markets and multi-outcome markets with 2–8
outcomes and one winner. Both are deployed on devnet.

## Model

The model follows Polymarket's complete sets, with internal positions on Outcomia's
own on-chain order book.

| Area | Decision |
| --- | --- |
| Collateral | One SPL mint per market, funded from the shared wallet (`AssetBalance`) |
| Outcomes | Internal position balances; there are no outcome SPL tokens |
| Price | Collateral atoms per contract. With six-decimal USDC, a payout of `1_000_000` means a price of `650_000` is 65% |
| Contracts | Whole contracts, in multiples of the market's lot |
| Rules | An immutable URI plus content hashes stored on chain |
| Resolution | The creator is the trusted primary resolver; an optional fallback resolver is declared up front; disputes go to admins |

**Complete sets.**
- **Split:** locking `Q × P` collateral mints `Q` contracts of every outcome.
- **Merge:** returning `Q` of every outcome gives back `Q × P`.
- **Payout:** a winning contract pays `P`, and a losing one pays nothing.
- **Backing:** a set needs only `P` of backing, whatever the number of outcomes,
  because exactly one outcome wins.

**Invariants before resolution:**

```text
supply of each outcome is equal
backing reserve = supply × payout
```

After resolution, `backing = Σ supply_i × payout_i`. Trading moves ownership but
never changes supply or backing.

## Binary markets

- **Accounts:**
  - **`PredictionMarket`:** terms, status, resolver phases and supplies.
  - **`PredictionPosition`:** a trader's YES and NO contracts, free and locked.
- **Creation checks** (`prediction_config.rs`):
  - **Timing:** a future close time, resolution windows in order, and a positive
    review delay.
  - **Resolvers:** nonzero keys, with the fallback resolver distinct from the
    primary.
  - **Payout and tick:** the payout must be even, so Invalid can pay half to
    each side, and the tick must divide the payout.
  - **Rules:** the rules URI is `ar://` or `https://` (up to 200 bytes) and both
    content hashes are nonzero.
- **Books:** YES and NO each have a bid book and an ask book. Same-outcome orders
  match directly; opposite outcomes match through the complete set (see
  [architecture](architecture.md#order-book)).
- **Legacy accounts:** the first per-market accounts (`PredictionOrderBook`,
  `PredictionOrder`) are still on devnet for recovery, but new trading uses
  shared books.

## Multi-outcome markets

- **Outcome IDs:** zero-based list indexes, fixed with the names before the
  market opens, so an order can never end up pointing at a different candidate.
- **Invalid:** a result, not a tradable asset. Each contract refunds `P / N`.
  - **Lot rule:** every quantity must be a multiple of the lot `L`, and
    `(L × P) % N == 0` is checked at creation.
  - **Example:** with N = 3 and P = 1 token, lot 3 works: an Invalid result
    refunds 1 token per 3 contracts.
- **Book:** `MultiOutcomeBook` holds 16 roots, a bid and an ask ladder for each
  of up to eight outcomes.
  - **Orders:** `MultiOutcomeOrder` has reciprocal links and is sorted by price,
    then by acceptance ID.
  - **No cap:** there is no order cap and no vector scan.
- **Creation size:**
  - **Short labels:** creation fits in one 1,232-byte transaction.
  - **Larger terms:** they are uploaded in chunks of at most 600 bytes to a buffer
    owned by the creator. Creation then binds the buffer's SHA-256.
  - **Rent:** the app closes the buffer after creation and also finds abandoned
    buffers to reclaim rent.
- **Compatibility:** binary enums and accounts are untouched. Multi-outcome
  accounts use their own PDA namespaces (`multi_market`, `multi_book`, ...).
- **Flags:** `NEXT_PUBLIC_SHARED_BALANCES_ENABLED` and
  `NEXT_PUBLIC_MULTI_OUTCOME_ENABLED` must both be on. Production has enabled
  them since the devnet upgrade on 21 November 2026.

## Trading

- **Same outcome:** a buy of outcome A matches a sell of A, with price-time
  priority per outcome.
- **Full sets (multi-outcome):** a taker buying outcome `i` at `L` fills against
  the best bid of every other outcome when `L + Σ bids ≥ P`. This mints sets.
  Sells merge sets when `L + Σ asks ≤ P`.
  - **Prices:** makers trade at their own prices.
  - **Fee quote:** the taker's fee quote must still hold, or the match fails with
    `MultiOutcomeFeeQuoteChanged`.
- **Batching:** the client packs up to three maker fills per transaction, then a
  resting remainder only when no crossing maker is left.
  - **Unsent quantity:** quantity that wasn't sent is shown for a retry, and the
    app never sends a second transaction automatically.
  - **Stale queue:** the program checks the live queue, so a stale step rolls
    back the whole transaction.
- **After close:** placement and matching stop at `close_ts`, even before anyone
  freezes the market. Cancel, withdraw, merge and redeem are always available.

## Resolution

Binary and multi-outcome markets share one lifecycle in
`programs/outcomia/src/resolution.rs`.

```text
Draft → Open → Frozen → Proposed → Resolved
Open:     split, merge, trade, cancel, deposit, withdraw
Frozen:   cancel, merge, deposit, withdraw
Proposed: cancel, merge, deposit, withdraw
Resolved: cancel, redeem, withdraw
```

1. **Primary proposal:** from the earliest resolution time (or the close time),
   the creator, while still an active admin, proposes an outcome or Invalid,
   with an evidence URI and hash. The window ends when the fallback becomes
   available, if one is configured.
2. **Fallback:**
   - **Activation:** if there's no primary proposal by the fallback start time,
     anyone can activate the fallback phase.
   - **Proposal:** only the fallback resolver can then propose, before its
     deadline.
3. **Review and corrections:** every proposal waits for the review delay.
   - **Who corrects:** the active resolver may correct it, and each correction
     restarts the delay.
   - **Deadline:** corrections stop at phase start plus two review delays, so a
     resolver can't postpone finalization forever.
4. **Finalization:**
   - **Who:** anyone can finalize after the delay, provided there's no open
     dispute; see [clubs](clubs.md#disputes).
   - **Fixed result:** the caller can't choose the result.
   - **Admin changes:** removing an admin after a valid proposal doesn't block
     finalization.
5. **Timeout:** if a fallback deadline passes with no proposal at all, anyone can
   finalize the outcome committed up front, which is Invalid.
6. **Redeem:** traders redeem their free contracts into shared collateral and
   then withdraw. No admin is involved.

Permissions:

| Action | Who |
| --- | --- |
| Create a draft, open, close trading | Creator, while an active admin |
| Propose or correct | The resolver for the current phase, while an active admin |
| Finalize, time out | Anyone |
| Redeem, withdraw | The position's owner |

**Limits.**
- **Trusted resolver:** the creator can withhold evidence, and a 50/50 Invalid
  timeout is a deliberate compromise. The UI shows the timeout policy.
- **No deadline:** without a fallback deadline, a silent resolver can leave
  unpaired contracts unredeemable. Users can still cancel, merge and withdraw.
- **Disputes:** bonded disputes (club rules milestone 3) add a challenge path,
  but admins rule on them. That isn't decentralized resolution.

## Not built

- **Market shape:** markets with several winners, fractional contracts, and
  transferable outcome tokens.
- **Rules:** no rule changes after opening, and no resolution from web URLs inside
  the program.
- **Switching:** atomic switching between positions (sell YES, buy NO with a guard
  on the result). The design is in [roadmap](roadmap.md).
- **Liquidity:** AMM liquidity.
