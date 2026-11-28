# Frontend

One Next.js app in `app/` serves both networks. The
[`outcomia-canton`](https://github.com/kunal171/outcomia-canton) repository holds
the Canton contracts and services, but it has no frontend of its own.

## Networks and wallets

- **Landing page:** the user picks a wallet.
  - **Solana wallet:** opens `/predictions`, plus the spot, wallet and order pages.
  - **Loop or Console:** opens `/canton/markets`, `/positions`, `/orders` and
    `/wallet`. There is no Canton spot.
- **Workspace:** `NetworkWalletProvider` chooses it from the live wallet connection.
  - **Remembered wallet:** session storage only says which wallet to restore; it
    never grants entry.
- **One network at a time:** `NetworkBoundary` mounts Solana providers only for
  Solana.
  - **Wrong-network URLs:** they redirect to the connected network's default page.
  - **Switching:** clears the visible session, disconnects the old wallet, then
    asks the new one for approval.
  - **Late responses:** they're discarded once the account changes.
- **Not access control:** the boundary stops accidental cross-network reads. The
  contracts still enforce every permission.

### Canton wallets (CIP-0103)

All Canton wallet traffic uses the
[CIP-0103](https://github.com/canton-foundation/cips/blob/main/cip-0103/cip-0103.md)
dApp Standard provider (`request`, `on`, `removeListener`).

| Need | Call |
| --- | --- |
| Connect | `connect`, `disconnect` |
| Identity | `status`, `getPrimaryAccount`, `getActiveNetwork` (CAIP-2) |
| Changes | `accountsChanged`, `statusChanged` |
| Reads | `ledgerApi` → JSON Ledger API `/v2/state/*` |
| Submit | `prepareExecute`, then `txChanged` events |

- **Wallets:**
  - **Loop:** `@fivenorth/loop-sdk` has a native provider.
  - **Console:** `lib/console-wallet.ts` adapts the Console SDK to the same
    provider. Unknown methods fail with 4200.
- **Submission** (`lib/canton/cip103.ts`, `executePrepared`):
  - **Order:** subscribes to `txChanged` before calling `prepareExecute`.
  - **Success:** waits for `executed` with the same command ID and an update ID.
  - **Failure:** `failed`, a provider error or 3 minutes of silence rejects.
  - **No retries:** a late transaction may still execute.
- **Errors:** the standard codes (4001, 4100, 4200, 4900/4901,
  −32700…−32005) get clear messages.
- **Network:** `NEXT_PUBLIC_CANTON_NETWORK_ID=canton:testnet` must match the
  active network and the account's network. Solana stays on devnet.
- **Keys:** signing stays in the wallet. Console's ledger token never leaves its
  adapter.

### Canton trading

- **Features:** discovery, orders, balances, split/merge, operator matching
  (including **Match YES + NO**), resolution, redemption and clearing orders of
  departed members.
- **Reads:**
  - **Public:** `/api/canton/catalog` reads public market contracts and book
    quotes as a fixed operator party.
  - **Private:** private contracts are read through the connected wallet's own
    party.
- **Commands:** they come from a fixed action → template → choice map, so forms
  can't pick a recipient, `actAs` or package.
- **Deposits:** they select at most 15 unlocked HoldingV2 inputs. Registry
  prerequisites come from `CANTON_REGISTRY_CONTEXT_URL`, a read-only adapter that
  must return the real `ExtraArgs` and disclosures. A mock provider is used in
  tests.
- **Gate:** `CANTON_TRADING_ENABLED` stays `false` until the DAR is deployed and a
  live wallet smoke test passes. The server variables are in `app/.env.example`.

**Resolution differs by network.** Each market's Rules tab explains its own
network's rules (`components/resolution-policy.tsx`, with the text in
`lib/resolution-policy.ts`). Keep it in sync with `resolution.rs` and
`Resolution.daml`.

| Case | Solana | Canton |
| --- | --- | --- |
| Corrections | Restart the delay; stop two delays after the window opens | Restart the delay, until the review ends |
| Fallback vs. a timely primary proposal | Can't replace it | Can correct it after handover |
| Fallback deadline, no proposal | Anyone finalizes Invalid | Stays unresolved |
| Who finalizes | Anyone | The operator |

## Design system

- **Where it lives:** tokens are in `app/app/theme.css` and primitives in
  `app/app/design.css`. The live reference is the `/design` route.
- **Principles:**
  1. **Dark first:** cobalt is the only brand colour, used as light (glow, focus,
     primary action). A light theme mirrors every token.
  2. **Structure, not boxes:** group with spacing, type and hairlines. Raise only
     surfaces you act on (ticket, dialogs, forms).
  3. **Numbers are the interface:** mono tabular figures. YES is mint and NO is
     rose, and both always carry a text label.
  4. **Motion explains:** 120–420 ms, ease-out, never blocks input, and is removed
     under `prefers-reduced-motion`.
  5. **Little text:** one headline and one supporting line. Mechanics go in help
     dialogs.

| Token | Dark | Light |
| --- | --- | --- |
| `--bg` | `#070A12` | `#F5F7FC` |
| `--surface-1` / `-0` / `-2` | `#0E1422` / `#0A0F1A` / `#151D30` | `#FFFFFF` / `#EDF1F9` / `#F8FAFE` |
| `--ink` / `--muted` | `#EEF2FF` / `#A0ABC8` | `#0D1326` / `#4D5A75` |
| `--accent` | `#8FA8FF` | `#2B4FD8` |
| `--yes` / `--no` | `#6FE3BC` / `#FF8FAB` | `#07704F` / `#B0305A` |
| `--warn` | `#F2CB76` | `#7A5508` |

- **Type:** Geist and Geist Mono, from `--text-display` down to `--text-micro`.
- **Space:** a 4 px grid (`--space-1` to `--space-10`).
- **Radius:** 8, 12, 20 and pill.
- **Old token names:** older names (`--panel`, `--buy`, ...) stay as aliases.
- **Contrast:** `npm run test:theme` checks every text and surface pair for WCAG
  AA. That check is not a full accessibility audit.

**Primitives:** `.ui-page`, `.ui-page-head`, `.ui-section`, `.ui-grid` /
`.ui-split` (primary column plus a 360 px aside), `.ui-card`, `.ui-list` /
`.ui-row`, `.ui-dl`, `.ui-btn` (`-primary`, `-ghost`, `-yes`, `-no`, `-sm`),
`.ui-field` / `.ui-input` / `.ui-select`, `.ui-badge`, `.ui-tabs`, `.ui-stat`,
`.ui-empty` and `.ui-num`.

**Rules:**
- **One primary action** per view.
- **Size:** inputs and buttons are at least 44 px tall (the trade button is 48 px).
- **Focus:** a 2 px accent ring.
- **Keyboard:** everything works by keyboard, and colour is never the only signal.
- **Borders:** a border must separate content or contain an action.
- **No fake data:** never show example prices. A failed or loading read must not
  look like a zero balance or an empty book.

## Market pages

- **Layout:** the question is the page title. The header shows the state, close
  time and payout.
- **Sections:** Trade, Your position, and Rules & outcome. Manage market appears
  only for the creator or resolver.
  - **Trade:** the ticket is the only raised panel. The book sits beside it on
    desktop and below it on mobile.
- **Ownership of RPC and signing:**
  - **Presentational:** `app/components/prediction/*` has no RPC or signing.
  - **Operations:** `shared-market.tsx` and `prediction-settlement.tsx` own them.
  - **Navigation:** `prediction-detail-layout.tsx` owns navigation and admin
    visibility.
- **Tabs:** a visited tab stays mounted, so typed amounts and confirmations
  survive. Wallet or network changes reset state.
- **Spot:** `spot-trade-workspace.tsx` formats and groups the book with exact BN
  arithmetic. Legacy per-market controls live in a recovery disclosure.

## Themes and languages

- **Display settings:** in the header, with the theme (Light by default, Dark,
  System) and the language.
- **Cookies:** cookies seed the server render, so preferences don't flash during
  hydration.
- **Catalogs:** English, Hindi, Spanish, French and Portuguese in
  `app/i18n/messages/`.
  - **Usage:** `useI18n().t()` with named placeholders.
  - **Check:** keys must match across catalogs (`npm run test:i18n`).
- **Never translated:** creator-written questions, evidence, rules, symbols,
  addresses, enum keys and RPC diagnostics. Amounts stay exact decimal strings,
  and dates are in UTC.

## Rename from Tidebook

- **Names:** the project was renamed to Outcomia (crate `outcomia`,
  `outcomia-indexer`, `outcomia-app`).
- **Unchanged on chain:** the program address, seeds, discriminators and error
  codes.
- **Compatibility fallbacks:**
  - **Program ID:** `NEXT_PUBLIC_TIDEBOOK_PROGRAM_ID` / `TIDEBOOK_PROGRAM_ID` are
    read after the Outcomia names.
  - **Cookies:** `tidebook_*` cookies are still read.
  - **Faucet:** Redis faucet keys keep their old namespace, so quotas don't reset.
  - **Database:** old Compose setups add `-f services/indexer/compose.legacy.yaml`
    to reuse the old database and volume.
- **Evidence:** recorded evidence (`docs/devnet/*.json`, Arweave documents) keeps
  its original names.
- **Keypair:** `target/deploy/outcomia-keypair.json` must match the existing
  program ID. Never generate a new one.

## Checks

`npm --prefix app run` with `typecheck`, `test:prediction`, `test:shared`,
`test:wallet`, `test:rpc-proxy`, `test:canton`, `test:i18n`, `test:theme` and
`build`.
- **Browser fixtures:** `app/scripts/*-browser.test.mjs` refuse non-local origins
  and need `PLAYWRIGHT_MODULE` and a Chromium path.
- **Dependency audit:** the npm audit still lists transitive findings, which need
  a separate review.
