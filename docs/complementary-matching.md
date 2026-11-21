# Complementary YES/NO matching

Binary shared books keep separate YES and NO queues. Before this change a YES
buy at 0.60 and a NO buy at 0.40 never traded, although together they fully
fund a new YES+NO pair. Complementary matching lets orders on the **same side
of the two outcomes** trade through the complete set, so both books share
liquidity. It applies to shared binary books and, as N-way full sets, to
multi-outcome books (see [multi-outcome full sets](#multi-outcome-full-sets));
legacy per-market books are unchanged.

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

## Multi-outcome full sets

With `N` outcomes (2–8), a set needs one contract of every outcome. A taker
buying outcome `i` at limit `L` fills against the **best bid of every other
outcome** when `L + Σ bᵢ ≥ P`; a taker selling fills against every other
outcome's best ask when `L + Σ aᵢ ≤ P`. Each maker keeps its own price and the
taker trades at `P − Σ` maker prices. A mint moves `P × n` into the question
reserve and raises every outcome's supply by `n`; a merge does the reverse, so
supplies stay equal and exact Invalid refunds (`P / N` per contract) still hold.
The fill size is the smallest of the taker's and the heads' remaining amounts.

Example with three outcomes: bids of 0.30 (B) and 0.25 (C) let a buyer of A
with limit 0.50 buy at 0.45; for 6 contracts the B and C makers pay 1.80 and
1.50, the taker 2.70, and 6.00 enters the reserve.

- **Program:** `match_multi_outcome_complement(outcome, taker_side,
  limit_price, quantity, expected_fee_bps)`. Makers are the book's own head
  references, passed as remaining accounts `[order, next, cash, position]` per
  other outcome in outcome order (`next` is the program ID unless the head fills
  completely and has a successor). One owner may hold several heads; cash and
  position accounts are loaded and written once per address. Placement rejects
  an order that would complete a set at rest. An eight-outcome mint uses about
  107,000 compute units.
- **Events and indexer:** each leg emits the existing `MultiOutcomeFillEvent`,
  makers at their price without a fee and the taker at `P − Σ` with the fee and
  the default address as counterparty, so indexers record per-outcome trades
  without a decoder change.
- **App:** the multi-outcome ticket compares the best direct maker with the
  full-set price and takes the better one; the trade view shows prices reachable
  through the other outcomes. Same rollout flag as binary matching.
- **Transaction size:** legacy transactions fit full sets for up to six
  outcomes even with distinct maker wallets. Larger sets use a v0 transaction
  with the market's address lookup table, which holds the instruction's nine
  fixed accounts (`app/lib/market-lookup-table.ts`). The table is created,
  filled and frozen in one transaction (about 0.003 SOL rent, never refunded),
  so nobody can alter or close it; the trade view offers "Enable large
  full-set fills" when it is missing, and discovery accepts only a frozen,
  active table holding exactly those addresses in order. If every head would
  complete (adding successor accounts), the planner fills one lot less so none
  completes. The only remaining overflow is eight outcomes where every head
  holds exactly one lot with a successor and a distinct wallet; the planner
  then uses direct liquidity or asks to rest below the full-set price.
  `app/scripts/local-full-set-e2e.mjs` checks the eight-outcome case end to end
  on a local validator: a 1,018-byte v0 transaction using about 140,000
  compute units with seven distinct maker wallets.

