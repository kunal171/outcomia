# Architecture

Outcomia is an Anchor 1.2 program with an on-chain central limit order book for
spot pairs and prediction markets, a Next.js app and a Rust indexer. Everything
runs on devnet with test tokens.

```text
browser ──► app (Next.js) ──► /api/solana proxy ──► Helius RPC ──► outcomia program
                 │                                                   │ events
                 └──────── GraphQL ◄──── indexer (Rust, Postgres) ◄──┘ finalized logs
```

Editable diagrams: [outcomia-architecture.drawio](diagrams/outcomia-architecture.drawio)
and [prediction-market-architecture.drawio](diagrams/prediction-market-architecture.drawio)
(open them in [draw.io](https://app.diagrams.net/)).

## Roles

| Role | Can do |
| --- | --- |
| Super admin | Manage admin records, set the taker fee, withdraw fees, configure clubs, deposits and disputes, enable test faucets |
| Admin | Create and run markets while the admin record is active |
| Market creator / resolver | Open, close trading, propose and correct outcomes |
| Trader | Deposit, withdraw, place, cancel and match orders, split, merge and redeem |
| Anyone | Finalize a result after review, expire stale disputes, freeze markets past close |

The protocol config is initialized by the program upgrade authority. Admin
records are separate PDAs, so each can be disabled or removed on its own.

## Accounts

**Protocol**
- **`ProtocolConfig`** `["protocol_config"]`: the super admin and the taker fee rate.
- **`AdminRecord`** `["admin", wallet]`: an admin and whether they're active.
- **`TestFaucet`**: opt-in for fresh, zero-supply test mints, with fixed claim
  amounts. The app also has a server-backed faucet.

**Shared custody (current path)**
- **`AssetBalance`** `(owner, mint)`: available and locked atoms for one asset
  across every shared book. One SPL vault per mint holds the tokens. Depositing
  once funds every market that uses that mint.
- **`SharedBook`**: one per market. It holds the bid and ask heads and the fees
  that market earned.
- **`SharedPriceLevel`** and **`SharedOrder`**: sorted price levels with a FIFO
  queue at each level.
- **Prediction positions**: buys spend shared collateral; sells lock YES/NO
  contracts held per question.

**Legacy per-market path (still on devnet)**
- **`Market`** and **`TraderBalance`** `["trader_balance", market, trader]`:
  per-market vaults and free/locked claims, with their own `PriceLevel` and
  order PDAs.
- **Migration:** users can cancel legacy orders and then move free cash into
  `AssetBalance` with `migrate_spot_asset` / `migrate_prediction_asset`.
- **Never reinterpreted:** legacy locks are never read as global money.

**Feature accounts** are described in [prediction markets](prediction-markets.md),
[clubs](clubs.md) and [profiles](profiles.md).

## Conservation

For each mint:

```text
shared vault  = Σ(available + locked) + Σ(shared-book fees)
question vault = backing reserve        (YES supply × payout = NO supply × payout)
```

Every deposit, withdrawal, fill, split, merge, cancellation and redemption keeps
both equations. Arithmetic uses checked `u128` intermediates. Fees belong to the
book that earned them and can never be withdrawn as user cash.

## Order book

**Price-time priority.**
- **Order:** higher bids first, then lower asks, then first in, first out at the
  same price.
- **Levels:** each active `(book, side, price)` has a deterministic level PDA,
  linked to its better and worse neighbours. Each level stores its first and last
  order.
- **Why PDAs:** a growing vector in the market account would need a capacity
  limit and would make one hot account, so it was rejected. The PDA design costs
  rent per active price, and clients have to pass neighbouring accounts.

**Client-supplied neighbours.**
- **Why the client supplies them:** a program can't scan for PDAs.
- **Untrusted:** the program re-derives every address and checks prices and
  reciprocal links before changing anything.
- **Shapes covered:** insertion handles an empty side, a new best, a middle and a
  new worst level. Cancellation handles head, middle, tail and only-order removal,
  and closes empty levels in the same instruction.

**Bounded crankless matching.**
- **No crank:** Outcomia doesn't use an OpenBook-style event queue and crank.
- **One maker per instruction:** each match instruction settles one best FIFO
  maker, partially or fully, against the taker's free balance.
- **Up to three per transaction:** the client plans up to three such
  instructions in one transaction, following same-level successors or later
  levels.
- **Remainder:** if the path proves no crossing liquidity is left, the client
  rests the remainder at its limit price.
- **Atomic:** a stale step rolls back the whole transaction.
- **Price:** the taker pays the maker's price, so a bid at 105 that fills against
  an ask at 100 pays 100.
- **Balances only:** settlement moves claims between balances and never moves
  tokens. Tokens move only on deposit, withdrawal and fee withdrawal.

**Complementary matching (binary).**
- **Separate queues:** YES and NO keep separate queues, but orders on the same
  side across the two outcomes also trade through the complete set:

  | Taker | Maker | Crosses when | Effect |
  | --- | --- | --- | --- |
  | Buy YES at `L` | Buy NO at `q` | `L + q ≥ P` | Mint a YES+NO pair into the reserve |
  | Sell YES at `L` | Sell NO at `q` | `L + q ≤ P` | Merge a pair out of the reserve |

- **Instruction:** `match_shared_complement`. The multi-outcome version is in
  [prediction markets](prediction-markets.md#trading).

**Limits.**
- **Hot account:** the book account is writable on every placement, so it is a
  write-contention point.
- **Shared balances contend:** a trader's same-mint balance is shared by all
  markets, so their transactions on different markets can contend.

## Fees

- **Taker fee:** a global rate set by the super admin and charged in quote or
  collateral.
- **Fee quote:** multi-outcome matches carry the fee rate the taker accepted and
  fail with `MultiOutcomeFeeQuoteChanged` if the rate changed in the meantime.
- **Club markets:** they split fees between the protocol and the club; see
  [clubs](clubs.md#fees).
- **Withdrawal:** `withdraw_shared_fees` (super admin) withdraws only the fees a
  book has accrued.

## Events and errors

- **Events:** every successful state change emits an Anchor event after its
  mutations, for example `OrderPlacedEvent`, `FillEvent` and `DepositEvent`.
  - **Contents:** balance and order events carry post-transition values that
    indexers need.
  - **Not settlement:** events don't carry deferred settlement work.
  - **Successful transactions only:** a failed transaction can still log events
    from earlier instructions, so consumers must only ingest events from
    successful transactions.
- **Errors:** Anchor allows one `#[error_code]` enum, so the stable error ABI is
  `programs/outcomia/src/errors/catalog.rs`, with explicit discriminants from 6000
  upwards.
  - **Re-exports:** domain modules (`admin`, `market`, `order`, `balance`,
    `matching`) re-export the variants they use.
  - **Append-only:** codes are never reused or renumbered. A new error takes the
    next number and is re-exported from its domain module.

## Account layout changes

- **Reserved bytes:** new fields go into reserved bytes at the end of an
  existing account (for example `Club`), so deployed accounts keep decoding.
- **Enums:** existing enums (`PredictionOutcome`, `SharedOutcome`) are never
  reordered or extended to mean something new. New features get new account
  types and PDA namespaces.
- **PDA checks:** they use the stored canonical bump (`pda::address_with_bump`)
  instead of `find_program_address`, so compute cost stays constant.
- **Lamports:** move them by hand only after any token CPI that names the same
  account.

## App

- **Stack:** Next.js with wallet adapters and the Anchor TS client generated from
  the IDL in `app/idl`.
- **RPC proxy:** browsers call `/api/solana`, which forwards allowed methods to
  Helius using server-side keys.
  - **Failover:** reads fail over to public devnet; signed broadcasts are never
    replayed.
  - **Limits:** the proxy limits request size and has a soft per-instance request
    allowance.
- **Planner:** the browser checks every reachable link, PDA and priority before
  it builds a transaction. The program checks again.
- **Feature flags:** for example `NEXT_PUBLIC_SHARED_BALANCES_ENABLED` and
  `NEXT_PUBLIC_MULTI_OUTCOME_ENABLED`, so unverified deployments stay off.

See [frontend](frontend.md) and [`app/README.md`](../app/README.md).

## Indexer

- **Source:** `services/indexer` ingests finalized, successful transactions,
  decodes events and accounts and stores them in PostgreSQL.
- **API:** GraphQL.
- **IDL history:** account layouts are decoded against an IDL history
  (`account_codec.rs`), so older layouts still decode.
- **Optional:** the protocol never depends on the indexer. Screens fall back to
  RPC reads when no indexer is configured.

See [`services/indexer/README.md`](../services/indexer/README.md).

## Tests

- **Program:** LiteSVM integration tests in `programs/outcomia/tests` cover
  custody, matching, resolution, clubs and disputes.
  - **Compute:** they assert compute budgets for the heaviest paths, such as
    eight-outcome minting.
  - **Faults:** they check conservation, replay, stale hints, authorization and
    rollback.
- **App:** unit suites for the planners, encodings, wallet, RPC proxy, i18n and
  theme, plus local and devnet end-to-end scripts in `app/scripts`.
- **Not covered:** throughput on a public network, and wallet UX beyond the
  smoke tests.

Commands are in the [README](../README.md#checks).
