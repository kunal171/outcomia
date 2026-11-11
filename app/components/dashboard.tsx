"use client";
import { PREDICTION_RESOLUTION_ENABLED } from "../lib/shared";
import { useI18n } from "./preferences-provider";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { NetworkHeader } from "./network-workspace";
import {
  SharedWalletButton,
  useNetworkWallet,
} from "./network-wallet-provider";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";

/** Decorative order flow, not live prices or a simulated trading result. */
function OrderFlow() {
  const { t } = useI18n();

  return (
    <div
      className="landing-flow"
      role="img"
      aria-label={t(
        "Illustration of buy and sell orders for a YES contract meeting",
      )}
    >
      <div className="flow-orbit flow-orbit-outer" aria-hidden="true" />
      <div className="flow-orbit flow-orbit-inner" aria-hidden="true" />
      <svg
        className="flow-paths"
        viewBox="0 0 560 440"
        fill="none"
        aria-hidden="true"
      >
        <defs>
          <linearGradient
            id="flow-sell"
            x1="110"
            y1="80"
            x2="280"
            y2="220"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="var(--sell)" />
            <stop offset="1" stopColor="var(--accent)" />
          </linearGradient>
          <linearGradient
            id="flow-buy"
            x1="450"
            y1="360"
            x2="280"
            y2="220"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="var(--buy)" />
            <stop offset="1" stopColor="var(--accent)" />
          </linearGradient>
        </defs>
        <path
          className="flow-track"
          d="M110 110H180Q220 110 220 150V170Q220 220 280 220"
          stroke="url(#flow-sell)"
        />
        <path
          className="flow-track"
          d="M450 330H380Q340 330 340 290V270Q340 220 280 220"
          stroke="url(#flow-buy)"
        />
        <path
          className="flow-trail"
          d="M110 110H180Q220 110 220 150V170Q220 220 280 220"
          stroke="url(#flow-sell)"
        />
        <path
          className="flow-trail flow-trail-buy"
          d="M450 330H380Q340 330 340 290V270Q340 220 280 220"
          stroke="url(#flow-buy)"
        />
      </svg>
      <div className="flow-order flow-order-sell" aria-hidden="true">
        <span>
          {t("Sell YES")} <i>↘</i>
        </span>
        <div>
          <b />
          <b />
          <b />
        </div>
      </div>
      <div className="flow-center" aria-hidden="true">
        <span>⇄</span>
      </div>
      <div className="flow-order flow-order-buy" aria-hidden="true">
        <span>
          {t("Buy YES")} <i>↗</i>
        </span>
        <div>
          <b />
          <b />
          <b />
        </div>
      </div>
    </div>
  );
}

// Fictional market drafts for the landing demo, not listed markets or forecasts.
const PREDICTION_EXAMPLES = [
  {
    category: "Space",
    icon: "↗",
    question: "Will the same rocket booster launch twice in 24 hours?",
    criteria: "Two orbital launches · same booster · by 31 Dec 2027",
    evidence: "Operator flight records & launch timestamps",
    yes: "0.60",
    no: "0.40",
    cost: "6",
  },
  {
    category: "Energy",
    icon: "☀",
    question: "Will solar supply half of Spain’s electricity for a full day?",
    criteria: "24-hour generation share ≥ 50% · by 31 Dec 2027",
    evidence: "National grid operator’s generation data",
    yes: "0.35",
    no: "0.65",
    cost: "3.50",
  },
  {
    category: "Gaming",
    icon: "⚑",
    question: "Will a Super Mario Bros. speedrun break 4 minutes 54 seconds?",
    criteria: "Original game · human any% run · by 31 Dec 2027",
    evidence: "Verified leaderboard entry & run recording",
    yes: "0.55",
    no: "0.45",
    cost: "5.50",
  },
] as const;

/** Scroll changes only this illustration. Prices are examples, never fetched quotes. */
function PredictionJourney() {
  const { t } = useI18n();

  const [exampleIndex, setExampleIndex] = useState(0);
  const example = PREDICTION_EXAMPLES[exampleIndex];
  const section = useRef<HTMLElement>(null);
  useEffect(() => {
    const node = section.current;
    if (!node) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    function update() {
      frame = 0;
      if (!node) return;
      const bounds = node.getBoundingClientRect();
      const progress = Math.min(
        1,
        Math.max(
          0,
          (innerHeight * 0.6 - bounds.top) /
            Math.max(1, bounds.height - innerHeight * 0.4),
        ),
      );
      node.style.setProperty(
        "--journey-progress",
        String(motion.matches ? 1 : progress),
      );
      node.dataset.step = motion.matches
        ? "2"
        : String(Math.min(2, Math.floor(progress * 3)));
    }
    function schedule() {
      if (!frame) frame = requestAnimationFrame(update);
    }
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    motion.addEventListener("change", schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      motion.removeEventListener("change", schedule);
    };
  }, []);
  return (
    <section
      className="prediction-journey"
      id="how-predictions-work"
      ref={section}
      aria-labelledby="journey-title"
    >
      <div className="journey-intro">
        <h2 id="journey-title">{t("How it works")}</h2>
      </div>
      <div className="journey-layout">
        <div className="journey-steps">
          <article className="journey-step">
            <span>{t("01 / Choose")}</span>
            <h3>{t("Read the rules")}</h3>
            <p>{t("Find a question. Read its rules. Choose YES or NO.")}</p>
          </article>
          <article className="journey-step">
            <span>{t("02 / Trade")}</span>
            <h3>{t("Place an order")}</h3>
            <p>
              {t(
                "Buy or sell outcome contracts with other traders. Your limit sets the price you’ll accept.",
              )}
            </p>
          </article>
          <article className="journey-step">
            <span>{t("03 / Understand")}</span>
            <h3>{t("Claim after resolution")}</h3>
            <p>
              {t(
                "Check the evidence, resolver and cutoff. A winning contract is designed to pay 1 collateral token after final resolution.",
              )}
            </p>
            <small>
              {PREDICTION_RESOLUTION_ENABLED
                ? t(
                    "Finalized winning contracts can be redeemed into your shared wallet.",
                  )
                : t("Resolution and claims require the next program upgrade.")}
            </small>
          </article>
        </div>
        <div className="journey-sticky">
          <div
            className="journey-market"
            aria-label={t("Illustrative prediction market")}
          >
            <div className="journey-market-top">
              <span>{t("EXAMPLE MARKET")}</span>
              <span className="journey-demo">{t("Illustration only")}</span>
            </div>
            <div
              className="journey-example-tabs"
              role="group"
              aria-label={t("Choose an example market")}
            >
              {PREDICTION_EXAMPLES.map((item, index) => (
                <button
                  key={item.category}
                  type="button"
                  aria-pressed={index === exampleIndex}
                  onClick={() => setExampleIndex(index)}
                >
                  {t(item.category)}
                </button>
              ))}
            </div>
            <div className="journey-question-icon" aria-hidden="true">
              {example.icon}
            </div>
            <h3>{t(example.question)}</h3>
            <p className="journey-question-note">{t(example.criteria)}</p>
            <div className="journey-outcomes">
              <div>
                <span>{t("YES")}</span>
                <strong>
                  {example.yes} <small>tUSDC</small>
                </strong>
              </div>
              <div>
                <span>{t("NO")}</span>
                <strong>
                  {example.no} <small>tUSDC</small>
                </strong>
              </div>
            </div>
            <div className="journey-order">
              <span>{t("Example limit buy")}</span>
              <strong>
                {t("10 YES × {value0} = {value1} tUSDC", {
                  value0: example.yes,
                  value1: example.cost,
                })}
              </strong>
              <small>{t("Before fees · only if the order fills")}</small>
            </div>
            <div className="journey-terms">
              <span aria-hidden="true">✓</span>
              <div>
                <strong>{t("Know what decides the outcome")}</strong>
                <small>{t(example.evidence)}</small>
              </div>
            </div>
            <div className="journey-progress" aria-hidden="true">
              <span />
            </div>
            <p className="journey-card-caption">
              {t(
                "Example prices, not live quotes or guaranteed probabilities.",
              )}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

export function Dashboard() {
  const { t } = useI18n();

  const { error } = useNetworkWallet();
  const { setVisible } = useWalletModal();

  return (
    <div className="network-shell landing-shell">
      <NetworkHeader />
      <main id="top">
        <section className="landing-hero" aria-labelledby="landing-title">
          <div className="landing-copy">
            <h1 id="landing-title">
              <span>{t("Every Outcome Has a Market.")}</span>
            </h1>
            <p>{t("Choose your wallet. Trade your view.")}</p>
            <div className="landing-actions">
              <SharedWalletButton />
              <Link
                className="landing-action-secondary"
                href="#how-predictions-work"
              >
                {t("How it works")} <span aria-hidden="true">→</span>
              </Link>
            </div>
          </div>
          <div className="prediction-hero-art">
            <OrderFlow />
          </div>
        </section>
        {error && (
          <p role="alert" className="error-message">
            {error}
          </p>
        )}
        <PredictionJourney />
        <div className="network-choices">
          <button type="button" onClick={() => setVisible(true)}>
            Solana <span>{t("Predictions & spot")}</span> ↗
          </button>
          <button type="button" onClick={() => setVisible(true)}>
            Canton <span>{t("Predictions")}</span> ↗
          </button>
        </div>
      </main>
      <footer className="landing-footer">
        <span>Outcomia</span>
        <a
          href="https://github.com/kunal171/outcomia"
          target="_blank"
          rel="noreferrer"
        >
          {t("Open source ↗")}
        </a>
      </footer>
    </div>
  );
}
