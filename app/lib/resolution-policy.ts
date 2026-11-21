/** How each chain's binary markets resolve. The two programs differ, and both
 * appear in the same app, so each market states its own chain's rules.
 * Sources: Solana `resolution.rs`; Canton `Resolution.daml` and
 * docs/binary-resolution.md in outcomia-canton. */
export const RESOLUTION_RULES = {
  solana: [
    "The creator proposes after trading closes. Each correction restarts the review delay; corrections stop two review delays after the resolver's window opens.",
    "A fallback resolver can propose only if no timely proposal exists, and cannot replace one.",
    "If a configured fallback deadline passes with no proposal, anyone can finalize the market as Invalid.",
    "Anyone can finalize a proposal once its review delay ends.",
  ],
  canton: [
    "The creator proposes after trading closes. Each correction restarts the review delay, until the review ends.",
    "After handover, the fallback resolver can correct a pending primary proposal.",
    "If the fallback deadline passes with no proposal, the market stays unresolved.",
    "Only the operator can finalize a proposal once its review delay ends.",
  ],
} as const;
