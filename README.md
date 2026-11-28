# Outcomia

**Every Outcome Has a Market.**

Outcomia runs prediction markets on Solana with a fully on-chain order book.
- **Markets:** binary and multi-outcome (2–8) markets, plus spot pairs.
- **Funding:** a shared wallet that funds every market.
- **Clubs:** communities with security deposits, and outcome disputes.
- **Indexer:** a Rust indexer with GraphQL.

The same Next.js app also serves the Canton version
([`outcomia-canton`](https://github.com/kunal171/outcomia-canton)).

Outcomia runs on devnet only, with test tokens.

## Features

- **Prediction markets:**
  - **Types:** binary and multi-outcome markets.
  - **Rules:** published as hashed documents.
  - **Backing:** complete sets backed by one collateral asset.
  - **Resolution:** delayed, with corrections, an optional fallback resolver and
    permissionless finalization.
- **Order book:**
  - **Priority:** price-time priority with FIFO queues.
  - **Matching:** up to three makers matched atomically per transaction, plus a
    resting remainder.
  - **Complete-set matching:** YES/NO pairs, and full sets across outcomes.
- **Shared custody:** one balance per wallet and mint, usable in every market.
- **Clubs:**
  - **Membership:** private, request-to-join or open, with invitations and roles.
  - **Markets:** members-only or public.
  - **Economics:** a club share of fees, and USDC or SOL (Pyth) security
    deposits.
  - **Lifecycle:** switching type, settling markets and closing the club.
- **Disputes:** a bonded dispute window on every market, ruled by an independent
  admin.
- **Profiles:** one profile across Solana and Canton, with combined USD P&L.
- **Indexer:** finalized history, candles, sign-in and an RPC fallback in the app.

## Quick start

Toolchain: Rust 1.97.1 (pinned in `rust-toolchain.toml`), Anchor 1.2.0, Solana
CLI 4.1.2, Node 20+.

```bash
anchor build
anchor test --skip-deploy        # LiteSVM, no validator

cd app && npm ci && cp .env.example .env.local && npm run dev
```

- **Tests:** bare `anchor test` deploys before testing, so use `--skip-deploy`.
- **App:** set the Helius RPC and feature flags first; see
  [app/README.md](app/README.md).

## Checks

```bash
anchor build
anchor test --skip-deploy
cargo clippy --all-targets -- -D warnings
npm --prefix app run typecheck
npm --prefix app run build
npm --prefix app run test:prediction   # also: shared, wallet, clubs, spot, rpc-proxy,
                                        # canton, multi-outcome, indexer, i18n, theme
```

The indexer's checks are in its [README](services/indexer/README.md#checks).

## Devnet

Program [`AG4ztZvcZjzFKjoXLzH8M6U3if9CwVFTXH2FHjqg7SdL`](https://explorer.solana.com/address/AG4ztZvcZjzFKjoXLzH8M6U3if9CwVFTXH2FHjqg7SdL?cluster=devnet).
Addresses, settings and the upgrade procedure are in
[deployment](docs/deployment.md).

## Layout

| Path | Contents |
| --- | --- |
| [`programs/outcomia`](programs/outcomia) | Anchor program and LiteSVM tests |
| [`app`](app/README.md) | Next.js app, wallet flows, transaction planners |
| [`services/indexer`](services/indexer/README.md) | Rust indexer, PostgreSQL, GraphQL |
| [`docs`](docs/README.md) | Design docs, diagrams, devnet evidence |
