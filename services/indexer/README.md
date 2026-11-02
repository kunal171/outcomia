# Tidebook Indexer

Rust service that reads finalized Tidebook transactions, decodes all 21 Anchor
event types, and stores replayable source records in PostgreSQL. It is a
separate Cargo workspace so its RPC and database dependencies can evolve
independently from the on-chain program.

## Current scope

- Paginates finalized program history in bounded batches and resumes from a
  durable PostgreSQL cursor.
- Processes successful records oldest-first within each RPC page while using
  the raw page boundary, including failed entries, as the next cursor.
- Accepts `Program data:` only while Tidebook is the active invocation.
- Preserves raw logs, Base64 payloads, log indexes, decoded JSON, and schema
  versions.
- Writes each transaction and its events atomically.
- Treats exact replay as success and rejects conflicting source data.
- Advances the checkpoint only after every successful record in a page commits.
- Subscribes to finalized program logs, then closes the startup gap over HTTP.
- Recovers over HTTP after every wake-up and reconnect with capped backoff.

Historical backfill and recoverable live source ingestion are complete.
Read-optimized projections, reconciliation, and APIs remain separate phases.

## Runtime structure

```text
main
 |-- backfill -> HTTP RPC -> processor -> decoder -> source storage
 `-- subscription -> wake-up -> HTTP gap recovery -> processor
                                      `-> durable live checkpoint
```

`main` owns bootstrap, reconnect timing, and Ctrl+C shutdown. `backfill` owns
bounded historical pagination. `subscription` establishes finalized log
wake-ups but never persists their payloads. `live` reloads the durable boundary
and recovers complete transactions through HTTP. `processor` fetches, decodes,
and persists one transaction; `reporter` keeps diagnostics outside control flow.

## Run locally

From the repository root:

```bash
cp services/indexer/.env.example services/indexer/.env
docker compose -f services/indexer/compose.yaml up -d

set -a
source services/indexer/.env
set +a

cargo run --manifest-path services/indexer/Cargo.toml
```

The local database uses `127.0.0.1:5434` because ports `5432` and `5433` are
already used by other local PostgreSQL services. `DATABASE_URL` is required.
`SOLANA_RPC_URL`, `SOLANA_WS_URL`, and `TIDEBOOK_PROGRAM_ID` have devnet
defaults. Pending migrations run automatically before ingestion.

Useful database commands:

```bash
cd services/indexer
sqlx migrate info
sqlx migrate run

docker compose -f compose.yaml stop
```

For the local Kind deployment, resource relationships, health checks, and
recovery procedure, see [`infra/kubernetes/README.md`](infra/kubernetes/README.md).

## Verify

```bash
cargo fmt --manifest-path services/indexer/Cargo.toml --all --check
cargo test --manifest-path services/indexer/Cargo.toml
cargo clippy --manifest-path services/indexer/Cargo.toml --all-targets -- -D warnings
```

Run the isolated PostgreSQL integration tests with:

```bash
DATABASE_URL=postgres://tidebook:tidebook_dev@127.0.0.1:5434/postgres \
  cargo test --manifest-path services/indexer/Cargo.toml -- --ignored
```

## Safety guarantees

- Failed or non-finalized transactions are never persisted.
- Unknown, malformed, truncated, and trailing event data fails closed.
- Nested CPI data cannot be misclassified as a Tidebook event.
- Integer conversions are checked before opening a database transaction.
- Conflicts roll back the complete transaction and event batch.
- A transaction, decoder, or storage error leaves the page checkpoint unchanged.
- A terminal empty page retains the last historical cursor for auditing.
- Live subscription starts before HTTP catch-up, so startup notifications are
  buffered instead of falling into a subscribe-after-catch-up race.
- WebSocket logs are wake-ups only; HTTP finalized transactions remain the
  authoritative persisted source.
- Disconnects trigger capped exponential backoff, resubscription, and another
  checkpoint-based HTTP recovery.
- An incomplete live gap is not partially processed when it exceeds the page
  cap; operators must increase the bound or investigate the lag.
- Callbacks run serially, favoring deterministic checkpoint order over maximum
  notification throughput. Yellowstone remains a later scaling option.
- Ctrl+C stops both an active subscription and a reconnect delay cleanly.

## Next

1. Read-optimized projections and an API.
2. Account reconciliation and operational monitoring.
3. Yellowstone evaluation only if standard RPC becomes the measured bottleneck.
