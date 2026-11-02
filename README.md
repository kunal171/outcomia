# Tidebook

Tidebook is a central limit order book built on Solana with Anchor. The project
is a study of order-book storage, collateral accounting, atomic settlement, and
off-chain indexing.

The program is deployed on devnet. The repository also contains a Next.js
client and a Rust indexer backed by PostgreSQL.

## What works

- Markets for two SPL Token mints, with configurable price ticks and quantity
  lots.
- Governance, administrators, market pause/unpause, and safe market closure.
- Per-trader free and locked balances backed by market token vaults.
- Sorted bid and ask levels with FIFO ordering at each price.
- Limit placement, cancellation, partial fills, and full fills.
- Atomic matching against up to three makers in one client transaction.
- Automatic posting of a safe unmatched remainder.
- Taker fees, per-market fee accounting, and treasury withdrawals.
- Typed Anchor events for the web client and indexer.
- Finalized-history backfill and live recovery into PostgreSQL.

Matching settles internal balances immediately. Tokens move through the SPL
Token Program only for deposits, withdrawals, fee withdrawals, and vault
closure.

## Layout

```text
tidebook/
├── app/                         Next.js client
├── docs/                        Design and deployment notes
├── programs/tidebook/           Anchor program and LiteSVM tests
├── services/indexer/            Rust event indexer
├── Anchor.toml
└── rust-toolchain.toml
```

The indexer is a separate Cargo workspace so it can use newer RPC and database
dependencies without changing the program's Anchor/LiteSVM dependency set.

## Build and test

```bash
anchor build
anchor test --skip-deploy
```

`--skip-deploy` runs the LiteSVM suite without deploying to the configured
devnet cluster. Bare `anchor test` deploys first.

Deploy an upgrade with:

```bash
anchor program deploy --no-idl
```

`--no-idl` works around the current metadata CLI packaging issue. The app uses
the IDL produced by `anchor build`.

## Devnet program

```text
AG4ztZvcZjzFKjoXLzH8M6U3if9CwVFTXH2FHjqg7SdL
```

[Open the program in Solana Explorer](https://explorer.solana.com/address/AG4ztZvcZjzFKjoXLzH8M6U3if9CwVFTXH2FHjqg7SdL?cluster=devnet).

The program ID must match `declare_id!`, `Anchor.toml`, the app environment,
and `target/deploy/tidebook-keypair.json`.

## Documentation

- [Architecture](docs/architecture.md)
- [Matching and settlement](docs/crankless-settlement-design.md)
- [Price levels and FIFO queues](docs/price-level-fifo-design.md)
- [Devnet deployment](docs/deployment.md)
- [Indexer](services/indexer/README.md)
- [Local Kubernetes runtime](services/indexer/infra/kubernetes/README.md)
