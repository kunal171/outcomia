# Indexer and GraphQL data requirements

Status: requirements and proposed contracts; no ingestion, API or frontend
implementation is added by this document. Repository audit: 2026-11-16.

The objective is to serve application reads from indexed data, sharing ingestion
across users instead of repeating program scans, book traversal and transaction
history fetches in each browser. RPC remains the indexer's upstream and the path
for signed transactions, confirmation and any necessary pre-signing checks.
GraphQL resolvers must read projections, not run the old RPC queries per request.

## Scope

First cover Solana devnet: spot, binary prediction and multi-outcome markets,
shared balances, legacy recovery, wallet holdings and administration. Include
multi-outcome account support without claiming that its program is deployed.
Canton needs its own ingestion adapter and is outside this first Solana design.
Cross-outcome matching, clubs/private markets and permissionless creation stay
deferred. Existing public read data needs no wallet connection.

## What exists and what is missing

| Area | Repository evidence | Consequence |
| --- | --- | --- |
| Durable ingestion | `services/indexer/src/{backfill,live,processor}.rs` | Reuse finalized history, reconnect gap recovery, replay checks and checkpoints. |
| Raw storage | `services/indexer/migrations/20261031064356_create_source_records.sql` | Stores signatures, slots, optional time, logs and decoded events; not complete transaction messages, instructions or token balance changes. |
| Ordering | `services/indexer/src/rpc.rs` and the transaction-index migration | Transaction index is nullable. Backfill is oldest-first within each page, not across all pages. A projection must not apply these pages in arrival order. |
| Events | `programs/outcomia/src/events/` and `services/indexer/src/decoder{,/types}.rs` | Decoder covers 21 original events and nine multi-outcome events. Binary prediction and shared-wallet operations lack dedicated events in the audited implementation. |
| Event completeness | `programs/outcomia/src/events/multi_outcome.rs` | Multi-outcome events are useful history but omit parts of terms, proposals, balances and queue linkage. Events alone are insufficient for the full frontend. |
| Query service | `services/indexer/src/health.rs` | Health endpoints exist. No GraphQL API, account snapshots, read projections or subscriptions exist yet. Readiness does not measure time-based lag. |
| Browser reads | Components and libraries listed below | Several panels independently fetch overlapping market, metadata, book, mint and wallet data. Most refreshes are mount/manual/post-transaction reads; one-second local clocks are not themselves RPC polling. |

Account-state ingestion is therefore required alongside transaction/event
history. A current snapshot cannot recreate past fills, past balances or proposal
corrections. Missing history must be reported explicitly rather than synthesized.

## Required data inventory

All records carry chain/network/program identity, source address or transaction,
commitment, source slot, observation time, decoder version and projection revision.
IDs and joins use addresses, not display names or symbols.

| Dataset | Required fields and relationships | Source and processing |
| --- | --- | --- |
| Protocol and roles | Super-admin, taker fee basis points, admin address, added-by address, active/disabled status; protocol and admin account addresses | `ProtocolConfig`, `AdminRecord`; governance events for history. Derive UI role without treating it as transaction authorization. |
| Market registry | Market address/ID, kind, authority, metadata address, status, supported book engines, collateral or base/quote mint and vault addresses, discovery visibility | `Market`, `PredictionMarket`, `MultiOutcomeMarket`, `MarketMetadata`. Infer concrete market type from account layout; `MarketMetadata.kind` alone does not distinguish all three kinds. |
| Display and asset metadata | Display name, symbols, mint address, token program, decimals; missing/conflicting metadata status | Market metadata plus mint accounts. Symbols are labels, never asset identities. Cache mint precision centrally. |
| Prediction terms | Full question when verified, question hash, exact rules hash and URI, ordered outcome IDs/labels, payout atoms, price tick, contract lot, close/earliest-resolution time, review delay, primary/fallback resolver and fallback windows | Binary market fields and `MultiOutcomeTerms`; verified off-chain rules supplement the committed hashes. Preserve permanent multi-outcome outcome order. |
| Resolution state | Stored phase/status, proposal outcome, proposed-at, evidence URI/hash, final outcome; derived review end, fallback eligibility and next deadline | Binary/multi market and proposal state. Distinguish Invalid from an indexed winner and from unresolved. Passing a deadline does not itself change stored on-chain status. |
| Books and depth | Book address/engine, outcome, side, raw price, aggregated remaining quantity, order count, best bid/ask, FIFO head/tail, price-level neighbors, order links, next order ID, open-order count | Legacy spot/binary books, `SharedBook`/`SharedPriceLevel`/`SharedOrder`, and multi-outcome books/orders. Validate linkage and totals before publishing a usable revision. Multi-outcome depth is aggregated from its order ladder; it has no separate price-level account. |
| Orders | Address, market/book/engine, book-scoped order ID, owner, outcome, side, original/remaining quantity, price, locked amount and its unit, open/filled/canceled status, queue neighbors; source creation/update/closure positions when known | All four order account families; applicable events/decoded instructions supply history. Account disappearance is not evidence of a fill. Preserve closed/deleted records with provenance. |
| Trades and executions | Stable execution ID, signature, instruction/event position, slot/index/time, market/book/engine/outcome, maker/taker, maker order, taker side, price, filled quantity, collateral or quote atoms, fees | Existing legacy spot and multi-outcome fill events where emitted. Shared/binary execution history needs additional instruction/execution ingestion or future program events. Snapshots cannot supply it. |
| Shared protocol cash | Owner, mint, balance account address, free atoms and locked atoms across markets; custody vault reference | `AssetBalance` and vault token accounts. A shared cash balance must not be copied into each market position or summed once per book. |
| Legacy balances | Owner/market/address, spot base/quote free and locked amounts; binary legacy collateral free and locked amounts | `TraderBalance` and `PredictionPosition`; retained separately for withdrawal/migration/recovery. Do not combine custody engines without labeling their origin. |
| Outcome positions and claims | Owner/market, per-outcome free/locked contracts, binary YES/NO or ordered multi-outcome holdings, applicable final outcome, estimated redeemable atoms and claim availability | Binary and multi position accounts joined to market terms/state. Contract quantities are not collateral atoms; a derived claim is not extra spendable cash. |
| External wallet holdings | Native SOL lamports, every owned supported SPL token account, token mint/program/decimals, amount, frozen amount, account count; aggregated wallet holdings | System/SPL account ingestion for tracked wallets. Include non-associated token accounts. Current frontend supports the classic SPL token program; Token-2022 is a separate extension. These changes can occur without any Outcomia transaction. |
| Fees, reserves and backing | Legacy accrued fees, shared-book quote fees, multi-book collateral fees, outstanding outcome supplies, backing reserve, custody vault balances and reconciliation status | `MarketFees`, the relevant books/markets and SPL vault accounts. Separate redeemable backing from protocol fees and unrelated tokens sent to vaults. |
| Activity and receipts | Deposits/withdrawals, migrations, split/merge, order actions, fills, proposals/corrections/finalization, claims, fee withdrawals, admin actions; signature, actor and time when available | Events plus decoded successful instruction/execution records. Record coverage per activity type. User transaction confirmation may precede indexed visibility. |
| Faucet and recovery | Faucet address, mint pair, claim amounts, authority/config and known claim activity; staged terms-buffer owner/address/market ID, byte count and recoverable-rent information | `TestFaucet`, faucet events, `MultiOutcomeTermsBuffer`, account lamports. Never expose wallet key material; raw draft-buffer bytes are not needed in normal UI responses. |
| Indexed rules and evidence | Original bounded bytes, content hash, expected hash, verification result, fetched-at, document schema, fetch/parse error and cache status | Fetch committed URIs centrally with bounded size/time and network restrictions. Cache immutable content by hash. Keep unverified content distinguishable from on-chain commitments. |

The canonical account family list comes from `app/idl/outcomia.json`: 23 account
layouts, including legacy accounts and staged terms buffers. Account ownership,
expected PDA, relationships and applicable IDL version must be validated; an
unknown layout must not be silently decoded as a known one. Persist the network
genesis identity, program ID and decoder/IDL version. Keep a database scoped to
one network/program until an explicit namespace migration supports more; the
existing raw tables do not independently identify multiple deployments.

## Frontend reads to replace

| Screen or consumer | Indexed response needed | Current code anchors |
| --- | --- | --- |
| Spot discovery | Paginated markets, metadata, mint precision, active engine and top-of-book | `app/components/markets.tsx` |
| Binary discovery/detail | Market summaries; terms, lifecycle, rules, both outcome books, connected-wallet context | `app/components/prediction-markets.tsx`, `prediction-book.tsx`, `prediction-position.tsx` |
| Multi-outcome discovery/detail | Summaries; all named outcomes, terms, lifecycle, depth/orders, positions, shared collateral and fee configuration | `app/components/multi-outcome/markets.tsx`, `app/components/multi-outcome/use-market.ts` |
| Spot workspace/settings | Market/config, legacy/shared book, depth, latest execution, fees, faucet and owner balances | `app/components/market-detail.tsx`, `market-settings.tsx`, `shared-market.tsx` |
| Wallet | One owner view of external assets, shared cash, legacy balances, positions and available claims with independent coverage/errors | `app/lib/wallet-overview.ts`, `app/lib/multi-outcome-wallet.ts`, `app/components/shared-wallet.tsx` |
| Orders | Owner-filtered, paginated orders across market engines, metadata and cancellation context | `app/components/{orders,shared-orders,prediction-orders}.tsx`, `app/components/multi-outcome/wallet-activity.tsx` |
| Header/admin/creation | Role/config, mint information, fee settings, staged-buffer recovery | `protocol-role-provider.tsx`, `admin-management.tsx`, creation components and `multi-outcome/terms-recovery.tsx` |
| Trade history | Latest execution and later paginated fills | Replace `app/lib/outcomia.ts:fetchLatestTrade`, which currently scans recent signatures and up to six transaction bodies per market read. |

The landing-page order-flow/pricing illustration in `dashboard.tsx` is explicitly
decorative. It is not a missing live-price feed. Existing smoke-market visibility
rules in `app/lib/market-visibility.ts` must move into discovery queries while
preserving direct-address access and wallet/order recovery for hidden markets.
A feature being indexed must not automatically enable its UI deployment flag.

## Derived data: define before displaying

Depth and best prices are current-state requirements. History-dependent metrics
come after execution coverage is established:

- Latest executed price, distinct from midpoint/best bid/best ask. Return its source.
- Per-market/per-outcome volume and fee totals in their native units, with a known
  time range and coverage. Splits, merges and wallet transfers are not trades.
- UTC OHLCV buckets from executions ordered by canonical chain position. Never
  invent candles from current book snapshots or missing historical timestamps.
- Price change over a specified interval only when a comparable prior execution
  exists. Missing history is null/unavailable, not zero change.
- Position valuation only with a named price source and missing-price handling.
  Supply, open interest and backing are distinct metrics requiring explicit units.
- Realized/unrealized P&L and USD portfolio totals are later additions: complete
  acquisition/transfer history and an agreed valuation source are not established.
  Token symbols do not imply a dollar peg; prediction prices are market quotes.

## Ingestion and processing contract

1. Retain the existing finalized transaction/event store and durable checkpoints.
   Add versioned raw account snapshots and, where required for eventless paths,
   full transaction execution data: message/account keys (including loaded
   addresses), instructions/inner instructions, logs, balance changes and errors.
   Failed execution must never update financial projections.
2. Bootstrap all supported program-owned account types, referenced mint/vault
   accounts and configured protocol identity. Buffer live notifications during
   bootstrap, reconcile the boundary, then advertise dataset readiness.
3. Maintain one shared account-change ingestion path. Deduplicate/debounce dirty
   account keys, fetch in batches when needed, and periodically reconcile. Browser
   count must not multiply upstream program scans or subscriptions.
4. Watch external assets only for bounded tracked wallets: one initial discovery
   of owned token accounts, shared subscriptions for known accounts and native SOL,
   plus periodic discovery to catch new/closed token accounts. Bound retention,
   refresh rates and wallet counts; public wallet queries cannot create unbounded
   upstream work. Return a warming state rather than fake zero balances.
5. Store account address/owner/lamports/data, source context slot, commitment,
   data hash and provider write version if available. Same-slot notifications
   need ordered provider versions or a coalesced authoritative refresh; slot alone
   cannot order multiple writes. `minContextSlot` is a lower bound, not an atomic
   multi-account snapshot. Delete/tombstone accounts only on validated closure or
   a completed authoritative reconciliation, never because a fetch failed.
6. Build versioned projections for markets/outcomes, books/levels/orders, balances,
   positions, executions, activity, roles and fees. Apply each source exactly once
   transactionally with its projection checkpoint. Do not apply an old history
   record over a newer account snapshot. Snapshot state and historical reducers
   need explicit cutover positions and independent checkpoints.
7. Replay history by `(slot, transaction_index, log_index/execution_position)`;
   enrich missing transaction indexes from an authoritative block source before
   order-sensitive replay. Signature sorting and RPC page-arrival order are not
   substitutes for execution order. Identify fills so instruction decoding and
   event decoding cannot count the same execution twice.
8. Reconcile ledger/reserve/supply and queue invariants. Publish an unavailable or
   degraded book on inconsistency, not a partial book that looks empty. A reducer
   or decoder failure leaves the affected watermark behind the failing record.
9. Publish revision notifications after the database commit, then let subscribers
   obtain the committed revision. Keep raw sources replayable for decoder or
   projection corrections. Unknown events/layouts and deployment/IDL mismatches
   must surface as coverage errors, not silently missing rows.

Current historical limits are material: accounts can supply latest state even
where dedicated events are absent, but exact old shared/binary executions require
an audited instruction decoder and available historical execution data. If those
cannot reconstruct a required action, additional program events are needed in a
separate, explicitly scoped upgrade. No program deployment is part of this plan.

## Freshness and consistency

Proposed default: confirmed live state for responsive books/balances, plus a
separate finalized durable history. The user preference between this and a
finalized-only first version is pending. Confirmed data must be labeled and
rollback-capable; do not mix confirmed balances with finalized locks in one
purported snapshot or finalize history from an unrooted notification.

Every query returns dataset-level synchronization information:

- Commitment, projection revision, source/as-of slot, observed-at and projected-at.
- Ingested-through and projected-through positions; history start and completeness.
- `READY`, `WARMING`, `STALE`, `RECONCILING`, `UNAVAILABLE` or `UNSUPPORTED`, with
  relevant errors. Distinguish unknown/deleted/not-yet-indexed accounts.
- A commitment-matched chain-head observation and catch-up heartbeat. The last
  program transaction can be old while the indexer is fully caught up; its age
  alone is not a lag measurement.

A top-level response timestamp is not sufficient for independently updating
wallet datasets. Pushed revisions should follow a successful commit promptly;
latency/staleness budgets must be measured against provider observation and
chain commitment before promising a numeric service level. Finalized-only reads
will inherently appear later than confirmed wallet receipts.

After submitting a transaction, the frontend keeps its signature/pending state
until the chosen indexed view reports that transaction as applied. Do not clear
an order form or subtract balances optimistically as if indexing were complete.
Use a bounded targeted refresh/reconciliation path on delay, not a full-program
scan from every client. Local deadline clocks remain local between state updates.

## Proposed GraphQL read contract

Names below define query groups, not a final executable schema. Concrete spot,
binary and multi-outcome types retain their distinct terms and accounting.
Book engine is explicit (`LEGACY_SPOT`, `LEGACY_BINARY`, `SHARED_SPOT`,
`SHARED_BINARY`, `MULTI_OUTCOME`); market plus side is not a unique book identity.

| Operation group | Inputs | Response responsibility |
| --- | --- | --- |
| `syncStatus`, `protocol`, `admins` | Network/program; role/status filters | Coverage/freshness, protocol configuration and paginated admin records. |
| `markets`, `market` | Kind, lifecycle status, search, visibility, cursor/limit; address for detail | Paginated discovery or joined market/outcome/asset/terms/lifecycle detail. Include initialized-book capability separately from market existence. |
| `orderBook`, `orders` | Market, engine, outcome, side/price range/depth; owner/status/cursor filters | Consistent depth and best prices, validated queue context, paginated individual orders. Return revision/truncation, not an unbounded order tree. |
| `wallet`, `positions` | Owner; market/mint/status filters and pagination | External holdings, shared cash, legacy balances, outcome claims, orders/activity counts and per-dataset sync state. Owner lookup is public data, not proof of wallet ownership. |
| `trades`, `activity`, `transaction` | Market/outcome/owner/action/time filters; signature | Paginated executions/activity and indexed transaction/application status with history-coverage information. |
| `rulesDocument`, `evidenceDocument` | Committed hash/market/proposal | Verified cached document and fetch/verification state. No arbitrary user-supplied URL fetch in a resolver. |
| `marketStats`, `candles` | Market/outcome, explicit range/interval/cursor | Derived metrics with units, price source and coverage; unsupported until the underlying history is trustworthy. |
| `termsUploads`, `faucet` | Owner or market | Recovery/configuration views, known history and missing-data state. |
| Subscriptions | Market/engine/outcome; wallet; transaction signature | Revision/invalidation or bounded deltas for book, trade, market/lifecycle, wallet/order and transaction application changes. Reconnect with cursor/revision; gaps require resync. |

Use cursor pagination, deterministic ordering, query depth/cost and result limits,
batched relational loading and indexes for each public filter. Ordinary reads
must not trigger synchronous RPC or unbounded joins. If wallet tracking needs a
registration command, make it explicit, bounded and deduplicated; it is not a
financial mutation. Transaction signing/submission remains in the wallet flow.

Amounts, raw prices, quantities, order IDs and slots must round-trip as exact
integer strings/custom scalars. Use PostgreSQL numeric types for unsigned u64
and larger aggregates rather than signed BIGINT or floating point. GraphQL Int
and JavaScript Number cannot represent these values safely. Return decimals and
units explicitly; formatted/localized labels belong in the frontend.

## Build order and completion gates

1. Agree dataset scope and freshness/commitment policy. Resolve required history
   coverage for shared/binary trading before promising trade charts or P&L.
2. Add raw account/execution ingestion, bootstrap boundaries and reconciliation.
   Demonstrate reconnect recovery, validated closures and unchanged RPC work
   when multiple clients request the same already-tracked data.
3. Add current-state projections and deterministic replay/checkpoints in focused
   migrations/commits. Prove balance, order-link, fee and reserve invariants against
   canonical account fixtures and a bounded reconciliation run.
4. Add GraphQL queries and sync metadata over those projections, then subscriptions
   and transaction-applied signaling. Verify exact numbers, filters, pagination,
   query limits, stale/error states and subscription reconnect behavior.
5. Migrate discovery, market detail/depth, wallet, orders and admin consumers one
   screen at a time. Remove normal rendering/history RPC scans as each switches.
   Keep targeted signing/confirmation/preflight checks where correctness needs them.
6. Add execution history and then stats/candles only for covered engines/time ranges.
   Prove one execution is counted once and missing history remains visible.

Acceptance includes current smoke-market hiding, all legacy exit/recovery paths,
wallet identity changes, cross-wallet live updates, no false empty books/balances,
post-transaction convergence, restart/backfill recovery and projection rebuilds.
Measure RPC call counts and API/read-to-render latency before/after migration.
This requirements pass does not alter the running indexer, database, deployment
flags, chain program or frontend data source.
