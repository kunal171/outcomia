# Outcomia app

The shared Next.js UI for Outcomia. Connect a Solana wallet for existing prediction
and spot markets, or Console Wallet for the Canton prediction workspace. Canton
contracts are not deployed yet. See [the network boundary](../docs/shared-frontend.md).

## Local setup

From this directory:

```bash
npm ci
cp .env.example .env.local  # First setup only; do not replace existing values.
npm run dev
```

Open `http://localhost:3000`. For checks:

```bash
npm run typecheck
npm run test:canton
npm run test:prediction
npm run test:wallet
npm run test:rpc-proxy
npm run test:shared
npm run test:theme
npm run test:i18n
npm run build
```

`test:prediction` covers rule parsing, hashes, addresses and matching plans.
`test:wallet` checks portfolio accounting, listing filters, account ownership and
partial RPC failures. Neither test command submits devnet transactions.

## Display settings

The header provides System, Light and Dark modes and English, Hindi, Spanish,
French and Portuguese. Preferences persist in cookies and are applied during
server rendering. All pages use the same cobalt, soft-white and ink palette. New visitors start
in Light mode; saved appearance choices are retained.

Translation files are in `i18n/messages/`. Add interface text to all five files;
`test:i18n` checks coverage and interpolation arguments. Creator-written rules,
market names, token symbols and provider diagnostics remain unchanged. Amounts
keep exact decimal strings and displayed deadlines remain in UTC. See the
[UI guide](../docs/ui-design.md) for layout and content rules.

## Canton wallet

`NEXT_PUBLIC_CANTON_NETWORK_ID=canton:devnet` selects the expected Console Wallet
network. The browser validates the live primary party before opening
`/canton/markets`. No private keys or wallet tokens belong in environment files.

## RPC and program settings

Use the current devnet program and your own Helius endpoint:

```dotenv
NEXT_PUBLIC_OUTCOMIA_PROGRAM_ID=AG4ztZvcZjzFKjoXLzH8M6U3if9CwVFTXH2FHjqg7SdL
HELIUS_RPC_URL=https://devnet.helius-rpc.com
HELIUS_API_KEY=<your-server-key>
NEXT_PUBLIC_RPC_PROXY_ENABLED=true
NEXT_PUBLIC_SOLANA_WS_URL=wss://api.devnet.solana.com/
NEXT_PUBLIC_SOLANA_RPC_URL=https://api.devnet.solana.com
NEXT_PUBLIC_SOLANA_RPC_FALLBACK_URLS=https://solana-devnet.api.onfinality.io/public,https://api.devnet.solana.com
```

A full Helius URL containing `?api-key=...` also works; keep it in the server-only
`HELIUS_RPC_URL`, never a `NEXT_PUBLIC_` variable. Store both Helius settings as
Vercel Secrets. The browser uses its own deployment's `/api/solana` endpoint.
Public Config contains only the proxy flag, program ID and key-free fallbacks.

HTTP reads verify devnet, pace requests, coalesce duplicates and fail over when
a provider is busy. Discovery/history reads have short caches; balance and
planning reads are not TTL-cached. Signed broadcasts are forwarded once and
are never automatically replayed after a network failure. WebSockets use the
separate public devnet WS URL; Vercel's HTTP route does not host WebSockets.
`FAUCET_SOLANA_RPC_URL` still overrides the server faucet's RPC.

The RPC route allows the app's methods, restricts program scans to Outcomia,
limits request/response sizes and batches, and redacts upstream error URLs.
Its per-instance rate limit is a soft bound, not a distributed quota. It does
not replace the durable Redis requirement for public token-faucet claims.

`.env.local` overrides `.env`. Restart the dev server after changing public
settings. On Vercel, set the same variables in the project and rebuild: Next.js
embeds them at build time. A program upgrade does not update a deployed UI.

## Prediction rollout

The updated prediction trading program is deployed on devnet. The UI defaults to enabled prediction gates for this program ID. Other program
IDs require explicit opt-in. For the updated program, these settings enable all
supported features:

```dotenv
NEXT_PUBLIC_PREDICTION_DRAFTS_ENABLED=true
NEXT_PUBLIC_PREDICTION_OPENING_ENABLED=true
NEXT_PUBLIC_PREDICTION_FUNDING_ENABLED=true
NEXT_PUBLIC_PREDICTION_CANCELLATION_ENABLED=true
NEXT_PUBLIC_PREDICTION_ORDERS_ENABLED=true
NEXT_PUBLIC_PREDICTION_MATCHING_ENABLED=true
```

Rebuild after changing them. A disabled-feature message means the corresponding UI gate is off; it is not
an on-chain version check. Explicit `false` overrides the default. Disable these
flags when targeting an older binary, even if it uses the same program ID.
Cancellation has its own gate so stopping new orders need not block exits.
The program independently checks roles, signatures, balances and trading times.

Resolution and redemption are deployed on devnet and use explicit rollout flags. Legacy
prediction fee withdrawal remains separate. Trading fills settle internal balances; final outcome settlement
is a different step. The UI's help dialogs explain this distinction.

## Pages

| Route                         | Purpose                                                                                        |
| ----------------------------- | ---------------------------------------------------------------------------------------------- |
| `/`                           | Prediction-first landing with an illustrative scroll walkthrough                               |
| `/predictions`                | Public discovery and a pricing/settlement guide                                                |
| `/predictions/[address]`      | Terms, YES/NO depth, positions, funding and trading                                            |
| `/markets`                    | Public spot-market discovery                                                                   |
| `/markets/[address]`          | Spot order book, balances, orders and authority controls                                       |
| `/markets/[address]/settings` | Admin metadata creation and updates                                                            |
| `/markets/new`                | Choose Spot or Prediction                                                                      |
| `/markets/new/spot`           | Admin spot-market creation                                                                     |
| `/predictions/new`            | Admin prediction draft creation and rules upload                                               |
| `/wallet`                     | Connected wallet SOL, held/deposited Outcomia assets, market balances and prediction positions |
| `/orders`                     | Shared spot/prediction orders, Open/History filters and optional legacy orders                 |
| `/admin`                      | Super-admin governance and administrator management                                            |

Shared prediction orders appear on `/orders` and in the relevant market’s position panel.
Legacy order readers stay unmounted until their disclosure is opened.
Creation requires an active admin. Opening a prediction draft requires both
its stored creator and an active admin record. Trading needs a wallet, not an
admin role.

## Trading and display

Spot detail uses a price-level book beside the trade form, with the form first
on mobile. Same-price quantities are grouped exactly; selecting a price fills
the existing input. Deposit/withdraw controls load when expanded, and technical
market details start collapsed. Older per-market orders, deposits and fee
withdrawals remain in a recovery disclosure. Refresh keeps entered trade values.

Spot amounts use the stored base/quote mint decimals. Prediction quantities
are whole contracts; prices use the collateral mint's precision. The client
converts decimal strings to exact integer amounts before signing.

Buys lock collateral; sells lock base tokens or outcome contracts. The client
matches up to three best-price FIFO makers in one transaction. A safe limit
remainder can rest at the chosen price; a cap-blocked remainder stays free for
retry. Immediate-only prediction orders never post. On-chain checks reject
stale hints atomically. Cancellation releases the unfilled lock; withdrawal
moves free tokens back to the wallet.

Symbols come from metadata, with known devnet test-mint labels as fallbacks.
Spot detail shows the most recent fill found in bounded history, or an
explicitly labeled indicative book quote, plus its inverse. It does not track
an external market price. Landing examples are illustrations, not live markets.

## Wallet overview

`/wallet` shows native SOL and token balances for assets listed in Outcomia
markets. Unrelated wallet tokens are excluded; listed tokens appear before a
first deposit, and existing deposits stay visible when wallet holdings are zero.
Amounts are grouped by mint, not symbol, across all owned SPL token accounts.
Frozen wallet amounts are identified separately.

Spot and prediction ledgers are queried by owner at byte offset 40, checked
against their canonical PDAs, and shown per market. The asset table combines
available collateral and order locks without valuing YES/NO contracts as cash.
The prediction section lists free and locked contracts separately. Missing
market units or failed reads produce unavailable totals, not fabricated zeros.
Market links lead to the existing deposit, withdrawal and position controls.
Legacy balances remain per wallet/market. The new shared path initializes one
`AssetBalance` per wallet/mint; the same USDC is spendable across shared books.
The wallet page identifies legacy deposits and offers signed transfers of free
cash. Cancel old orders before moving their released funds. YES/NO contracts
and their backing remain question-specific.

The page only reads accounts and never requests a signature. Refresh manually
after transactions; the confirmed reads may span different slots. Changing or
disconnecting the wallet clears its view and invalidates older pending results.

The logo mark collapses the desktop sidebar to an icon rail; the preference is
saved locally. On mobile, the mark inside the navigation drawer closes it.

## Prediction rules upload

The creator edits a rules template, optional fallback terms and extra text/JSON
fields. Custom fields live under `additionalRules`; they cannot overwrite core
terms. The connected creator is the primary resolver.

After review, the app validates the rules, admin, mint and price grid. It uses
wallet message signing and Turbo to upload the JSON, fetches it back and checks
the exact bytes. The market commits the URI and SHA-256 hash of those bytes.
The file limit is 64 KiB. See the [rules schema](../docs/prediction-market-design.md).

Uploading and creating the market are separate operations. A failed market
transaction cannot undo an upload. Same-document, same-wallet retries reuse
the receipt while the page remains open; download it before leaving. Gateway
verification checks bytes, not final Arweave block inclusion. The app checks
free allowance, may use existing storage credits, and never tops up or signs
Solana storage payments.

## Test faucet

The server route mints fixed amounts into the requesting wallet's token
accounts. Keep its authority secret server-only and out of Git. Configure
mints, claim amounts and limits through the server variables in `.env.example`.
The documented test pair uses 8-decimal tBTC and 6-decimal tUSDT.

Vercel claims require Upstash's shared counters and fail closed without them.
`FAUCET_ALLOW_IN_MEMORY_RATE_LIMIT` is for local testing only. Claims are limited
by wallet and hashed IP; these limits do not prevent someone using multiple
wallets and networks. Server-controlled and program-PDA mint authorities are
alternative models; do not enable both for the same mint.

The [address registry](../docs/devnet-addresses.md) records test assets.
`npm run devnet:multi-maker` is a separate, transaction-sending spot smoke test;
it needs fresh devnet mints and funded signer/token accounts. Read
`scripts/devnet-multi-maker-smoke.mjs` before running it.

## Code and dependencies

Route pages/layouts are Server Components by default. Wallets and transactions
live in client components. `lib/outcomia.ts` and `lib/prediction.ts` define
accounts and addresses; the matching planners build bounded transaction plans.
The checked-in IDL must match the deployed program.

Anchor uses legacy web3.js v1. Turbo's optional `x402-fetch` peer is installed
because Next.js resolves its dynamic import during builds; no x402 funding is
enabled. Dependencies have upstream audit advisories. Recheck the current audit
rather than relying on a saved count; forced fixes can replace the Solana stack
with incompatible versions.

## Shared custody and settlement rollout

The current devnet program passed its live smoke test. Enable these when using
that program:

```env
NEXT_PUBLIC_SHARED_BALANCES_ENABLED=true
NEXT_PUBLIC_PREDICTION_RESOLUTION_ENABLED=true
```

Production and Preview enable both flags. Defaults and `.env.example` remain off
for safe rollout to other program binaries; keep them off for an older deployment. A market's
active-admin creator enables its shared book from the market detail page.
The new panel displays shared orders separately from legacy liquidity.

`/wallet` supports shared deposits/withdrawals and legacy free-cash transfers.
Trading matches up to three FIFO makers and posts only a noncrossing remainder.
Oversized packets are rejected before signing. Initialize missing mint balances
separately if a first trade is too large. Failed reads are shown as unavailable.

Prediction detail pages add creator closure, evidence-backed proposals/corrections,
fallback activation, delayed finalization and free-contract redemption. Proposal
files are hashed locally; the resolver uploads evidence independently and supplies
its permanent reference. The app does not verify the remote bytes. Anyone can
finalize a mature proposal; only the configured active-admin resolver can propose.
Legacy cash stays withdrawable; redemption credits the shared mint balance.
