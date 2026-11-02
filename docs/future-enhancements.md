# Roadmap

The CLOB, web client, and finalized-source indexer are working. The remaining
work is split into independent phases so infrastructure, read models, pricing,
and liquidity can be tested separately.

```text
price feeds --> market maker --> Tidebook CLOB
                     |                |
                     |                v
                     +----------> indexer --> API --> web app

optional later path: router --> CLOB + AMM
```

An oracle is a reference price, not the execution price. Tidebook orders still
execute at maker prices. A market maker supplies liquidity around the reference.
An AMM may later provide a separate fallback venue.

## 1. Cloud deployment

Current work:

- Docker image for the Rust indexer;
- liveness and readiness endpoints;
- local Kind deployment;
- PostgreSQL StatefulSet and persistent volume;
- pod and database recovery checks.

Next:

1. Provision OCI networking and OKE with Terraform.
2. Use persistent OCI storage for PostgreSQL.
3. Publish versioned multi-architecture images to GHCR.
4. Add GitHub Actions for checks, image publishing, and deployment.
5. Test pod replacement, node replacement, database persistence, and rollback.

Cloud work must use explicit limits and avoid creating paid resources without a
reviewed plan.

## 2. Indexer projections and API

The indexer already stores finalized source transactions and all 18 event
types. It also handles historical backfill, live wake-ups, reconnect recovery,
and durable checkpoints.

The next data phase builds tables meant for reads:

```text
markets
orders
fills
trader_balances
market_fees
admin_records
```

Projection rules:

- Keep source records immutable.
- Replay events in deterministic chain order.
- Make every projection update idempotent.
- Rebuild projections from source after a schema or logic change.
- Compare projections with periodic on-chain account snapshots.
- Report a mismatch before trying to repair it.
- Use indexed data for reads and transaction planning, never authorization.

Initial API:

```text
GET /health
GET /sync-status
GET /markets
GET /markets/:market
GET /markets/:market/orderbook
GET /markets/:market/trades
GET /wallets/:owner/orders
GET /wallets/:owner/activity
```

This phase is done when a new database can rebuild the same projections from
stored finalized history and the API can serve the web app.

## 3. Oracle adapter

Pyth is the first provider to evaluate. Keep it behind a small Tidebook-owned
interface so provider SDK changes do not spread through matching code.

Proposed account:

```text
MarketOracle = ["market_oracle", market]
```

| Field | Use |
| --- | --- |
| `provider` | Oracle implementation |
| `base_feed_id`, `quote_feed_id` | Pair used to derive the market reference |
| `max_age_seconds` | Freshness limit |
| `max_confidence_bps` | Confidence limit |
| `max_deviation_bps` | Alert or guard threshold |
| `enabled` | Governance switch |

For BTC/USDT:

```text
BTC/USDT = BTC/USD / USDT/USD
```

Do not assume a stablecoin is exactly one dollar. Normalize oracle exponents
with checked integer arithmetic.

Tests must cover stale data, wrong feeds, wrong owners, nonpositive prices,
confidence limits, exponent boundaries, overflow, and deterministic mock feeds.

The first oracle release should be read-only: display reference price and raise
alerts without changing matching rules.

## 4. Market information in the app

Show these values separately:

- oracle reference and update age;
- oracle confidence interval;
- best bid and ask;
- CLOB midpoint;
- last Tidebook fill;
- midpoint and last-fill deviation from the oracle.

Do not label all of them “market price.” They measure different things.

A hard on-chain oracle band should wait until devnet data shows sensible
freshness and deviation settings. A band can block bad trades, but it can also
stop valid price discovery when the feed is stale.

## 5. Reference market maker

Run the market maker as a separate service. A Solana program cannot react to a
new price until someone submits a transaction.

The service should:

1. read oracle updates;
2. read its open orders and current Tidebook levels;
3. calculate inventory-adjusted bid and ask quotes;
4. cancel stale orders and place replacements;
5. persist transaction state across restarts;
6. stop when price, RPC, inventory, or transaction limits fail.

Required controls:

- a dedicated signer with limited funds;
- maximum inventory, exposure, order size, and live-order count;
- oracle age and confidence limits;
- maximum book/oracle deviation;
- self-trade prevention;
- retry and priority-fee limits;
- heartbeat, alerts, and a manual kill switch.

Only add batch cancel or replace instructions after measurements show that
single-order transactions are the bottleneck.

## 6. Monitoring

Track:

- indexer lag and reconnects;
- RPC and transaction failures;
- order-book spread and depth;
- fills, fees, and volume;
- oracle age, confidence, and deviation;
- market-maker inventory and quote age;
- PostgreSQL and Kubernetes health.

Circuit breakers should first live in the market maker. If on-chain breakers
are added later, cancellation and withdrawal must remain available.

## 7. Standalone AMM

Design and test an AMM as an independent venue before combining it with the
order book.

The first model can use constant product:

```text
base_reserve * quote_reserve = k
spot_price = quote_reserve / base_reserve
```

Use separate vaults from the CLOB:

```text
AmmPool       = ["amm_pool", market]
AmmAuthority  = ["amm_authority", pool]
AmmBaseVault  = ["amm_vault", pool, base_mint]
AmmQuoteVault = ["amm_vault", pool, quote_mint]
LpPosition    = ["lp_position", pool, provider]
```

The design must specify LP shares, minimum locked liquidity, swap rounding,
fees, slippage, deadlines, pause behavior, safe closure, and checked arithmetic.
Property tests should cover the formulas before token CPIs are added.

Likely instruction sequence:

```text
initialize_amm_pool
add_liquidity
remove_liquidity
swap_exact_input
pause_amm_pool
unpause_amm_pool
collect_amm_protocol_fees
close_amm_pool
```

## 8. Hybrid routing

Start with an off-chain router. It compares executable CLOB liquidity with AMM
price impact and fees.

A transaction may contain:

```text
match CLOB maker
match next CLOB maker
swap the remainder through the AMM
```

Rules:

- Respect the user's maximum spend or minimum receive.
- Use the same rounding in simulation and execution.
- Never discard a remainder.
- Roll back every leg if one leg fails.
- Keep CLOB and AMM fees separately auditable.
- Replan stale book or reserve state instead of accepting worse execution.

Build a combined on-chain router only if benchmarks show that composing the
existing instructions is not enough.

## 9. Benchmarking and hardening

Measure:

- compute units;
- transaction size and account count;
- maximum safe fills per transaction;
- oracle verification cost;
- Address Lookup Table benefit;
- RPC traversal and confirmation latency;
- stale-state retry rate;
- writable-account contention;
- market-maker cancellation latency.

Before any mainnet discussion, add threat models, operational runbooks, key
separation, monitoring, incident response, fuzz/property tests, and an external
security review.

## Data-source scaling

Use standard Solana HTTP and WebSocket RPC until measurements show a problem.
Yellowstone/Geyser is useful when notification volume or recovery latency
outgrows the current model; it should not be added only because it is available.

## References

- [Pyth Solana integration](https://docs.pyth.network/price-feeds/core/use-real-time-data/pull-integration/solana)
- [Pyth price feeds](https://docs.pyth.network/price-feeds/core/price-feeds)
- [Solana program model](https://solana.com/docs/core/programs)
- [Solana log subscriptions](https://solana.com/docs/rpc/websocket/logssubscribe)
- [Solana signature pagination](https://solana.com/docs/rpc/http/getsignaturesforaddress)
- [Solana program accounts](https://solana.com/docs/rpc/http/getprogramaccounts)
- [Yellowstone gRPC](https://github.com/rpcpool/yellowstone-grpc)
