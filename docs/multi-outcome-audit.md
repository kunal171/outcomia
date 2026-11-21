# Multi-outcome completion audit — 15 November 2026

The agreed local scope is complete after the fixes below. This is a local
implementation and verification record, not evidence of devnet deployment or a
live wallet smoke test. No public-network transaction was submitted during this
audit. Cross-outcome matching, clubs/private markets, permissionless creation,
governance, and indexer query projections/API remain separate work.

## Findings fixed

| Finding | Result |
| --- | --- |
| A capped fill left the original requested quantity in the form. | Only a confirmed transaction updates the form. Filled/rested amounts clear; only the exact unsubmitted remainder stays for an explicit retry. Rejected approvals leave the original input intact. |
| Resolution controls selected a resolver by time alone. | Controls now follow the stored primary/fallback phase, earliest resolution time, exclusive deadlines and review maturity. Local clock updates enable mature actions without RPC polling. |
| Cached filtered account scans could disagree with a freshly fetched book root. | Mutable owner/market scans bypass discovery caching. Unfiltered discovery retains its short cache. |
| A failed market read removed the Refresh button. | Refresh remains available after the detail data is cleared, so a transient error has a recovery path. |
| Shared Wallet/Orders views omitted multi-outcome activity. | Canonical owner positions/orders are listed, the wallet summary counts those markets, and collateral listed only by a multi-outcome market is discoverable before a deposit. Contracts remain separate from cash totals. |
| The fee-withdrawal instruction lacked a UI. | The super-admin can withdraw a positive amount no greater than the book's earned fees to the wallet's associated token account. The program still enforces authority and backing. |
| An async creation could continue after leaving the page. | Unmount aborts the rules read and prevents later wallet approvals. Creation, market submissions and rent recovery check the current mounted session; recovery also prevents duplicate submissions. |
| IDL synchronization could preserve an obsolete nested account order. | Only top-level catalogs retain their old ordering. Nested account/field/variant order follows the generated ABI, with a regression test and `npm run idl:check`. |

All fixes and tests were delivered as small commits on
`feature/multi-outcome-markets`.

## Evidence

| Check | Result |
| --- | --- |
| `cargo test -p outcomia` | 379 passed, including actual SPL transfers and rollback in LiteSVM. The audit changed no on-chain program behavior. |
| Indexer regular suite | 75 passed. |
| Indexer PostgreSQL suite | All 8 passed against a new, temporary local PostgreSQL cluster. Includes a raw multi-outcome fill decoded, stored, and replayed exactly once with its type, outcome, collateral and fee fields intact. |
| Strict Clippy and formatting | Program and indexer pass. |
| App checks | Typecheck plus prediction, shared trading, wallet, Canton, RPC proxy, theme, i18n and multi-outcome suites pass. |
| Multi-outcome client regressions | 8 pass: real IDL encoding, exact fees and safe remainder, invalid links/self-trades/lots, direct/staged creation sizes, smoke visibility, resolution windows, fresh filtered reads, wallet identity, and generated wire ordering. |
| Generated ABI comparison | App IDL matches the generated program ABI. |
| Enabled production build | Build and local browser fixture pass with shared balances and multi-outcome enabled. |
| Disabled production build | Build and browser gate check pass; creation is disabled and no transaction is submitted. |

The production browser flow uses an ephemeral test keypair, in-memory RPC data
and blocked external requests. It covers shared Wallet/Orders navigation, read
failure and refresh recovery, owner cancellation, wallet rejection, a 12-contract
order capped after 9 contracts with an exact 3-contract retry, earned fees,
cutoff freeze, proposal, timed finalization, redemption, reviewed creation,
abandoned buffer rent recovery, mobile layout and navigation away during a
pending rules fetch. It never reads the configured CLI keypair.

The contract suite independently checks the economic transitions; the browser
fixture verifies UI, instruction construction, signing/receipt handling and
refresh behavior. These are complementary checks, not a live network test.

## Release boundary

Keep `NEXT_PUBLIC_MULTI_OUTCOME_ENABLED=false` for unverified deployments.
A deliberate program upgrade, matching IDL/configuration, deployed indexer
compatibility and real wallet/ledger smoke test are still required before live
multi-outcome trading is enabled. Those actions were explicitly excluded from
this work.

Update, 21 November 2026: the program upgrade, IDL sync and live two-wallet
smoke test are complete; see [deployment](deployment.md). Deployed indexer
compatibility and enabling the UI flag remain outstanding.
