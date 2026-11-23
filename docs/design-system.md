# Outcomia design system

One design language for the landing page and every app route, on both Solana
and Canton. Tokens live in `app/app/theme.css`; primitives in
`app/app/design.css`; the live reference is the `/design` route.

## Principles

1. **Dark first, cobalt light.** Deep ink surfaces; cobalt is the only brand
   color and appears as light (glows, focus, primary actions), not as fills
   everywhere. A light theme mirrors every token.
2. **Structure, not boxes.** Group with spacing, type and hairline dividers.
   A raised surface is reserved for things you act on (ticket, dialogs, forms).
   Lists are rows; details are definition lists; pages have a clear header,
   a primary column and an optional aside.
3. **Numbers are the interface.** Prices, sizes and balances use the mono face
   with tabular figures. YES is mint, NO is rose, and both always carry a text
   label.
4. **Motion explains.** Things enter, prices tick, focus moves. Motion is short
   (120–400ms), eases out, never blocks input, and is removed under
   `prefers-reduced-motion`.
5. **Little text.** One headline, one supporting line. Mechanics live in help
   dialogs and docs, never in taglines.

## Tokens

All colors are CSS custom properties defined for dark (`:root`), light
(`[data-theme="light"]`) and system mode. Legacy names (`--panel`,
`--surface-inset`, `--buy`, `--sell`, `--coral`, …) remain as aliases so older
styles adopt the palette while pages migrate.

| Role | Token | Dark | Light |
| --- | --- | --- | --- |
| Page | `--bg` | `#070A12` | `#F5F7FC` |
| Surface | `--surface-1` | `#0E1422` | `#FFFFFF` |
| Inset / input | `--surface-0` | `#0A0F1A` | `#EDF1F9` |
| Raised (hover, menus) | `--surface-2` | `#151D30` | `#F8FAFE` |
| Text | `--ink` | `#EEF2FF` | `#0D1326` |
| Secondary text | `--muted` | `#A0ABC8` | `#4D5A75` |
| Hairline | `--line` | ink 10% | ink 12% |
| Strong line | `--line-strong` | ink 20% | ink 22% |
| Brand / action | `--accent` | `#8FA8FF` | `#2B4FD8` |
| Text on accent | `--accent-ink` | `#0A0F1E` | `#FFFFFF` |
| YES / buy | `--yes` | `#6FE3BC` | `#07704F` |
| NO / sell | `--no` | `#FF8FAB` | `#B0305A` |
| Warning | `--warn` | `#F2CB76` | `#7A5508` |

Every text/surface pair is checked for WCAG AA (4.5:1) by `npm run test:theme`.

**Type.** Geist for interface and display, Geist Mono for numbers, addresses
and code (loaded with `next/font`, exposed as `--font-sans` / `--font-mono`).

| Step | Size | Use |
| --- | --- | --- |
| `--text-display` | clamp(48px, 8vw, 112px), -0.05em | Landing headline |
| `--text-h1` | clamp(30px, 4vw, 44px), -0.035em | Page title |
| `--text-h2` | 22px, -0.02em | Section title |
| `--text-h3` | 17px | Group title |
| `--text-body` | 15px / 1.55 | Body |
| `--text-small` | 13px | Labels, meta |
| `--text-micro` | 11px, uppercase, +0.08em | Eyebrows, table heads |

**Space.** 4px grid: `--space-1` 4 · `2` 8 · `3` 12 · `4` 16 · `5` 24 ·
`6` 32 · `7` 48 · `8` 64 · `9` 96 · `10` 128.

**Radius.** `--radius-sm` 8 (inputs, chips) · `--radius-md` 12 (buttons,
rows) · `--radius-lg` 20 (cards, dialogs) · `--radius-pill` 999.

**Elevation.** Surfaces are separated by tone first, then a hairline, then
shadow: `--shadow-1` (menus), `--shadow-2` (dialogs). A cobalt `--glow` is
used only on the primary action and focused trading surfaces.

**Motion.** `--ease-out: cubic-bezier(.2,.8,.2,1)`; `--dur-fast` 120ms
(hover, press), `--dur-base` 220ms (state), `--dur-slow` 420ms (enter). Scroll
reveals use `IntersectionObserver` and `data-reveal`; no animation library.

## Primitives (`design.css`)

| Class | Purpose |
| --- | --- |
| `.ui-page` | Page frame: max width 1200px, 16px gutters on mobile |
| `.ui-page-head` | Eyebrow, title, one-line lead, actions on the right |
| `.ui-section` | Vertical rhythm between page sections, optional title row |
| `.ui-grid` / `.ui-split` | Responsive columns; split = primary + 360px aside |
| `.ui-card` | Raised surface for actionable groups (ticket, form, dialog) |
| `.ui-list` / `.ui-row` | Flat rows with hairline separators and hover tone |
| `.ui-dl` | Definition list for details |
| `.ui-btn` (`-primary`, `-ghost`, `-yes`, `-no`, `-sm`) | Buttons, 44px min height |
| `.ui-field`, `.ui-input`, `.ui-select` | Labeled inputs, 44px min height |
| `.ui-badge` (`-yes`, `-no`, `-warn`, `-accent`) | Status chips |
| `.ui-tabs` | Segmented navigation |
| `.ui-stat` | Label + mono value |
| `.ui-empty` | Empty and unavailable states |
| `.ui-num` | Mono tabular figures |

## Page anatomy

```
┌ App shell: brand · primary nav · network · wallet · settings ┐
│ ui-page-head   eyebrow / title / lead              actions  │
│ ui-split  ┌ primary column ───────────┐ ┌ aside (sticky) ┐   │
│           │ sections: rows, dl, tabs  │ │ ui-card ticket │   │
│           └───────────────────────────┘ └────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

Mobile: one column, actionable card first, nav collapses to a bottom bar.

## Rules

- No boxes around everything: a border must separate or contain an action.
- One primary action per view.
- Never show example prices or zeroes for failed reads (see `ui-design.md`).
- Inputs and buttons are at least 44px tall; focus is a 2px accent ring.
- Every interactive element works by keyboard; color is never the only signal.
