# Complementary YES/NO matching

Binary shared books keep separate YES and NO queues. Before this change a YES
buy at 0.60 and a NO buy at 0.40 never traded, although together they fully
fund a new YES+NO pair. Complementary matching lets orders on the **same side
of the two outcomes** trade through the complete set, so both books share
liquidity. It applies to shared binary books only; legacy per-market books and
multi-outcome markets are unchanged (N-way matching is separate future work).

## Rules

Let `P` be the payout per contract (one collateral token).

| Taker | Maker (resting) | Crosses when | Effect per contract |
| --- | --- | --- | --- |
| Buy YES at limit `L` | Buy NO at `q` | `L + q >= P` | **Mint**: `P` moves from the global vault into the reserve; one YES and one NO are created |
| Sell YES at limit `L` | Sell NO at `q` | `L + q <= P` | **Merge**: one YES and one NO burn; `P` moves from the reserve to the global vault |

The NO-taker cases are symmetric.

- **Price:** the maker keeps its own price `q`; the taker trades at `P − q`,
  which is never worse than its limit. This is the same maker-price rule as
  direct matching, so a resting order is never repriced.
- **Fees:** the usual taker fee applies to the taker's notional `(P − q) × n`
  and accrues to the shared book. Makers pay no fee.
- **Priority:** the maker must be the FIFO head of the other outcome's best
  same-side level. Within each queue price-time priority is unchanged. The
  client chooses between direct and complementary liquidity by effective price
  (`P − q` for complementary makers) and prefers direct liquidity on ties.
- **Self-trade:** a taker cannot fill its own order.
- **Placement:** a new resting order is rejected if it would cross the other
  outcome's same-side best price (for example a YES bid at 0.60 while a NO bid
  at 0.40 rests). It must be matched first, exactly as with direct crossing.
- **Lifecycle:** only while trading is open, like every other fill.

Example with `P = 1`: a NO bid rests at 0.40 × 5. A YES bid with limit 0.65 for
3 mints 3 pairs. The taker pays 0.60 × 3 = 1.80 plus fee, the maker's lock falls
by 0.40 × 3 = 1.20, and 3.00 enters the reserve. The maker receives 3 NO and the
taker 3 YES; 2 NO-bid contracts remain resting.

## Custody and invariants

Each fill keeps both custody equations:

```text
question reserve:  backing_reserve = YES supply × P = NO supply × P
global vault:      vault = Σ shared free + locked claims + shared-book fees
```

A mint debits `(P − q) × n` plus fee from the taker's cash and `q × n` from the
maker's locked bid, and moves `P × n` real tokens into the question vault. A
merge burns the taker's free and the maker's locked contracts and moves `P × n`
back to the global vault, crediting `q × n` to the maker and `(P − q) × n − fee`
to the taker. Completed maker bids refund any excess lock. All transfers and
ledger changes are atomic.

## Interfaces

- **Program:** `match_shared_complement(outcome, taker_side, limit_price,
  quantity)`. Accounts extend `match_shared_order` with the mint, both vault
  authorities, the global and question vaults and the token program; the market
  is writable because supplies and backing change. New error:
  `InvalidComplementMatch` (6173).
- **App:** the shared trade planner, the best-buy quote on the YES/NO buttons
  and the order book (implied rows labelled "via NO"/"via YES") use
  complementary liquidity when `NEXT_PUBLIC_COMPLEMENTARY_MATCHING_ENABLED=true`
  (requires shared balances). Keep it false until the program with this
  instruction is deployed. The planner checks every instruction against the
  packet limit: three complementary fills from different makers use about
  1,174 bytes of the 1,232 available.
- **Indexer:** instruction replay records two trades per complementary fill:
  the taker's outcome at `P − q` with the fee, and the maker's outcome at `q`
  without one. A migration stores each binary market's payout and rebuilds the
  instruction-derived history once.
