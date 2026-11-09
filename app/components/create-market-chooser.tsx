"use client";
import { useI18n } from "./preferences-provider";
import Link from "next/link";
import { AppHeader } from "./app-header";

/** Selection navigates only; each form enforces its own role and rollout checks. */
export function CreateMarketChooser() {
  const { t } = useI18n();

  return (
    <div className="app-shell">
      <AppHeader />
      <main className="route-shell route-shell-narrow">
        <div className="route-heading">
          <h1>{t("What kind of market?")}</h1>
        </div>
        <nav
          className="market-type-choices"
          aria-label={t("Choose a market type")}
        >
          <Link
            className="market-type-choice market-type-spot"
            href="/markets/new/spot"
          >
            <span className="market-type-icon" aria-hidden="true">
              ↗
            </span>
            <h2>{t("Spot market")}</h2>
            <p>{t("Trade a pair of SPL tokens, such as SOL / USDC.")}</p>
            <span className="market-type-action">
              {t("Set up spot market")} <span aria-hidden="true">→</span>
            </span>
          </Link>
          <Link
            className="market-type-choice market-type-prediction"
            href="/predictions/new"
          >
            <span className="market-type-icon" aria-hidden="true">
              ◈
            </span>
            <h2>{t("Prediction market")}</h2>
            <p>
              {t(
                "Set a question with YES / NO outcomes and one collateral token.",
              )}
            </p>

            <span className="market-type-action">
              {t("Set up prediction market")} <span aria-hidden="true">→</span>
            </span>
          </Link>
        </nav>
      </main>
    </div>
  );
}
