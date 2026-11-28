# Outcomia indexer

A Rust service that indexes the Outcomia program into PostgreSQL. It stores
account state, finalized transaction history, wallet holdings and profiles, and
serves them over GraphQL. Resolvers never call Solana per request. It is a
separate Cargo workspace from the program.

## Code

| Path | What it does |
| --- | --- |
| `src/ingestion/` | RPC/WebSocket reads, account reconciliation, holdings, backfill, recovery |
| `src/processing/` | Account and event decoding (`account_codec.rs`), projections, instruction replay, candles, wallet discovery |
| `src/api/graphql/` | Resolvers for accounts, markets, wallets, charts, receipts, subscriptions |
| `src/auth.rs`, `src/canton/` | Wallet challenges, sessions, Canton ledger claims |
| `src/storage/`, `migrations/` | Source records, checkpoints, schema (SQLx, applied at startup) |
| `schema.graphql` | The GraphQL contract |
| `../../app/lib/graphql/`, `../../app/lib/indexed-accounts.ts` | Frontend operations and account hydration |

## How it works

```text
confirmed account subscription → contextual scans → atomic account revisions
finalized backfill / live recovery → source transactions and events → ordered replay
verified wallets → holdings worker → wallet revisions
PostgreSQL → GraphQL queries and SSE → app readers and charts
```

- **Decoding:** every account and event is decoded against the IDL.
  - **IDL history:** `IDL_HISTORY` keeps earlier IDLs, newest first, so the
    indexer decodes both the deployed program and the next one during an upgrade.
  - **Fixtures:** regenerate them with
    `node app/scripts/generate-indexer-fixtures.mjs --write`.
- **Revisions:** each commitment publishes one revision per complete scan, and
  only a complete scan can mark accounts deleted.
  - **Confirmed:** confirmed state can change on a fork.
  - **Finalized:** finalized state never regresses.
- **Charts:** finalized fills and replayed instructions feed OHLCV candles.
  - **Complementary fills:** a complementary YES/NO fill records two trades.
  - **Gaps:** missing history returns `INCOMPLETE` rather than invented prices.
- **Binding:** the database is bound to the devnet genesis, program and IDL hash
  before workers start. Run one indexer per program and database.

## Run locally

From the repository root:

```bash
cp services/indexer/.env.example services/indexer/.env   # first time only
docker compose -f services/indexer/compose.yaml up -d --build
curl --fail http://127.0.0.1:8080/health/ready
```

Or run only the database in Docker, with the indexer on the host (Rust 1.97.1):

```bash
docker compose -f services/indexer/compose.yaml up -d postgres
set -a; source services/indexer/.env; set +a
cargo run --manifest-path services/indexer/Cargo.toml
```

- **Ports:**
  - **Postgres:** `127.0.0.1:5434`.
  - **Health:** `:8080`, with `/health/live` and `/health/ready`. Ready means
    caught up with a reachable database.
  - **API:** `:8081`.
- **Defaults:** devnet and program `AG4ztZvcZjzFKjoXLzH8M6U3if9CwVFTXH2FHjqg7SdL`.
- **Pre-rename databases:** add `-f services/indexer/compose.legacy.yaml` to
  every Compose command.
- **Other runtimes:** [Kind/Kubernetes](infra/kubernetes/README.md) and
  [Northflank](infra/northflank/README.md).

## App connection

- **Build flag:** set `NEXT_PUBLIC_INDEXER_ENABLED=true` at build time.
- **Server settings:** `INDEXER_API_URL` and `INDEXER_PROXY_SECRET`.
- **Indexer origin:** set `APP_ORIGIN` on the indexer to the browser origin.
- **Proxy:** the app proxies requests from the same origin and forwards cookies,
  but scripts never see session credentials.

**Endpoints.**
- **Queries:** `POST /graphql` serves account pages pinned to a revision, raw
  accounts, sync status, wallet assets, trader stats, candles, receipts and
  profiles. Amounts and slots are decimal strings.
- **Subscriptions:** `POST /graphql/stream` serves subscriptions over SSE. Clients
  resync after a reconnect.

**Fallback.**
- **When:** network errors, a 5 s timeout, HTTP 408/429/5xx or warming/stale
  responses make the app fall back to confirmed RPC.
- **Scope:** it falls back only for the dataset that failed.
- **Recovery:** it retries GraphQL every 15 s, and a source badge shows which
  source is in use.
- **No substitutes:** history and charts never fall back to made-up data.
- **Sending:** transactions are sent once. A guarded provider stores the
  signature before broadcast, so a reload or a lost reply never causes a
  duplicate.

## Sign-in

**Solana.**
- **Challenge:** `POST /auth/challenge` issues a single-use message that is
  bound to the origin, network and address.
- **Verify:** `POST /auth/verify` checks the Ed25519 signature and sets an
  HttpOnly, SameSite=Strict session. Only hashes of credentials are stored.
- **Session:** `GET /auth/me` returns the current user and `POST /auth/logout`
  ends the session.
- **Expiry:** a session ends after 2 h idle or 24 h in total.
- **Rate limits:** 10 per minute per client, 5 per minute per wallet, and 600 per
  minute overall.

**Canton.**
- **Settings:** needs the `CANTON_*` variables.
- **Endpoints:** `/auth/canton/challenge`, `/auth/canton/verify`,
  `/auth/canton/unlink` and `/auth/solana/link`. They use `ProfileClaim`
  contracts; see [profiles](../../docs/profiles.md).

**During an outage.**
- **Without a session:** a wallet can still read, trade and settle.
- **Discovery:** wallets that funded the protocol meanwhile are found later from
  finalized accounts and deposit history, as unverified `registration_source=chain`
  users.
- **No sessions or balances:** discovery never creates a session or writes a
  balance.
- **Signing in later:** a later sign-in keeps the same user ID.

## Checks

```bash
cargo fmt --manifest-path services/indexer/Cargo.toml --all --check
cargo clippy --manifest-path services/indexer/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path services/indexer/Cargo.toml
DATABASE_URL=postgres://outcomia:outcomia_dev@127.0.0.1:5434/postgres \
  cargo test --manifest-path services/indexer/Cargo.toml -- --ignored
npm --prefix app run test:indexer
```

**Browser end-to-end test** (browser → Next proxy → API → Postgres, against a
fake Solana upstream).
1. Start the app on `127.0.0.1:3024`, with the indexer flags and
   `INDEXER_API_URL=http://127.0.0.1:8084`.
2. Run
   `INDEXER_BROWSER_TEST=1 cargo test ... browser_through_real_api -- --ignored`,
   with `PLAYWRIGHT_MODULE` set.

## Not done

- **Typed views:** typed, joined market, book and wallet responses. Today the app
  assembles views from account envelopes.
- **Server-side queries:** search, discovery filtering, and paginated trade
  history.
- **More data:** provisional candles, depth charts, and P&L across every chain.
- **Not measured:** production capacity, archive coverage and latency.
  Yellowstone is an option if RPC limits require it.
