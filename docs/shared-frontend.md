# One UI, two networks

The frontend lives in `kunal171/outcomia`, in `app/`. The
[`outcomia-canton`](https://github.com/kunal171/outcomia-canton) repository owns
Canton contracts and services. It does not host a second frontend.

Connect a wallet on the landing page:

- A Solana wallet opens `/predictions`. Existing spot, wallet and order pages
  remain available on Solana.
- Console Wallet opens `/canton/markets`. This workspace shows the verified
  primary party and network. Markets remain unavailable until Canton contracts
  are implemented and deployed. Canton spot is outside the current scope.

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
