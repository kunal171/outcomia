# Outcomia docs

Design notes for the prediction and spot order books, the web app and the
indexer. Each feature document includes its account model and limitations;
shared custody and payout instructions are deployed and verified on devnet.

## Start here

- [Outcomia rename](rebranding.md): package names, deployment identity and compatibility.

- [Future platform scope](future-scope.md): user-created predictions, private
  markets, clubs, multi-outcome trading and governance. Planned features only.
- [Architecture](architecture.md): accounts, instructions, authorization,
  balances and application routes.
- [Prediction market design](prediction-market-design.md): single-collateral
  YES/NO positions, trading, rules commitments and resolution/claims.
- [Multi-outcome foundation](multi-outcome-markets.md): single-winner scope,
  exact refund rules and bounded outcome IDs. Not deployed.
- [Shared balances and settlement](shared-balances-resolution.md): reusable asset
  custody, legacy recovery, resolver windows and redemption.
- [App setup](../app/README.md): RPC settings, prediction rollout flags and
  wallet flows.
- [Devnet deployment](deployment.md): upgrade procedure and program identity.
- [Devnet addresses](devnet-addresses.md): test mints, wallets and markets.

Shared custody, prediction trading and resolution/claims are deployed on devnet.
The live smoke report is in [deployment notes](deployment.md). Legacy prediction
fee withdrawal remains separate from the new shared-book fee path.
Some design notes describe the earlier implementation sequence; they are not
live deployment records.

## Order-book design

- [Price levels and FIFO](price-level-fifo-design.md): linked price levels,
  queue mutations, invariants and tradeoffs.
- [Crankless settlement](crankless-settlement-design.md): Phoenix/OpenBook
  comparison and Outcomia's bounded matching with internal balances.
- [Future enhancements](future-enhancements.md): indexing, reference prices,
  market making, AMM work and later research.

## Operations and diagrams

- [Indexer](../services/indexer/README.md): finalized logs, PostgreSQL,
  checkpoints, event coverage and recovery.
- [Local Kubernetes](../services/indexer/infra/kubernetes/README.md): Kind,
  workload manifests, health probes and persistent storage.
- [Outcomia architecture](diagrams/outcomia-architecture.drawio).
- [Prediction architecture](diagrams/prediction-market-architecture.drawio).

Open `.drawio` files in [draw.io](https://app.diagrams.net/). Their legends
separate implemented and planned components.

## Checks

From the repository root:

```bash
anchor build
anchor test --skip-deploy
npm --prefix app run typecheck
npm --prefix app run test:prediction
npm --prefix app run test:shared
npm --prefix app run test:wallet
npm --prefix app run test:rpc-proxy
npm --prefix app run test:i18n
npm --prefix app run test:theme
npm --prefix app run build
```

Bare `anchor test` deploys before testing. Indexer checks run separately using
its own manifest; commands are in its README.
