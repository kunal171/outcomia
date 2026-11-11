# One UI, two networks

The frontend lives in `kunal171/outcomia`, in `app/`. The
[`outcomia-canton`](https://github.com/kunal171/outcomia-canton) repository owns
Canton contracts and services. It does not host a second frontend.

Connect a wallet on the landing page:

- A Solana wallet opens `/predictions`. Existing spot, wallet and order pages
  remain available on Solana.
- Console Wallet opens `/canton/markets`, with separate positions, orders and
  wallet routes. Canton spot is outside the current scope.

Both use the existing Outcomia layout, colors, display settings and translations.

## Connection boundary

`NetworkWalletProvider` selects the workspace from a live wallet connection.
Session storage remembers which wallet to restore; it cannot grant entry.
Solana connections require a connected adapter and public key. Canton connections
require an allocated primary party and consistent configured network responses.

`NetworkBoundary` mounts `ProtocolRoleProvider` and Solana pages only for Solana.
Opening a URL for the other network redirects to the connected network's default
page. Without a connection, it returns to the landing page. Switching first
clears the visible session, disconnects the old wallet, then requests approval
from the new one. Account changes invalidate the Canton session while rechecking;
late responses cannot restore the old party. Closing a Solana workspace aborts
its HTTP transport, including paced requests that have not reached the RPC yet.

This boundary prevents accidental cross-network UI reads. It is not backend
access control. Contracts must enforce trading permissions, collateral ownership
and settlement rights independently.

## Configuration and verification

Set `NEXT_PUBLIC_CANTON_NETWORK_ID=canton:devnet` in the shared app's environment.
Only the public network identifier is configured here; signing stays in the
wallet. Existing Solana and server RPC environment settings stay in this app.

Run `npm run test:canton` for session validation and the existing app checks in
[the app README](../app/README.md). Browser verification must cover both wallet
paths, switching, rejection, wrong-network responses, restore and disconnect.
A mocked extension proves application behavior; a real Console Wallet approval
on the presentation machine still needs a separate smoke check. No Canton market
submission or settlement is implemented by the gateway.

## Canton workspace

The `/canton` layout reuses Outcomia's palette, brand, languages and wallet picker.
Its sidebar collapses on desktop and becomes a row of links on mobile. No Solana
role/account providers mount inside it. The shared brand component has no chain
reader dependency.

- `/canton/markets`: deployment status and the future prediction-market list.
- `/canton/positions`: unavailable until deployed position data can be read.
- `/canton/orders`: unavailable until deployed order data can be read.
- `/canton/wallet`: read-only assets from Console Wallet, with exact amounts,
  token IDs, refresh, an empty-asset filter and a copyable party ID.

The wallet reader calls SDK 3.0.0's `getBalance` for the verified party/network.
It rechecks the live session before and after the request. Account changes
unmount financial children; late responses are ignored. Responses with duplicate
asset IDs, invalid amounts or a different network fail closed. Amounts stay
decimal strings and use BigInt for locale grouping, without rounding balances.
These are wallet-reported assets, not proof of approved collateral or deposits.

Workspace verification used a mocked extension: all four routes, exact large
balances, zero-asset filtering, errors, wrong-network assets, delayed responses
after party changes, local buy/sell previews, sidebar collapse, 320–1440 px
layouts, five languages and light/dark themes passed. The existing two-wallet
switching regression also passed. No signatures, live balance reads or Canton
transactions were submitted during these checks.

Market, position and order data show **unavailable**, rather than zero or an empty
account. The Daml contracts are locally tested in `outcomia-canton`, but public
deployment, read/disclosure services and wallet submission are not verified.
Deposits, withdrawals, split/merge, placement, cancellation, admin actions and
claims are therefore not enabled in this UI. No public toggle bypasses that gate.

The optional order-preview dialog is a local calculator. It explains buy cash
escrow, sell contract escrow and complete-set merge/cancellation. Its exact
Decimal/Int arithmetic matches current contract number bounds; it does not know
a market's tick, lot, fees or available balance. It cannot sign or submit orders.

## Checks for this integration

The local browser fixture passed both wallet paths, bidirectional switching,
same-wallet reconnection, reloads, party changes with stale responses, rejected
approval, wrong-network and absent-extension errors, disconnect/revocation and
wrong-chain URLs. Landing layouts were checked at 320, 390, 768 and 1440 px.
Solana RPC reads were blocked while using Canton. Wallet extensions and RPC
accounts were mocked; no signatures or transactions were submitted.

Existing prediction and spot browser checks also passed: claims, review delay,
cutoff during wallet approval, cancellation after close, price selection, retained
form values, exact amounts and zero-free withdrawal guards. The TypeScript check,
production build, session tests, and existing prediction/wallet/shared/RPC/theme/
translation suites passed. Local fixtures and screenshots remain in ignored
`target/ui-checks/`, following the existing UI verification setup.

The dependency audit is not clean. On 2026-11-11, the master lockfile reported
53 findings and this integration reported 50 after compatible updates. Next.js
is updated to 16.4.6. Remaining transitive findings need a separate dependency
review; no forced major downgrades were applied to the financial client.
