# Tidebook indexer

Rust service that stores finalized Tidebook transactions and decoded Anchor
events in PostgreSQL. It backfills history, resumes from durable checkpoints
and recovers missed transactions when the live subscription reconnects.

This is a separate Cargo workspace. Its RPC/database dependencies can change
without forcing the Anchor program and LiteSVM onto the same versions.

## Coverage

The decoder supports the 21 event types in `src/decoder.rs`: governance, market
metadata, spot orders/fills, balances, fees and the test faucet. It accepts
`Program data:` only while Tidebook is the active invocation.

Prediction instructions currently emit no prediction-specific events. Shared
metadata events can be decoded, and source transactions are retained, but this
service does not reconstruct prediction positions, orders or fills. Adding
prediction events requires updating the decoder catalog and its Borsh types.
Unknown or malformed events stop processing rather than being silently skipped.

Read-optimized projections, reconciliation and a public query API are still
planned. The health endpoints are operational checks, not a trading API.

## Run locally

Run these commands from the repository root. Copy the example only on first
setup; preserve an existing `.env`.

```bash
cp services/indexer/.env.example services/indexer/.env
```

Choose one runtime:

**Docker Compose** runs both the database and the indexer:

```bash
docker compose -f services/indexer/compose.yaml up -d --build
docker compose -f services/indexer/compose.yaml logs --tail=50 indexer
curl --fail http://127.0.0.1:8080/health/live
curl --fail http://127.0.0.1:8080/health/ready
```

Compose supplies the container's database URL. RPC/program settings can be
supplied through the shell or Compose's explicit `--env-file` option. Do not
expect the running containers to read the Rust process's environment file.

**Host Rust process** uses only the Compose database:

```bash
docker compose -f services/indexer/compose.yaml up -d postgres
set -a
source services/indexer/.env
set +a
cargo run --manifest-path services/indexer/Cargo.toml
```

Stop an existing Compose indexer before using the host process; both would
otherwise compete for port `8080` and write the same checkpoints. Run one
indexer per program/database configuration.

The database is exposed on loopback port `5434`; containers use `postgres:5432`.
`DATABASE_URL` is required. RPC, WebSocket and program settings default to devnet
and `AG4ztZvcZjzFKjoXLzH8M6U3if9CwVFTXH2FHjqg7SdL`. SQLx migrations run at startup.
The host process needs Rust `1.97.1`; Docker uses the pinned builder image.

For [Kind/Kubernetes](infra/kubernetes/README.md), use the separate manifest
setup. These local runtimes do not establish a cloud deployment.

## Processing flow

```text
historical pages -> processor -> decoder -> PostgreSQL transaction + events
live subscription -> wake-up -> HTTP gap recovery -> same processor
                                      -> durable checkpoint
```

- Historical pages are processed oldest-first within each page. The raw page
  boundary, including failed entries, provides the pagination cursor.
- Transactions and events commit together. Exact replay succeeds; conflicting
  records roll back. A failed page does not advance its checkpoint.
- Live subscription starts before HTTP catch-up. WebSocket messages only wake
  recovery; finalized HTTP transactions are the persisted source.
- Reconnects use capped backoff. An incomplete gap beyond the page limit stops
  before partial processing; increase the bound or investigate the lag.
- Processing is serial. Ctrl+C/SIGTERM uses the graceful shutdown path.

Raw logs, payloads, log indexes, decoded JSON and schema versions are retained
for replay. Failed or non-finalized transactions are not persisted.

## Health and checks

`/health/live` reports process liveness. `/health/ready` also requires successful
catch-up and a reachable database. Readiness is not a time-based lag metric.

```bash
cargo fmt --manifest-path services/indexer/Cargo.toml --all --check
cargo test --manifest-path services/indexer/Cargo.toml
cargo clippy --manifest-path services/indexer/Cargo.toml --all-targets -- -D warnings
```

Run the isolated PostgreSQL integration tests against a local test database:

```bash
DATABASE_URL=postgres://tidebook:tidebook_dev@127.0.0.1:5434/postgres \
  cargo test --manifest-path services/indexer/Cargo.toml -- --ignored
```

Future work: query projections/API, account reconciliation and monitoring.
Yellowstone is a later option if measured RPC limits justify it.
