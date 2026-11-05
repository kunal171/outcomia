# Tidebook App

The Tidebook web application is a Next.js App Router, React, and TypeScript
client for the Anchor program.

## Run locally

```bash
npm install
npm run dev
```

Create a production build with:

```bash
npm run build
```

## Current UI milestone

- Connect a browser wallet through Solana Wallet Adapter.
- Connect to Solana devnet.
- Discover active and paused markets without connecting a wallet.
- Display the connected wallet's aggregate base and quote SPL balances beside
  its market-specific internal free and locked balances.
- Enter deposits, withdrawals, prices, and quantities in human token units;
  the client performs exact decimal-to-atomic conversion before signing.
- Create markets as an active protocol administrator.
- Create named spot or experimental markets atomically, attach labels to older
  markets, and update symbols or display names without changing market type.
- Open a dedicated administrator settings page from each market detail route to
  initialize or update its human-readable metadata.
- Submit bids and asks that either cross up to three best-price FIFO makers in
  one atomic transaction or rest as collateralized limit orders, including
  empty, best, middle, worst, and same-price FIFO insertion paths.
- Atomically post a valid taker remainder when the bounded path exhausts the
  crossing book or reaches a non-crossing price; keep it free only when more
  crossing liquidity remains beyond the cap or its bid notional rounds to zero.
- List wallet-owned open, filled, and canceled orders; only open orders expose
  cancellation, including while a market is paused.
- Pause, unpause, and safely close markets as their authority.
- Manage protocol administrators as the super-admin.
- Provide a server-backed, rate-limited faucet that mints fixed amounts of both
  valueless assets directly into any connected wallet's associated token
  accounts.

The checked-in client IDL mirrors the generated Anchor IDL. After any account
layout or instruction change, rebuild and redeploy the program before using the
updated client against devnet.

## Prediction draft foundation

- `/predictions`: public prediction-market discovery, including open markets.
- `/predictions/new`: active-admin form creating the draft, vault, metadata,
  fees and empty book root in one instruction.
- `/predictions/[address]`: public inspection of collateral, resolution windows,
  resolver keys, rules URI and content hashes; connected-wallet position
  initialization and display of all six free/locked balance fields.
  The position panel also displays wallet collateral and includes a separately
  gated deposit/withdrawal form and whole YES/NO pair split/merge actions.

Draft and position creation remain disabled by default. After deploying the
matching program containing both initializers,
set `NEXT_PUBLIC_PREDICTION_DRAFTS_ENABLED=true` and rebuild. This switch only
controls rollout; the program enforces the admin role for drafts and owner
signatures for positions independently.

Position creation is available to any signing wallet and only pays SOL rent.
It creates no collateral or outcome claims, and duplicate initialization cannot
reset existing balances. Confirmation reloads the account; RPC failures do not
display fabricated zero balances or offer initialization based on a failed read.
Wallet changes reset the position panel, and the first wallet render is delayed
until hydration to match the server HTML.

Upload the rules JSON to Arweave first, then select the exact same local file
and enter its URI in the form. Use schema version 1 from
[`prediction-market-design.md`](../docs/prediction-market-design.md). Resolver
keys and timing come from the file. Hashing uses the original bytes; changing
whitespace changes the rules hash. The form does not verify the remote copy.

Contracts use whole quantities and pay one collateral token per winning
contract. Prices use the mint's precision. Trading, resolution
and redemption are later milestones; a newly created account is always Draft.

Prediction deposits, withdrawals and complete sets are implemented locally. Keep
`NEXT_PUBLIC_PREDICTION_FUNDING_ENABLED=false` against older deployments. After
deploying all three operations, enable it alongside the draft flag and
rebuild against the matching program. A deposit credits only free collateral;
it creates no YES/NO positions. Resolved markets reject deposits.

The form converts human amounts to exact mint atoms, checks wallet balance and
ledger overflow, then chooses one wallet token account able to fund the amount.
The displayed wallet balance is aggregated: fragmented funds may require a
smaller deposit. Failed balance reads disable submission. Confirmed deposits
refresh wallet and position balances. The program enforces ownership, mint and
vault checks independently of this UI.

Withdrawals spend available collateral only and work after trading closes or
resolution. The client creates a missing collateral ATA atomically; wallet SOL
pays rent. Wallet-balance read errors block deposits but do not block recovering
a known available position balance. Zero amounts and overspending disable submission.

Splitting one whole pair reserves one collateral token and creates one YES
plus one NO internal contract. Merging burns a free pair and returns that token
to available collateral; it does not transfer tokens out of the vault. Locked
outcomes cannot be merged. Splitting requires Open status before close; merging
works in Open, Frozen and Proposed. Drafts must be opened first. Confirmation
refreshes the position and backing reserve.

The market detail page shows an **Open market** control only to the stored
market authority. It requires Draft status, a time before close and the creator's
current active admin record. Disabled or removed admins cannot open markets;
another active admin cannot open someone else's market.
Opening preserves all committed terms and balances. After deploying the opening
instruction, set `NEXT_PUBLIC_PREDICTION_OPENING_ENABLED=true` alongside the draft
flag and rebuild; this new flag defaults false against older binaries. The
client reloads the market after confirmation and enables position splitting.
Opening does not yet enable order placement or settlement. The rules file's
`primaryResolver` must match the creator wallet. The creator will propose the
outcome once settlement is implemented; traders will claim payouts themselves.

`lib/prediction.ts` also defines the upcoming book, price-level and order account
interfaces and their PDA helpers. Outcome and side use textual seeds; prices
and IDs use exact eight-byte little-endian BN encoding. Shared Rust/browser
test vectors protect that contract. The IDL-backed reader now exposes the root,
which is initialized with the draft at next ID 1 and four absent best-price heads.
The detail page shows these fields and its Explorer link. Older drafts missing
the root are identified explicitly; create a fresh draft for the new order flow.
The reader also exposes prediction levels and orders. The position panel has a
resting-order form for any connected trader: YES/NO, buy/sell, human-unit price
and whole quantity. It selects empty-side placement, same-price FIFO append or
sorted new-price insertion from actual accounts. New-price discovery follows
at most 128 linked levels and validates ordering and reciprocal links. The
program rechecks adjacent hints and rejects stale ones atomically.
RPC errors never trigger a fallback path. It rejects crossing
prices and checks free funds and exact integer bounds. Buys lock collateral;
sells lock outcome contracts. Confirmations refresh the ledger and public book.
Appending preserves older orders' priority; the prior tail's owner does not sign
and its balances do not change. Queue/totals, ownership and packet-size checks
are covered in Rust/client tests. Cancellation remains unavailable.

Keep `NEXT_PUBLIC_PREDICTION_ORDERS_ENABLED=false` publicly until cancellation
and matching are implemented. Explicit local tests may enable it alongside the
draft/funding flags after deploying this version. The form states that placed
orders cannot yet be canceled and remain locked. No admin role is required for
trading. Rebuild/redeploy the program before using the updated client on devnet.

Verify the JSON parser, exact-byte hashing and PDA derivation with:

```bash
npm run test:prediction
```

Configure the public program identity and optionally override the default
devnet RPC endpoint:

```bash
NEXT_PUBLIC_TIDEBOOK_PROGRAM_ID=AG4ztZvcZjzFKjoXLzH8M6U3if9CwVFTXH2FHjqg7SdL
NEXT_PUBLIC_SOLANA_RPC_URL=https://your-devnet-endpoint.example
```

Copy `.env.example` to `app/.env.local` or add the variables to the existing
ignored `app/.env`. Configure the same public program-ID variable in Vercel.
Next.js inlines `NEXT_PUBLIC_*` values during its build, so changing the program
identity requires restarting the local server or rebuilding the deployment.

## Test faucet safety

The active web faucet is server-backed. Its authority key is loaded only by the
Next.js server route; it is never sent to the browser or stored in Git. A claim
creates missing associated token accounts and mints fixed amounts directly to
the requesting wallet, so the server does not maintain a transferable token
inventory.

Claims are limited by both wallet and hashed IP address. Vercel fails closed
unless `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` provide shared
durable counters. The process-local limiter is an explicit local-development
fallback and must never be enabled on Vercel. These limits are abuse friction,
not Sybil resistance: a determined caller can rotate wallets and networks.

The current devnet pair claims `10 tBTC` and `1,000 tUSDT` once per wallet per
hour, with at most five claims per IP in the same window. These assets have no
value and must never be bridged, sold, or treated as production tokens.

The program-controlled PDA faucet remains an alternative research design, but
a mint must use exactly one authority model at a time. Do not initialize the
on-chain faucet after transferring authority to the server account.

Full bootstrap steps and address placeholders live in `docs/deployment.md` and
`docs/devnet-addresses.md`.

## Multi-maker devnet smoke test

`npm run devnet:multi-maker` executes a one-shot current-layout smoke test. It
creates the market and internal balances, deposits test assets, places two asks
at one FIFO level, submits two matching instructions in one transaction, and
asserts the final orders, market pointers, level closure, and exact balances.

The runner intentionally does not create or mint SPL assets. Supply fresh
no-value devnet mints, temporary signer files, and their funded token accounts:

```bash
SOLANA_WALLET=/path/to/deployer.json \
MAKER_TWO_WALLET=/path/to/second-maker.json \
TAKER_WALLET=/path/to/taker.json \
BASE_MINT=<base-mint> \
QUOTE_MINT=<quote-mint> \
MAKER_ONE_BASE_TOKEN=<token-account> \
MAKER_TWO_BASE_TOKEN=<token-account> \
TAKER_QUOTE_TOKEN=<token-account> \
npm run devnet:multi-maker
```

Use a fresh mint pair for each run because the market PDA is deterministic and
the script deliberately tests initialization as part of the complete flow.

## Application boundaries

- `app/layout.tsx` and route pages are Server Components by default.
- `components/solana-provider.tsx` owns the client-only wallet and RPC context.
- `components/` contains the client-side route workspaces and transaction flows.
- `lib/tidebook.ts` owns account types, PDA derivation, token-account discovery,
  price-level traversal, formatting, and Anchor program construction.
- `lib/solana.ts` owns shared network and program-identity configuration.

Price-level traversal begins at the market best price and follows
`worse_price` links, so transaction construction is currently O(number of price
levels). Those RPC reads are advisory: the on-chain instruction revalidates all
neighbor accounts atomically, and a stale transaction must refresh and retry.
An indexer can later accelerate discovery without changing the program API.

Crossing-order construction is isolated in `lib/matching-plan.ts`. It starts at
the opposing best price, validates the linked price levels and FIFO queues, and
collects at most three makers. Every step records the taker quantity before its
fill, the resting maker price, canonical maker ledger, and only the successor,
worse-level, or rent-recipient accounts needed by that transition. The market
page converts the plan into one `match_limit_order` instruction per maker and
sends every instruction in one Solana transaction.

The planner's RPC reads are advisory. Each instruction revalidates best-price,
FIFO, PDA, owner, crossing-price, and reciprocal-link invariants against the
state produced by the preceding instruction. A stale later step therefore
rolls back the entire transaction. The three-maker cap bounds transaction size,
account metadata, compute, and stale-state exposure. When the planned path
proves that no crossing maker remains, the page appends an insert-or-append
instruction for the valid remainder to the same transaction. A remainder stays
free and visible only when crossing liquidity remains beyond the cap or its bid
notional rounds to zero.

New routes should keep read-only structure server-rendered and move only wallet,
transaction, state, and browser-dependent behavior behind `"use client"`.

## Dependency note

Anchor `1.2.0` requires legacy `@solana/web3.js` v1, while the faucet uses the
latest compatible `@solana/spl-token` package for associated token accounts.
`npm audit --omit=dev` currently reports nine transitive advisories through
`bigint-buffer`, `jayson`, `stream-json`, `toml`, and `uuid`.

npm's proposed forced remediations replace the direct packages with incompatible
historical or invalid versions (`@solana/spl-token@0.1.8`,
`@solana/web3.js@0.0.3`, or `@anchor-lang/core@0.0.0`), so they are not applied.
This boundary should be rechecked when the Solana/Anchor client stack publishes
compatible patched releases. Do not run `npm audit fix --force` without first
validating all generated transactions and wallet flows.
