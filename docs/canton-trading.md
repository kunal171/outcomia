# Canton binary trading UI

The shared app contains Canton discovery, order placement/cancellation, balances,
complete-set split/merge, operator matching, resolution and owner redemption.
No separate frontend or app-held signing key is used.

This feature is verified locally. It does not deploy the DAR, configure public
participants, enable Vercel transactions or perform a live wallet smoke test.
Keep `CANTON_TRADING_ENABLED=false` until those checks pass.

## Data and wallet boundaries

- `/api/canton/catalog` reads a fixed operator party from the configured JSON
  Ledger API. It returns public market/root contracts and normalized book quotes.
  Private balances, positions and full signed orders are not returned.
- Private active contracts are read through the connected wallet, using only its
  verified party. The operator's own wallet can read operator-observed orders and
  accounts to match them; another trader cannot request that identity.
- Commands are compiled from a fixed action/template/choice map. Forms cannot
  choose an arbitrary recipient, factory, `actAs`, `readAs` or package.
- Loop uses its CIP-0103 bridge. Console uses its SDK. Deposit input selection
  reads unlocked Token Standard HoldingV2 interface views for the wallet owner,
  matching the exact instrument administrator and ID. It selects at most 15
  inputs, leaving room for an existing canonical balance holding.
- Console's ledger-auth token remains transient inside the SDK adapter. It never
  enters React state, cookies, browser storage, logs or an app API request.
- Identity is rechecked before and after wallet reads/submission. Changing the
  party, wallet or network unmounts old financial views and discards late reads.

Only an executed wallet receipt with the matching command ID and an update ID
is shown as confirmed. No transaction is automatically retried. A confirmed
command may reach the public read participant later; controls remain blocked
while its consumed target still appears. Refresh synchronizes the view without
resubmitting the command.

## Deployment configuration

Server-only variables are listed in `app/.env.example`:

| Variable | Purpose |
| --- | --- |
| `CANTON_PACKAGE_ID` | Exact deployed main package hash |
| `CANTON_OPERATOR_PARTY`, `CANTON_VAULT_PARTY` | Distinct configured signers |
| `CANTON_PROTOCOL_NAME` | Pinned protocol namespace |
| `CANTON_SYNCHRONIZER_ID` | Submission synchronizer |
| `CANTON_JSON_API_URL` | Fixed HTTPS participant endpoint |
| `CANTON_CATALOG_TOKEN` | Read-only operator-scoped discovery credential |
| `CANTON_REGISTRY_CONTEXT_URL` | Fixed read-only registry context provider |
| `CANTON_REGISTRY_CONTEXT_TOKEN` | Optional provider credential |
| `CANTON_TRADING_ENABLED` | Defaults to false |

`NEXT_PUBLIC_CANTON_NETWORK_ID` remains the browser's expected network. The
catalog must match it. Never put a signing key or server credential in a public
variable. Missing configuration shows a deployment notice rather than invented
markets. Ambiguous protocol/vault/position/order roots and incomplete books fail
closed. Pin the intended root lineage during deployment; the jointly signing
operator/vault remain trusted to bootstrap it correctly.

The read participant must observe every configured root and public market
contract, and every order referenced in the book at the same ledger offset.
Trader wallets obtain private disclosures through their own authenticated reads.
All required contracts must be available on the submission synchronizer. These
visibility/hosting requirements need a real deployment check.

## Registry context adapter

Token registries supply their own current transfer prerequisites. The app does
not invent an empty context or assume that a funded Loop Canton Coin wallet
provides a compatible admitted factory.

The configured provider accepts a POST JSON object:

```json
{
  "party": "connected-party",
  "network": "canton:testnet",
  "action": "deposit",
  "instrument": { "admin": "issuer-party", "id": "USD" },
  "contractIds": ["current-balance", "current-policy", "admission"],
  "command": { "ExerciseCommand": { "templateId": "package:module:Template", "contractId": "current-balance", "choice": "AssetBalance_Deposit", "choiceArgument": {} } }
}
```

The illustration omits real choice arguments. Actual requests include the typed
command, amount, selected wallet inputs and dependency IDs. The provider returns:

```json
{
  "party": "connected-party",
  "network": "canton:testnet",
  "instrument": { "admin": "issuer-party", "id": "USD" },
  "extraArgs": { "context": { "values": [] }, "meta": { "values": {} } },
  "disclosedContracts": []
}
```

The example shape is not a usable context. Supply the actual registry-required
`ExtraArgs` and authentic created-event disclosures, including synchronizer IDs
when required. Context must support every nested transfer in the command, not
just the initial deposit. The adapter checks the returned party, network and
instrument and does not sign or execute anything.

This endpoint must expose only public registry prerequisites. The caller's party
is a claim for preparing a transaction, not proof of authentication. Never use
this service credential to return private holdings or balances for that party.
Deposit holdings are selected separately by the authenticated wallet. Choosing
and configuring a compatible real registry/context provider remains deployment
integration work; local tests use a mock provider.

## User flow

Creators create a draft, initialize its reserve, initialize its book, then open
it. Creator administrative controls require active admin status; operator controls
are separate. Traders initialize one balance per asset, deposit, create pairs or
buy contracts, sell owned contracts and cancel orders. Matching currently requires
one operator command per best-price/FIFO fill; it is not an automatic crankless
execution service.

The resolver proposes a result with evidence. Corrections restart the agreed
review period. After operator finalization, **Prepare claims** binds the final
snapshot to the reserve. Owners claim available lots in batches of at most 16;
losing lots can be cleared for zero payout. YES/NO winners pay one collateral
per winning contract; Invalid pays half per YES or NO. A claim credits the
Outcomia balance; withdrawal sends tokens to the wallet. Cancel outstanding sell
orders first to release their escrowed contracts for redemption. Orders can be
canceled after cutoff, closure or resolution.

Amounts stay exact Decimal/Int64 strings. Buy quotes include the maximum funded
fee budget; actual fill fees follow the signed order's policy snapshot. Creator
rules, instrument IDs, party IDs and diagnostics are not translated. Interface
labels support English, Hindi, Spanish, French and Portuguese.

## Local checks

`npm --prefix app run test:canton` checks session/display boundaries, exact quotes,
command construction, registry context binding, private holding selection and
wallet receipt/identity failures. Other existing app suites and the production
build are also required. Local browser fixtures checked discovery, detail quotes,
rules/admin controls, cancellation plus refresh, positions and mobile layout
without contacting a public ledger or approving a real wallet transaction.

The repeatable browser fixture is `app/scripts/canton-browser.test.mjs`. Start an
isolated local app server first, then run it with an installed Playwright module
and Chromium executable:

```bash
# Terminal 1, from app/
OUTCOMIA_BUILD_DIR=target/canton-browser-check npm run dev -- --webpack --hostname 127.0.0.1 --port 3016
# Terminal 2, from the repository root; replace these tool paths
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
CANTON_BROWSER_EXECUTABLE=/path/to/chromium \
node app/scripts/canton-browser.test.mjs
```

The script refuses non-local origins and blocks all external browser requests.
It also checks claim submission and refreshed positions, revoked-asset account
visibility and disabled zero-balance withdrawals. Screenshots go to ignored
`target/canton-browser-artifacts`. Existing deposited accounts remain visible
when admission is revoked; only new deposits are disabled.
