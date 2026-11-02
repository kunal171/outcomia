# Tidebook Web App

Next.js client for the Tidebook devnet program.

## Run it

```bash
npm install
npm run dev
```

Production check:

```bash
npm run build
```

## Configuration

Copy `.env.example` to `.env.local` and set:

```bash
NEXT_PUBLIC_TIDEBOOK_PROGRAM_ID=AG4ztZvcZjzFKjoXLzH8M6U3if9CwVFTXH2FHjqg7SdL
NEXT_PUBLIC_SOLANA_RPC_URL=https://your-devnet-endpoint.example
```

`NEXT_PUBLIC_*` variables are compiled into the client bundle. Restart the dev
server or rebuild the Vercel deployment after changing them.

The checked-in IDL must match the output of `anchor build`. Rebuild and redeploy
the program after an instruction or account-layout change.

## Routes

| Route | Use |
| --- | --- |
| `/markets` | Browse active and paused markets |
| `/markets/[address]` | View the book, manage balances, place orders, and control a market |
| `/orders` | View and cancel the connected wallet's open orders |
| `/markets/new` | Create a market as an admin |
| `/admin` | Manage administrators as the super-admin |

The market page shows wallet balances and the corresponding free and locked
Tidebook balances. Inputs use human token units; conversion to integer token
atoms happens before transaction construction.

The client walks the on-chain price-level links to build placement,
cancellation, and matching instructions. These reads can become stale. The
program checks every PDA, price, FIFO link, and balance again when the
transaction runs.

A crossing order can include up to three one-maker match instructions in one
transaction. A safe remainder is appended to the same transaction when the
book is exhausted or the next price does not cross. If more crossing liquidity
exists beyond the cap, the remainder stays free and the user can retry.

## Faucet

The faucet route keeps its mint-authority key on the server. It creates missing
associated token accounts and mints both test assets directly to the requesting
wallet.

Vercel requires shared Upstash counters:

```text
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN
```

Without them, public claims are disabled. The optional in-memory limiter is for
local testing only. Rate limits slow casual abuse but do not prevent a user
from rotating wallets or networks.

The current claim is `10 tBTC` and `1,000 tUSDT`. These are valueless devnet
assets. See [`../docs/deployment.md`](../docs/deployment.md) for setup and
[`../docs/devnet-addresses.md`](../docs/devnet-addresses.md) for public
addresses.

## Devnet matching smoke test

The smoke script creates a fresh market, funds internal balances, places two
FIFO asks, matches both in one transaction, and checks the final book and
balances.

It does not create mints or mint tokens. Provide fresh test mints, signer files,
and funded token accounts:

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

Use a new mint pair for each run because the market PDA is deterministic.

## Code layout

- `app/`: routes and server components.
- `components/solana-provider.tsx`: wallet and RPC providers.
- `components/`: client-side screens and transaction flows.
- `lib/tidebook.ts`: account types, PDA helpers, formatting, and program setup.
- `lib/matching-plan.ts`: bounded FIFO traversal for crossing orders.
- `lib/solana.ts`: network and program ID configuration.

Keep browser APIs, wallet state, and signing inside client components. Route
layout and read-only structure should remain server-rendered where possible.

## Dependency note

Anchor `1.2.0` uses `@solana/web3.js` v1. Some transitive npm advisories remain
in the Solana client stack. `npm audit fix --force` proposes incompatible
package versions, so do not use it without retesting every wallet and
transaction flow.
