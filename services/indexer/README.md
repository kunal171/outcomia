# Tidebook Indexer

Rust service that reads finalized Tidebook transactions, decodes all 18 Anchor
event types, and stores the source data in PostgreSQL.

This is a separate Cargo workspace from the Solana program.

## Data flow

```text
finalized Solana RPC
        |
        +--> historical backfill
        |
        `--> WebSocket wake-up --> HTTP gap recovery
                                  |
                                  v
                         decode and store
                                  |
                                  v
                              PostgreSQL
```

WebSocket messages only tell the indexer that new data may exist. The indexer
then fetches complete finalized transactions over HTTP. This gives reconnects
and normal live processing the same storage path.

The indexer stores raw transaction logs, event payloads, decoded JSON, and
schema versions. A transaction and all its events commit together. Exact replay
is accepted; conflicting replay is rejected.

Checkpoints move only after the corresponding records are stored. A restart or
disconnect resumes from the last durable boundary.

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

The Compose database listens on `127.0.0.1:5434`. Migrations run when the
indexer starts.

Migration commands:

```bash
cd services/indexer
sqlx migrate info
sqlx migrate run
```

Stop the local stack with:

```bash
docker compose -f services/indexer/compose.yaml stop
```

For Kind setup and recovery checks, see
[`infra/kubernetes/README.md`](infra/kubernetes/README.md).

## Checks

```bash
cargo fmt --manifest-path services/indexer/Cargo.toml --all --check
cargo test --manifest-path services/indexer/Cargo.toml
cargo clippy --manifest-path services/indexer/Cargo.toml --all-targets -- -D warnings
```

PostgreSQL integration tests are ignored by default:

```bash
DATABASE_URL=postgres://tidebook:tidebook_dev@127.0.0.1:5434/postgres \
  cargo test --manifest-path services/indexer/Cargo.toml -- --ignored
```

## Rules enforced by the indexer

- Store only successful finalized transactions.
- Accept `Program data:` only while Tidebook is the active invocation.
- Reject malformed, unknown, truncated, or trailing event bytes.
- Keep a page checkpoint unchanged if fetch, decoding, or storage fails.
- Start the subscription before catch-up so startup transactions are not
  missed.
- Recover every reconnect gap through HTTP with bounded retries.
- Stop cleanly on SIGINT or SIGTERM.

## Not built yet

- Read-optimized market, order, fill, balance, and fee projections.
- Public read API.
- Account reconciliation and operational monitoring.
- Yellowstone ingestion. It is only needed if standard RPC becomes a measured
  bottleneck.
