# Price Levels and FIFO Queues

Tidebook orders follow price-time priority:

1. Higher bids come before lower bids.
2. Lower asks come before higher asks.
3. Orders at the same price are filled in arrival order.

The implementation uses one PDA for each active price and a doubly linked FIFO
queue of orders at that price.

## Accounts

```text
PriceLevel = ["price_level", market, side_seed, price.to_le_bytes()]
```

`side_seed` is the stable byte string `bid` or `ask`. It does not depend on a
Rust enum's memory layout.

| `PriceLevel` field | Use |
| --- | --- |
| `market`, `side`, `price` | Identity of the level |
| `better_price` | Adjacent price with higher priority |
| `worse_price` | Adjacent price with lower priority |
| `first_order` | Oldest order at this price |
| `last_order` | Newest order at this price |
| `total_remaining_quantity` | Open base quantity at this price |
| `order_count` | Number of open orders |
| `rent_payer` | Receives rent when the level closes |
| `bump` | PDA bump |

Each `Order` stores its level plus `previous_order` and `next_order`. The market
stores `best_bid` and `best_ask`, which are the entry points to the two price
lists. A best level has no `better_price`.

## Insert a new price

`insert_limit_order` handles four positions:

- Empty side: no neighboring levels.
- New best: the old best is supplied as `worse`.
- Middle: both adjacent levels are supplied.
- New worst: the terminal better level is supplied.

The program checks canonical PDAs, reciprocal links, side, market, and price
ordering before changing anything. Bids descend through `worse_price`; asks
ascend.

Level creation, first-order creation, collateral locking, neighbor updates, and
market counters are one atomic instruction. A level is never created in a
separate transaction because that could leave an empty level in the active
index.

## Append at an existing price

`append_limit_order` receives the level and its current tail. The program
requires:

- the level matches the market, side, and price;
- the supplied order is `level.last_order`;
- the tail is open and has no successor;
- the trader has enough free collateral.

It links the new order behind the tail and updates the level quantity, order
count, market counters, and trader balance together.

## Remove an order

Cancellation receives the stored older and newer FIFO neighbors. Both must link
back to the order being removed.

If other orders remain, the program joins the two FIFO neighbors. If the final
order is removed, it also receives the adjacent price levels, repairs the price
list, updates the market best pointer, refunds the recorded rent payer, and
closes the empty level.

Matching uses the same removal rules, but it can remove only the FIFO head at
the best opposing price. A partial fill stays at the head.

## Invariants

- A level PDA is derived from its market, side, and price.
- Every queued order matches the level's market, side, and price.
- Active levels are non-empty.
- The head has no older order and the tail has no newer order.
- Every supplied neighbor links back to the account being changed.
- Price links are strict and contain no duplicate price.
- `best_bid` is the highest bid and `best_ask` is the lowest ask.
- Counts and aggregate quantity use checked arithmetic.
- Queue changes, level changes, collateral movement, and market counters commit
  or roll back together.

## Why the client supplies neighbors

A Solana program cannot scan arbitrary PDAs during execution. The client walks
from the current best level and supplies the accounts needed for the mutation.
Those accounts are hints, not trusted data. The program derives and validates
them again because the book may have changed after the RPC reads.

The web client checks for cycles, broken reciprocal links, wrong markets or
sides, and invalid price ordering before submitting. An indexer can make this
lookup faster later without changing the instruction contract.

Optional neighbor accounts keep each mutation atomic but enlarge Anchor's
generated account parser. Large optional accounts are boxed to stay below
Solana's stack-frame limit.

## Tradeoffs

| Design | Result |
| --- | --- |
| Linked `PriceLevel` PDAs | Easy to inspect and allocate independently, but cost rent and require neighbor accounts |
| Doubly linked orders | O(1) removal with supplied neighbors, but more writable accounts |
| Close empty levels | Avoids stale empty state, but may allocate the same level again later |
| Writable `Market` counters | Simple IDs and accounting, but the market remains a contention point |

A growing vector inside `Market` was rejected because it needs reallocations or
a fixed limit and makes the shared market account larger. A slab or crit-bit
tree may be cheaper at scale, but it adds fixed-capacity planning and custom
memory management. Tidebook keeps the PDA layout until benchmarks show that the
account overhead is the limiting factor.

## Test coverage

The LiteSVM suite covers:

- first, best, middle, and worst bid/ask insertion;
- same-price FIFO append and three-order chains;
- head, middle, tail, and only-order removal;
- best-pointer repair and empty-level closure;
- collateral and aggregate updates;
- stale, missing, noncanonical, cross-market, and cross-side neighbors;
- rollback after any failed validation.
