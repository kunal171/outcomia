# UI design

The question is the page title. Trade, positions, rules and administration are
separate sections. Keep this structure when adding features.

## Layout

- Use spacing and dividers to group information. A border needs a purpose.
- The trading ticket is the only raised panel in the trading section.
- Show the order book beside the ticket on desktop. Put the ticket first on mobile.
- Keep positions and rules flat: rows, tables and disclosures.
- Use a 4px spacing scale: 8, 12, 16, 24, 32 and 48px.
- Use the shared palette. YES/buy is teal; NO/sell is berry.
  Neutral actions use muted text. Color always has a text label as well.
- Keep inputs at least 44px high and the trade button 48px high.
- Preserve keyboard navigation, focus indicators and reduced-motion support.

## Content

Show the question, state, closing time and winning payout in the header.
Labels explain inputs; the help dialog explains mechanics. Avoid taglines and
repeated descriptions. Keep fees, payout conditions, missing-data errors and
resolution risks explicit.

Use actual orders for the book. Never fill an empty state with example prices.
A loading or failed read must not appear as a zero balance or an empty book.

## Code

`app/components/prediction/` contains the overview, ticket, book, position actions,
rules and resolution summary. These components do not read RPC or sign transactions.
`shared-market.tsx` and `prediction-settlement.tsx` own those operations.
`prediction-detail-layout.tsx` owns navigation and admin visibility.
`app/app/prediction-detail.css` owns the page styles.

A visited tab stays mounted so an entered amount or transaction confirmation
survives navigation and refresh. Passing the trading deadline hides entry controls
but keeps a pending result visible. Wallet/network changes reset the relevant state.
Cancellation remains available after trading closes. Claiming uses only free
contracts; contracts in sell orders must be canceled first.

## Themes and languages

Display settings in the header contain appearance and language controls.
Light mode uses soft-white surfaces, ink text and cobalt accents. Dark mode
uses navy surfaces and pale-blue accents. The landing feature area uses cobalt
with white headings and a dark primary action, following the supplied reference. Every page, wallet menu
and help dialog uses the tokens in `app/app/theme.css`.

New visitors start in Light mode. System mode follows the device color preference. Validated cookies seed the
server render, so a saved language or theme does not change during hydration.
Changing either preference keeps the wallet provider and entered amounts mounted.
Cookies last one year and apply to all routes.

English, Hindi, Spanish, French and Portuguese catalogs live in
`app/i18n/messages/`. Use `useI18n().t()` for interface text and named placeholders
for values. Keep every catalog's keys and placeholders aligned. Translation
checks run with `npm run test:i18n --prefix app`.

Do not translate creator-written questions, evidence, published rule documents,
token symbols, addresses, transaction arguments or enum keys. YES and NO remain
contract identifiers. Unknown RPC and wallet diagnostics are shown verbatim.
Amounts retain exact decimal strings; dates show UTC, with translated month
names and review periods. No translation service receives wallet or market data.

The palette follows [Radix's semantic color guidance](https://www.radix-ui.com/colors).
`test:theme` measures the defined text/action color pairs against the
[WCAG text contrast threshold](https://www.w3.org/TR/WCAG22/#contrast-minimum).
It does not establish full accessibility compliance for every rendered state.

## Spot market detail

Spot uses the metadata market name as its title. The shared order book and
controlled trade form sit side by side on desktop; the form comes first on
mobile. `spot-trade-workspace.tsx` formats the snapshot and groups remaining
open orders at the same price using exact BN arithmetic. It does not fetch
accounts, build instructions or sign transactions.

`shared-market.tsx` owns reads, matching and confirmation. Refresh retains the
entered price and quantity. A failed read disables entry and shows unavailable
book data, rather than empty liquidity. Cancellation has no trading-status gate.

Deposit/withdraw controls mount on the first opening of their disclosure and
stay mounted after closing it. Market details are collapsed for the shared path;
legacy precision, prices and fee accounts remain labeled separately. Authority
pause/unpause/closure controls remain outside that disclosure.

The older per-market book, deposits and treasury controls are inside a separate
recovery disclosure. Public test-token claims stay outside it; admin faucet setup
is a separate disclosure. This groups the
legacy controls; the parent market component still performs its legacy reads.
