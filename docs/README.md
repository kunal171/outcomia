# Documentation

Start with the architecture document, then open the design note for the part
you are changing.

| Document | Contents |
| --- | --- |
| [Architecture](architecture.md) | Accounts, instructions, invariants, tests, and current limits |
| [Price levels and FIFO](price-level-fifo-design.md) | Sorted level list and same-price order queues |
| [Matching and settlement](crankless-settlement-design.md) | Internal balances, bounded matching, and Phoenix/OpenBook tradeoffs |
| [Future work](future-enhancements.md) | Indexer projections, oracle work, market making, and AMM research |
| [Devnet deployment](deployment.md) | Program deployment and faucet setup |
| [Devnet addresses](devnet-addresses.md) | Public devnet accounts and transaction signatures |
| [Indexer](../services/indexer/README.md) | Backfill, live recovery, decoding, and PostgreSQL storage |
| [Kubernetes](../services/indexer/infra/kubernetes/README.md) | Local Kind deployment and recovery checks |

The editable system diagram is
[`diagrams/tidebook-architecture.drawio`](diagrams/tidebook-architecture.drawio).

Run the program checks from the repository root:

```bash
anchor build
anchor test --skip-deploy
```
