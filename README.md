# Outcomia

**Every Outcome Has a Market.**

Prediction markets on Solana, with YES/NO order books and one collateral asset
per market. Outcomia also supports spot trading and includes a Rust indexer
that stores finalized transactions in PostgreSQL.

This is a devnet research project. Shared asset balances, prediction trading,
delayed resolution and redemption are deployed and smoke-tested on devnet.
Use test tokens only.

See [shared balances and settlement](docs/shared-balances-resolution.md) for the
new custody model, legacy recovery and rollout checks.

The shared [frontend](docs/shared-frontend.md) also connects Console Wallet for
the Canton prediction workspace. Canton contracts and services are developed in
[`outcomia-canton`](https://github.com/kunal171/outcomia-canton); market deployment
is pending there. Solana functionality below remains available.

## What works

- Admin-created prediction markets with named questions, published rules,
  resolver keys, trading deadlines and optional fallback terms.
- Wallet-owned positions, collateral deposits and withdrawals, and complete-set
  split/merge: one collateral token backs one YES plus one NO contract.
- YES/NO limit orders, price-time priority, partial fills and owner cancellation.
  The client can match up to three makers atomically and post a safe remainder.
- Spot markets with base/quote vaults, internal balances, price ticks, quantity
  lots, matching, cancellation and administrator controls.
- Configurable taker fees, per-market accounting and spot fee withdrawal.
- A Next.js UI with market discovery, order books, wallet balances, readable
  prices, market metadata and prediction guides.
- Finalized transaction ingestion with historical backfill, live recovery,
  durable checkpoints and PostgreSQL storage.

Prediction trades settle internal balances immediately. Determining the final
YES/NO outcome and paying winning positions are separate, implemented lifecycle steps.
See the [rename compatibility notes](docs/rebranding.md) for existing environment
variables, database identities and deployment keys.

The indexer retains source transactions; it does not yet provide prediction
trade projections or a public query API.

## Run and verify

The program uses Rust `1.97.1`, Anchor `1.2.0`, Solana CLI `4.1.2` and LiteSVM
`0.16.0`. The Rust toolchain is pinned in `rust-toolchain.toml`.

```bash
anchor build
anchor test --skip-deploy
```

The test command runs LiteSVM without a local validator. Bare `anchor test`
deploys to the configured cluster before running tests; use `--skip-deploy`
for local verification.

Start the web app:

```bash
cd app
npm ci
cp .env.example .env.local  # First setup only; keep existing configuration.
npm run dev
```

Fill in your Helius devnet configuration and review the prediction rollout
flags before using the app. See the [app guide](app/README.md).

## Devnet program

`AG4ztZvcZjzFKjoXLzH8M6U3if9CwVFTXH2FHjqg7SdL`

[View on Solana Explorer](https://explorer.solana.com/address/AG4ztZvcZjzFKjoXLzH8M6U3if9CwVFTXH2FHjqg7SdL?cluster=devnet).
The address matches `declare_id!` and `Anchor.toml`.

For a deliberate upgrade after building and testing:

```bash
anchor program deploy --no-idl
```

The app uses its checked-in IDL. Deployment details and the IDL-upload
workaround are in the [deployment guide](docs/deployment.md).

## Project layout

| Directory                                        | Contents                                                    |
| ------------------------------------------------ | ----------------------------------------------------------- |
| [`programs/outcomia`](programs/outcomia)         | Anchor program and LiteSVM tests                            |
| [`app`](app/README.md)                           | Next.js UI, wallet flows and transaction builders           |
| [`services/indexer`](services/indexer/README.md) | Separate Rust workspace for ingestion and storage           |
| [`docs`](docs/README.md)                         | Architecture, design decisions, diagrams and test addresses |

The indexer has a local [Docker/Kind setup](services/indexer/infra/kubernetes/README.md).
Cloud infrastructure and Terraform deployment remain separate work.
