# Prediction detail UI

The question is the page title. Trade, positions, rules and administration are
separate sections. Keep this structure when adding features.

## Layout

- Use spacing and dividers to group information. A border needs a purpose.
- The trading ticket is the only raised panel in the trading section.
- Show the order book beside the ticket on desktop. Put the ticket first on mobile.
- Keep positions and rules flat: rows, tables and disclosures.
- Use a 4px spacing scale: 8, 12, 16, 24, 32 and 48px.
- Use the existing font and palette. YES/buy is teal; NO/sell is coral.
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
