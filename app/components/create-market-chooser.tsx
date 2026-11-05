import Link from "next/link";
import { AppHeader } from "./app-header";

/** Selection navigates only; each form enforces its own role and rollout checks. */
export function CreateMarketChooser() {
  return (
    <div className="app-shell">
      <AppHeader />
      <main className="route-shell route-shell-narrow">
        <div className="route-heading">
          <div className="eyebrow">Create a market</div>
          <h1>What kind of market?</h1>
          <p>
            Choose a type to get started. An active administrator wallet is
            required to create either market.
          </p>
        </div>
        <nav className="market-type-choices" aria-label="Choose a market type">
          <Link
            className="market-type-choice market-type-spot"
            href="/markets/new/spot"
          >
            <span className="market-type-icon" aria-hidden="true">
              ↗
            </span>
            <h2>Spot market</h2>
            <p>Trade a pair of SPL tokens, such as SOL / USDC.</p>
            <span className="market-type-action">
              Set up spot market <span aria-hidden="true">→</span>
            </span>
          </Link>
          <Link
            className="market-type-choice market-type-prediction"
            href="/predictions/new"
          >
            <span className="market-type-icon" aria-hidden="true">
              ◈
            </span>
            <h2>Prediction market</h2>
            <p>
              Set a question with YES / NO outcomes and one collateral token.
            </p>
            <small>In development · deployment required</small>
            <span className="market-type-action">
              Set up prediction market <span aria-hidden="true">→</span>
            </span>
          </Link>
        </nav>
      </main>
    </div>
  );
}
