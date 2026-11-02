# Tidebook Architecture

Tidebook has three parts:

```text
Next.js client
      |
      v
Solana program <---- finalized RPC ---- Rust indexer ---- PostgreSQL
      |
      v
SPL Token vaults
```

The Solana program owns trading state and enforces every balance and order-book
rule. The client discovers accounts and builds transactions. The indexer stores
history for reads; it is not part of settlement or authorization.

The editable diagram is
[`diagrams/tidebook-architecture.drawio`](diagrams/tidebook-architecture.drawio).

## Roles

| Role | Permissions |
| --- | --- |
| Super-admin | Manage admins, set taker fees, withdraw protocol fees, and configure the on-chain test faucet |
| Admin | Create markets |
| Market authority | Pause, unpause, and close its market |
| Trader | Deposit, withdraw, place, match, and cancel orders |

The UI hides routes based on these roles, but the program always performs the
real authorization check.

## Accounts

### Governance

```text
ProtocolConfig = ["protocol_config"]
AdminRecord    = ["admin", authority]
```

`ProtocolConfig` stores the super-admin and the global taker fee. Protocol
initialization verifies the program's upgrade authority.

Each admin has a separate record with an active or disabled status. Separate
accounts avoid an unbounded admin vector and allow one record to be removed
without reallocating a shared account.

### Market

```text
Market = ["market", base_mint, quote_mint]
```

The mint order is part of the address, so `BASE/QUOTE` and `QUOTE/BASE` are
different markets.

Important fields:

| Field | Use |
| --- | --- |
| `authority` | Controls market lifecycle |
| `base_mint`, `quote_mint` | SPL Token mints traded by the market |
| `status` | `Active` or `Paused` |
| `next_order_id` | Next market-local order number |
| `open_order_count` | Open orders that block closure |
| `base_decimals`, `quote_decimals` | Token precision |
| `price_tick_size` | Smallest raw price increment |
| `quantity_lot_size` | Smallest base-atom quantity increment |
| `best_bid`, `best_ask` | Entry points to the two price lists |

### Vaults and fees

```text
Vault authority = ["vault-authority", market]
Base vault      = ["vault", market, base_mint]
Quote vault     = ["vault", market, quote_mint]
MarketFees      = ["market_fees", market]
```

The two vaults are SPL Token accounts controlled by the vault-authority PDA.
`MarketFees` records the protocol's quote-token claim. Fee tokens stay in the
quote vault until withdrawal.

```text
base vault  = sum(base_free + base_locked)
quote vault = sum(quote_free + quote_locked) + accrued_quote_fees
```

### Trader balance

```text
TraderBalance = ["trader_balance", market, owner]
```

Each trader has four balances per market:

```text
base_free     base_locked
quote_free    quote_locked
```

Deposits credit free balance. Asks move base from free to locked. Bids move
quote from free to locked. Cancellation releases it. Matching transfers claims
between trader ledgers. Only withdrawal moves tokens out of a vault.

### Price level and order

```text
PriceLevel = ["price_level", market, side, price]
Order      = ["order", market, order_id]
```

Price levels form a sorted doubly linked list on each side. Orders at the same
price form a doubly linked FIFO queue.

`PriceLevel` stores its adjacent prices, FIFO head and tail, total remaining
quantity, order count, and rent payer. `Order` stores its owner, side, price,
quantity, remaining quantity, locked collateral, level, FIFO neighbors, and
status.

Empty levels are closed immediately. Their rent returns to the wallet that
created the level.

### Test faucet

```text
TestFaucet          = ["test_faucet", market]
TestFaucetAuthority = ["test_faucet_authority", faucet]
```

The on-chain faucet can take authority over fresh zero-supply test mints and
mint fixed claims. It has no rate limit and is only for valueless test assets.
The deployed web faucet uses a separate server-held authority instead. One mint
cannot use both models at the same time.

## Main instruction groups

### Governance

| Instruction | Signer | Result |
| --- | --- | --- |
| `initialize_protocol` | Upgrade authority | Creates protocol config and the first admin |
| `add_admin` | Super-admin | Creates an active admin record |
| `disable_admin` | Super-admin | Disables a non-super-admin record |
| `enable_admin` | Super-admin | Re-enables a record |
| `remove_admin` | Super-admin | Closes a disabled record |
| `set_taker_fee` | Super-admin | Updates the global rate, capped at 1,000 bps |

### Market and custody

| Instruction | Signer | Result |
| --- | --- | --- |
| `initialize_market` | Active admin | Creates market, fee account, and both vaults |
| `pause_market` / `unpause_market` | Market authority | Changes trading status |
| `initialize_trader_balance` | Trader | Creates the market ledger |
| `deposit` | Trader | Transfers tokens into a vault and credits free balance |
| `withdraw` | Trader | Debits free balance and transfers tokens out |
| `withdraw_protocol_fees` | Super-admin | Transfers accrued quote fees to a quote-mint treasury |
| `close_market` | Market authority | Closes an empty paused market, fee account, and vaults |

Deposits, withdrawals, cancellation, and fee withdrawal remain available while
a market is paused. Placement and matching do not.

### Orders

| Instruction | Result |
| --- | --- |
| `insert_limit_order` | Creates a new level and its first order |
| `append_limit_order` | Adds an order behind the same-price FIFO tail |
| `match_limit_order` | Settles one best-price FIFO maker |
| `cancel_limit_order` | Releases collateral and removes an open order |

The client supplies neighboring levels and orders. The program treats them as
untrusted hints and checks canonical addresses, reciprocal links, ordering,
ownership, and status before writing.

## Order placement

On-chain prices and quantities are integers:

```text
human price    = raw price / 10^quote_decimals
human quantity = raw quantity / 10^base_decimals
quote atoms    = raw price * raw quantity / 10^base_decimals
```

The multiplication uses checked `u128` arithmetic. A price must be on the
market tick, a quantity must be on the market lot, and quote notional must be at
least one atom.

An ask locks base quantity. A bid locks quote notional. The free-to-locked
balance move and all order-book links commit in the same instruction.

## Matching

`match_limit_order` processes the current best opposing FIFO head and executes
at the maker price. It can partially reduce the maker or remove it completely.

The web client can compose three match instructions in one Solana transaction.
Later instructions observe state written by earlier instructions. If one fails,
the whole transaction rolls back.

After the planned matches:

- a fully filled taker is done;
- a safe non-crossing remainder is inserted or appended in the same
  transaction;
- a remainder with more crossing liquidity beyond the cap stays free for a
  retry.

See [Matching and settlement](crankless-settlement-design.md) for the balance
equations and Phoenix/OpenBook comparison.

## Cancellation and shutdown

Only the owner can cancel an `Open` order. Cancellation is allowed while
paused. It repairs FIFO links, closes an empty level if needed, and moves
remaining collateral from locked to free.

A market can close only when:

- it is paused;
- `open_order_count` is zero;
- accrued protocol fees are zero;
- both vaults are empty;
- its on-chain faucet config is closed.

Market, fee account, and vault closure are atomic.

## Events

The program emits 18 Anchor event types covering:

- protocol and admin changes;
- market lifecycle;
- trader balance initialization, deposits, and withdrawals;
- order placement and cancellation;
- fills and fee withdrawals;
- test-faucet lifecycle and claims.

Events report completed state changes. They are not deferred work. Indexers must
ignore logs from failed transactions because Solana can retain diagnostic logs
even when account changes roll back.

## Client

The Next.js app provides public market pages and wallet routes for orders,
balances, administration, and market creation. Human inputs are converted to
integer atoms without JavaScript floating-point arithmetic.

Placement and matching currently discover price levels through RPC by walking
`worse_price` links. The walk is O(number of levels). This is transaction
planning only; the program repeats all checks. The indexer can later provide a
faster read path without changing the program API.

## Indexer

The Rust indexer:

1. backfills finalized signatures in bounded pages;
2. fetches complete successful transactions;
3. scopes Anchor data to Tidebook's invocation stack;
4. strictly decodes events;
5. stores each transaction and its events atomically;
6. advances durable historical and live checkpoints;
7. uses WebSocket logs as wake-ups and HTTP for gap recovery.

Exact replay is accepted. Conflicting source data, malformed events, or partial
pages do not move the checkpoint.

## Core invariants

### Identity and authorization

- All accounts use canonical PDA seeds.
- Base and quote are distinct SPL Token mints.
- Only an active admin creates a market.
- Only the stored authority changes market status.
- Only the super-admin manages admins, fee rate, and fee withdrawals.
- Only an order owner cancels it or withdraws that owner's free balance.

### Custody

- Vault tokens back every free, locked, and fee claim.
- Deposits and withdrawals update SPL tokens and the ledger together.
- Placement and cancellation move only internal claims.
- Failed transactions leave vault and ledger totals unchanged.

### Book structure

- Bids descend and asks ascend from the best level.
- Same-price orders follow FIFO order.
- Supplied neighbors link back to the account being changed.
- No active level is empty.
- Counts, aggregates, best pointers, and collateral update atomically.

### Matching

- Only the current best opposing FIFO head can match.
- Execution uses maker price.
- Self-trades and same-side matches are rejected.
- Partial fills keep FIFO position.
- Full fills clear quantity, collateral, and links.
- A later failure rolls back every earlier fill in the transaction.

### Fees

- Fees are charged per fill with ceiling division.
- Bid takers pay gross plus fee; ask takers receive gross minus fee.
- The quote vault backs accrued fees until withdrawal.
- Market closure requires zero accrued fees.

## Tests

LiteSVM integration tests cover governance, market lifecycle, vault custody,
trader balances, price/lot validation, price-level insertion, FIFO append and
removal, cancellation, partial and full matching, multi-maker rollback,
remainders, fees, faucet behavior, and global asset conservation.

Run them with:

```bash
anchor test --skip-deploy
```

## Current limits

- Matching is capped at three makers per client transaction.
- The global writable market account remains a contention point.
- Linked PDAs cost more rent and account metadata than an in-account slab.
- Canceled and filled order accounts are kept as history.
- The fee rate is global and there are no maker rebates.
- The web faucet uses a custodial test key and rate limits are not Sybil-proof.
- Old devnet accounts with earlier layouts require a clean state reset rather
  than an in-place migration.

The next protocol work should be based on compute, transaction-size,
contention, and retry measurements rather than adding more matching complexity
without data.
