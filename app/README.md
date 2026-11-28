# Outcomia app

The Next.js app for Outcomia. With a Solana wallet it serves prediction, spot,
club and wallet pages. With Loop or Console it serves the Canton workspace.
Design, networks and wallets are covered in [frontend](../docs/frontend.md).

## Setup

```bash
npm ci
cp .env.example .env.local   # first time only; keep existing values
npm run dev                  # http://localhost:3000
```

Checks:

```bash
npm run typecheck
npm run build
for t in prediction shared wallet clubs spot rpc-proxy canton multi-outcome indexer i18n theme; do npm run test:$t; done
```

Unit tests never send transactions. The `scripts/devnet-*.mjs` smoke scripts and
`scripts/local-club-e2e.mjs` do, so read them before you run one.

## Settings

Public `NEXT_PUBLIC_*` values are baked in at build time, so rebuild after you
change them, both locally and on Vercel. Server-only values must never be public.

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_OUTCOMIA_PROGRAM_ID` | `AG4ztZvcZjzFKjoXLzH8M6U3if9CwVFTXH2FHjqg7SdL` |
| `HELIUS_RPC_URL`, `HELIUS_API_KEY` | Server-only RPC behind `/api/solana` |
| `NEXT_PUBLIC_RPC_PROXY_ENABLED` | Browser reads go through the proxy |
| `NEXT_PUBLIC_SOLANA_RPC_URL`, `_FALLBACK_URLS`, `_WS_URL` | Key-free public endpoints and WebSockets |
| `NEXT_PUBLIC_SHARED_BALANCES_ENABLED` | Shared wallet and books |
| `NEXT_PUBLIC_PREDICTION_*_ENABLED` | Draft, opening, funding, orders, matching, cancellation and resolution gates |
| `NEXT_PUBLIC_MULTI_OUTCOME_ENABLED` | Multi-outcome markets (also needs shared balances) |
| `NEXT_PUBLIC_CLUBS_ENABLED` | Clubs |
| `NEXT_PUBLIC_INDEXER_ENABLED`, `INDEXER_API_URL`, `INDEXER_PROXY_SECRET` | Indexed reads and sign-in |
| `NEXT_PUBLIC_CANTON_NETWORK_ID` | `canton:testnet` |
| `CANTON_*` | Canton catalog, registry context and trading gate; see [frontend](../docs/frontend.md#canton-trading) |
| `PYTH_API_KEY` | Hermes prices for combined P&L |
| `FAUCET_*`, `UPSTASH_REDIS_REST_*` | Test faucet; see [deployment](../docs/deployment.md#test-tokens) |

**Defaults.**
- **Configured devnet program:** the feature gates default to on.
- **Any other program ID:** they need explicit opt-in.
- **Not a version check:** a gate is a UI switch. The program still checks every
  role, signature, balance and deadline.
- **Cancellation:** it has its own gate, so stopping new orders never blocks exits.

**RPC proxy.**
- **Allowed calls:** the app's own methods, and program scans of Outcomia only.
- **Limits:** request and response size, plus a soft per-instance rate limit.
- **Errors:** upstream URLs are redacted from error messages.
- **Reads:** reads are paced, coalesced and fail over between providers.
- **Broadcasts:** signed broadcasts are sent once.
- **WebSockets:** use the public WS URL.

## Pages

| Route | Purpose |
| --- | --- |
| `/` | Landing page and wallet picker |
| `/leaderboard`, `/faucet` | Trader leaderboard and test-token faucet |
| `/predictions`, `/predictions/[address]` | Binary discovery and market detail |
| `/predictions/multi`, `/predictions/multi/new` | Multi-outcome discovery and creation |
| `/predictions/new`, `/markets/new` | Creating markets (admin, or club admin for club markets) |
| `/markets`, `/markets/[address]` | Spot markets |
| `/clubs`, `/clubs/[address]` | Club discovery, membership, deposit, settings and markets |
| `/disputes` | Open disputes for admins |
| `/wallet`, `/orders` | Shared balances, legacy deposits, positions and orders |
| `/u/[id]`, `/u/[id]/edit` | Profiles and P&L |
| `/admin` | Admins and platform config (fees, clubs, deposits, disputes) |
| `/design` | Design-system reference |
| `/canton/*` | Canton markets, positions, orders, wallet and clubs |

## Code

- **Rendering:** route pages are Server Components. Wallets and transactions live
  in client components.
- **Account layouts:** `lib/outcomia.ts` and `lib/prediction.ts` define accounts
  and PDAs.
- **Planners:** they build bounded transactions of up to three fills plus a
  remainder, and reject oversized packets before signing.
- **Feature libraries:** `lib/club-*.ts`, `lib/disputes.ts`, `lib/graphql/`,
  `lib/canton/` and `lib/prices/`.
- **IDL:** `idl/` must match the deployed program. Sync it with
  `npm run idl:sync` after `anchor build` (`idl:check` verifies it).
- **Amounts:**
  - **Exact values:** decimal strings are converted to exact integers before
    signing.
  - **Failed reads:** they show as unavailable, never as zero.
  - **Target:** the build targets ES2017, so use `BigInt(n)` instead of `123n`.
- **Rules upload:**
  - **Upload:** the rules JSON (up to 64 KiB) is uploaded to Arweave through Turbo,
    using a wallet message signature, then read back and checked byte for byte.
  - **What the market stores:** the URI and the SHA-256 of those bytes.
  - **Separate steps:** upload and market creation are separate, and retries reuse
    the upload receipt.
- **Dependencies:**
  - **web3.js:** Anchor uses web3.js v1.
  - **Turbo peer:** Turbo's optional `x402-fetch` peer is installed for the build
    only.
  - **Audit:** check `npm audit` directly. Forced fixes can break the Solana stack.
