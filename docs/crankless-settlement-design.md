# Matching and Settlement

Tidebook settles the order book and trader balances in the same Solana
transaction. There is no later crank that finishes a maker's balance update.

One program instruction processes one maker. The web client can place up to
three matching instructions in one transaction and can append a safe remainder
placement after them.

## What settlement means here

Tokens are already held in the market vaults. A match changes each trader's
claim on those tokens:

```text
maker locked balance -> maker/taker free balances
order quantity       -> reduced or filled
price level          -> reduced or removed
```

Withdrawal is separate. It moves a free balance from a vault to the owner's SPL
Token account.

This keeps wallet token accounts out of matching, lets makers remain offline,
and keeps the account list bounded.

## Phoenix and OpenBook

Phoenix keeps orders and registered trader balances inside one market account.
A matching instruction can find makers and update all balances in that account.
This gives a small account list but requires a large fixed-capacity account and
makes the market a shared writable hotspot.

Older Serum/OpenBook designs keep trader state in separate `OpenOrders`
accounts. A match may not receive every maker account, so it writes fill events
to a queue. A later `ConsumeEvents` crank updates maker balances.

Tidebook keeps separate order, level, and trader PDAs but requires the client to
supply the maker path up front:

| Concern | Phoenix | Older OpenBook | Tidebook |
| --- | --- | --- | --- |
| Book storage | Inside market account | Shared book accounts | Price-level and order PDAs |
| Trader state | Inside market account | `OpenOrders` accounts | `TraderBalance` PDAs |
| Maker settlement | Immediate | Event queue and crank | Immediate |
| Capacity limit | Preallocated market | Queue and account capacity | Transaction accounts and compute |

Tidebook's storage is not as compact as Phoenix. It was chosen because the PDA
transitions are easier to inspect while the design is still being studied.

## Trader balances

```text
TraderBalance = ["trader_balance", market, owner]
```

| Field | Meaning |
| --- | --- |
| `base_free` | Base available to withdraw or place as an ask |
| `base_locked` | Base reserved by open asks |
| `quote_free` | Quote available to withdraw or place as a bid |
| `quote_locked` | Quote reserved by open bids |

Vault accounting must satisfy:

```text
base vault  = sum(base_free + base_locked)
quote vault = sum(quote_free + quote_locked) + accrued_quote_fees
```

The quote fee is an accounting claim in `MarketFees`. The tokens remain in the
quote vault until the super-admin withdraws them.

## Order lifecycle

### Deposit

Deposit transfers tokens into a market vault and credits the matching free
balance in the same instruction.

### Place

An ask locks base quantity:

```text
base_free   -= quantity
base_locked += quantity
```

A bid locks quote notional:

```text
quote = price * quantity / 10^base_decimals
quote_free   -= quote
quote_locked += quote
```

Placement does not call the Token Program.

### Match

The fill price is the resting maker price. For quantity `Q` and maker price
`P`:

```text
gross quote = P * Q / 10^base_decimals
fee         = ceil(gross quote * taker_fee_bps / 10_000)
```

When the maker is an ask:

```text
maker.base_locked -= Q
maker.quote_free  += gross quote
taker.quote_free  -= gross quote + fee
taker.base_free   += Q
```

When the maker is a bid:

```text
maker.quote_locked -= gross quote
maker.base_free     += Q
taker.base_free     -= Q
taker.quote_free    += gross quote - fee
```

The fee is added to `MarketFees.accrued_quote_fees`. Makers always receive or
spend the full maker-price amount.

A partial maker remains at the FIFO head. A full maker becomes `Filled`; its
successor becomes the head, or the empty level is removed and the next price
becomes best.

### Cancel and withdraw

Cancellation moves the order's remaining collateral from locked back to free
and repairs the queue. It remains available while the market is paused.

Withdrawal can move only free balance and requires the owner to sign.

## Building a matching transaction

For a bid, the client starts at `best_ask`. For an ask, it starts at
`best_bid`. It follows price and FIFO links and collects at most three makers.

Each matching instruction receives:

- the current best opposing level;
- its FIFO head order;
- the maker and taker balance PDAs;
- the successor or worse level needed if the maker is removed;
- the stored rent recipient when a level may close.

The program checks every supplied account:

- canonical PDA derivation;
- market, side, and price;
- current best level and FIFO head;
- reciprocal links;
- maker balance owner;
- crossing price;
- distinct maker and taker.

If any later instruction sees stale state, Solana rolls back the complete
transaction, including earlier fills.

## Remainders

After the planned fills, three cases are possible:

1. The taker is fully filled: nothing is posted.
2. The book is exhausted or the next price does not cross: a valid remainder is
   inserted or appended in the same transaction.
3. More crossing liquidity exists beyond the three-maker cap: the remainder
   stays free for another attempt.

A bid remainder whose notional rounds to zero also stays free. Quantity is
never silently dropped.

## Why the match count is capped

The fixed cap limits:

- transaction account metadata;
- compute use;
- stale-state exposure;
- the number of queue and level mutations in one transaction.

The cost is more RPC traversal and retries for deep orders. Benchmarks should
decide whether to raise the cap or replace the PDA layout.

## Rules

- Book and balance changes commit together.
- A fill consumes only recorded locked collateral.
- Free and locked arithmetic is checked.
- Only the best opposing FIFO head can match.
- A maker does not sign; its open order is standing consent.
- A partial maker keeps its FIFO position.
- A filled order has zero quantity and zero locked collateral.
- Pausing blocks placement and matching, but not cancellation or withdrawal.
- Events describe completed transitions; they do not finish settlement.
- Failed transactions are ignored by event consumers.
- Base and quote vaults must continue to back all trader and fee claims.

## Costs of this design

- Clients must discover and supply the matching path.
- Stale transactions need a refresh and retry.
- More PDAs mean more rent and account metadata.
- Linked structures require strict reciprocal-link checks.
- The market and vaults remain writable contention points.

## References

- [Phoenix repository](https://github.com/Ellipsis-Labs/phoenix-v1)
- [Phoenix FIFO market](https://github.com/Ellipsis-Labs/phoenix-v1/blob/master/src/state/markets/fifo.rs)
- [Phoenix order processing](https://github.com/Ellipsis-Labs/phoenix-v1/blob/master/src/program/processor/new_order.rs)
- [OpenBook instruction model](https://github.com/openbook-dex/program/blob/master/dex/src/instruction.rs)
- [OpenBook state and event consumption](https://github.com/openbook-dex/program/blob/master/dex/src/state.rs)
