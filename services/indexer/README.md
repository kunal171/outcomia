# Outcomia indexer

Rust service for Solana devnet account state, finalized execution history,
wallet holdings and wallet-authenticated profiles. PostgreSQL serves GraphQL
reads and revision notifications; resolvers never scan Solana per browser request.
This is a separate Cargo workspace from the Anchor program.

## Code structure

| Folder | Responsibility |
| --- | --- |
| `src/ingestion/` | RPC/WebSocket reads, account reconciliation, wallet holdings, transaction recovery and backfill. |
| `src/processing/` | Account/event decoding, account projections, instruction replay, mint precision and candles. |
| `src/api/graphql/` | Separate account, market, wallet, chart, receipt and subscription resolvers. |
| `src/api/mod.rs` | HTTP transport, schema composition and notification listener. |
| `src/auth.rs` | Wallet challenges, signature verification, users and sessions. |
| `src/storage/` and `migrations/` | Durable source records, checkpoints and schema. |
| `../../app/lib/graphql/` | Frontend operations grouped by the same domains; `client.ts` is shared transport and `proxy.ts` is server-only forwarding. |
| `../../app/lib/indexed-accounts.ts` | Exact JSON-to-Anchor hydration and account reader adapter. |

## Coverage and consistency

All 23 program account layouts and 30 event types are decoded against the
checked-in IDL. Account snapshots include spot, binary and multi-outcome markets,
books, orders, balances, positions, proposals, roles and recovery accounts.
A complete, validated contextual scan atomically publishes one revision per
commitment; only such a scan can mark missing accounts deleted. Confirmed state
can change on a fork; finalized state cannot regress.

One confirmed program subscription coalesces account refreshes, with periodic
confirmed/finalized reconciliation. Independent workers cache mint precision and
refresh tracked wallets' SOL/SPL holdings. Wallet tracking follows verified login;
profiles never accept financial balances from clients. Stale/warming reads fail
visibly rather than returning an apparently empty book or silently falling back
to browser RPC.

Finalized logs and retained transaction bodies support ordered execution replay.
Spot/multi-outcome fill events and legacy/shared spot/binary instruction replay
feed bounded OHLCV queries. Missing execution order, timestamps, initialization
provenance or historical coverage produce `INCOMPLETE`, not invented prices.
Charts currently use finalized executions; provisional candles, depth charts,
P&L and USD valuation remain later work. These changes do not upgrade the program
or establish a live deployment.

## Run locally

Run these commands from the repository root. Copy the example only on first
setup; preserve an existing `.env`.

```bash
cp services/indexer/.env.example services/indexer/.env
```

For an existing pre-rename Compose database, add
`-f services/indexer/compose.legacy.yaml` after `-f services/indexer/compose.yaml`
to **every** Compose command below. Keep the existing `.env` database URL. The
override reuses the existing volume and credentials; omitting it selects a new,
empty Outcomia database. Neither setup deletes the other volume.

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

New Compose setups use the Outcomia database, user and volume. Existing setups
use the compatibility override above; see [rename notes](../../docs/rebranding.md).

The database is exposed on loopback port `5434`; containers use `postgres:5432`.
`DATABASE_URL` is required. RPC, WebSocket and program settings default to devnet
and `AG4ztZvcZjzFKjoXLzH8M6U3if9CwVFTXH2FHjqg7SdL`. SQLx migrations run at startup.
The host process needs Rust `1.97.1`; Docker uses the pinned builder image.

For [Kind/Kubernetes](infra/kubernetes/README.md), use the separate manifest
setup. These local runtimes do not establish a cloud deployment.

## GraphQL and sign-in

The API defaults to `127.0.0.1:8081`; operational health remains on `8080`.
Set `APP_ORIGIN` to the exact browser origin (HTTPS outside loopback).
In the frontend, enable `NEXT_PUBLIC_INDEXER_ENABLED=true` at build time and set
the server-only `INDEXER_API_URL=http://127.0.0.1:8081`. The frontend flag defaults
to false so an unconfigured deployment retains its existing data source.

`POST /graphql` serves account pages, individual/raw accounts, sync status,
wallet assets, the current user, latest trade, finalized candles and transaction
receipts. See [schema.graphql](schema.graphql) for the exact contract. Account
pages pin a revision and cursor; concurrent revisions require a fresh first page.
Amounts and slots are decimal strings, preserving full integer precision.
Example:

```graphql
query Market($address: String!) {
  account(address: $address, commitment: "confirmed") {
    address
    accountType
    data
    slot
    revision
  }
  syncStatus(commitment: "confirmed") {
    ready
    slot
    observedAt
  }
}
```

`POST /graphql/stream` accepts a GraphQL subscription and returns SSE. One
PostgreSQL listener fans out committed revision notifications; clients resync on
reconnect or lag. Confirmed receipts become `CONFIRMED_INDEXED` only when the
account snapshot has caught up; finalized receipts also require finalized source
history. An indexed receipt establishes snapshot convergence, not optimistic
financial credit.

`POST /auth/challenge` issues an expiring, single-use, origin/network/address-bound
message. `POST /auth/verify` verifies its Ed25519 signature before creating a user
and an HttpOnly, SameSite=Strict session. Only credential hashes are stored.
`GET /auth/me` reuses the session; `POST /auth/logout` revokes it, including an
in-flight challenge. Challenge issuance is rate limited. The Next same-origin
proxy forwards cookies without exposing session credentials to JavaScript.

Signing programs retain direct account checks, transaction sending and chain
confirmation. Indexed readers serve normal screen rendering; no secret key is
required by the indexer or login.

## Processing flow

```text
confirmed account subscription -> contextual scans -> atomic account revisions
finalized backfill/live recovery -> source transactions/events -> ordered replay
verified wallet tracking -> shared holdings worker -> wallet revisions
PostgreSQL projections -> GraphQL queries / SSE -> frontend readers and charts
```

Source transactions/events commit together with replay conflict checks and
durable recovery checkpoints. Reconnects recover gaps through HTTP. History
failures retry independently of the API and current-state workers. The database
is bound to the devnet genesis, configured program and IDL hash before workers
start. Run one indexer per program/database configuration.

## Health and checks

`/health/live` reports process liveness. `/health/ready` also requires successful
catch-up and a reachable database. Readiness is not a time-based lag metric.

```bash
cargo fmt --manifest-path services/indexer/Cargo.toml --all --check
cargo test --manifest-path services/indexer/Cargo.toml
cargo clippy --manifest-path services/indexer/Cargo.toml --all-targets -- -D warnings
```

Run the isolated PostgreSQL integration tests against a local test database
(the example uses fresh-install credentials; use the existing credentials with
the compatibility override):

```bash
DATABASE_URL=postgres://outcomia:outcomia_dev@127.0.0.1:5434/postgres \
  cargo test --manifest-path services/indexer/Cargo.toml -- --ignored
```

Frontend codec/receipt checks and all-account fixture verification:

```bash
npm --prefix app run test:indexer
```

For the browser → Next proxy → Rust API → PostgreSQL test, first build/start the
frontend on `127.0.0.1:3024` with the indexer, shared-balance and multi-outcome
public flags enabled and `INDEXER_API_URL=http://127.0.0.1:8084`. Then run:

```bash
INDEXER_BROWSER_TEST=1 DATABASE_URL=postgres://USER@127.0.0.1:PORT/postgres \
  cargo test --manifest-path services/indexer/Cargo.toml browser_through_real_api -- --ignored --nocapture
```

The test creates an isolated migrated database, runs the API on `8084`, and uses
a local fake Solana upstream. Set `PLAYWRIGHT_MODULE` to your installed
Playwright entry point. The default is the local test setup under
`/tmp/outcomia-browser/node_modules/playwright/index.mjs`. No chain transactions
are sent. Screenshots are written to ignored `app/target/indexer-browser-artifacts/`.

Production capacity, provider/archive coverage and RPC/latency benchmarks remain
to be measured against the real deployment. Yellowstone is a later option if
measured RPC limits justify it.
