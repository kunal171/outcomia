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
