"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { PROGRAM_EXPLORER_URL, PROGRAM_ID } from "../lib/solana";
import { AppHeader } from "./app-header";

type ProgramStatus = "checking" | "deployed" | "not-deployed" | "unavailable";

/** Decorative order flow, not live prices or a simulated trading result. */
function OrderFlow() {
  return (
    <div
      className="landing-flow"
      role="img"
      aria-label="Illustration of buy and sell orders for a YES contract meeting"
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
            <stop stopColor="#ff9b86" />
            <stop offset="1" stopColor="#b5a2ff" />
          </linearGradient>
          <linearGradient
            id="flow-buy"
            x1="450"
            y1="360"
            x2="280"
            y2="220"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="#6de6d1" />
            <stop offset="1" stopColor="#b5a2ff" />
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
          Sell YES <i>↘</i>
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
          Buy YES <i>↗</i>
        </span>
        <div>
          <b />
          <b />
          <b />
        </div>
      </div>
      <span className="flow-caption" aria-hidden="true">
        One outcome. Two sides of the book.
      </span>
    </div>
  );
}

/** Scroll changes only this illustration. Prices are examples, never fetched quotes. */
function PredictionJourney() {
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
        <span className="eyebrow">A question. An order book. Your call.</span>
        <h2 id="journey-title">
          From “what if”
          <br />
          to your next move.
        </h2>
        <p>Scroll through a prediction.</p>
      </div>
      <div className="journey-layout">
        <div className="journey-steps">
          <article className="journey-step">
            <span>01 / Choose</span>
            <h3>
              Have a view?
              <br />
              Take a side.
            </h3>
            <p>Find a question. Read its rules. Choose YES or NO.</p>
          </article>
          <article className="journey-step">
            <span>02 / Trade</span>
            <h3>
              Your conviction.
              <br />
              Your limit price.
            </h3>
            <p>
              Buy or sell outcome contracts with other traders. Your limit sets
              the price you’ll accept.
            </p>
          </article>
          <article className="journey-step">
            <span>03 / Understand</span>
            <h3>
              Clear rules.
              <br />
              Before your trade.
            </h3>
            <p>
              Check the evidence, resolver and cutoff. A winning contract is
              designed to pay 1 collateral token after final resolution.
            </p>
            <small>
              Resolution and reward claims are still in development.
            </small>
          </article>
        </div>
        <div className="journey-sticky">
          <div
            className="journey-market"
            aria-label="Illustrative prediction market"
          >
            <div className="journey-market-top">
              <span>EXAMPLE MARKET</span>
              <span className="journey-demo">Illustration only</span>
            </div>
            <div className="journey-question-icon" aria-hidden="true">
              ↗
            </div>
            <h3>
              Will Solana hit
              <br />
              its next milestone?
            </h3>
            <p className="journey-question-note">
              One question. Two possible outcomes.
            </p>
            <div className="journey-outcomes">
              <div>
                <span>YES</span>
                <strong>
                  0.60 <small>tUSDC</small>
                </strong>
              </div>
              <div>
                <span>NO</span>
                <strong>
                  0.40 <small>tUSDC</small>
                </strong>
              </div>
            </div>
            <div className="journey-order">
              <span>Example limit buy</span>
              <strong>10 YES × 0.60 = 6 tUSDC</strong>
              <small>Before fees · only if the order fills</small>
            </div>
            <div className="journey-terms">
              <span aria-hidden="true">✓</span>
              <div>
                <strong>Know what decides the outcome</strong>
                <small>Evidence · resolver · closing time</small>
              </div>
            </div>
            <div className="journey-progress" aria-hidden="true">
              <span />
            </div>
            <p className="journey-card-caption">
              Example prices, not live quotes or guaranteed probabilities.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

export function Dashboard() {
  const { connection } = useConnection();
  const [programStatus, setProgramStatus] = useState<ProgramStatus>("checking");
  const refreshProgramStatus = useCallback(async () => {
    setProgramStatus("checking");
    try {
      const account = await connection.getAccountInfo(PROGRAM_ID, "confirmed");
      setProgramStatus(account?.executable ? "deployed" : "not-deployed");
    } catch {
      setProgramStatus("unavailable");
    }
  }, [connection]);

  useEffect(() => {
    void refreshProgramStatus();
  }, [refreshProgramStatus]);
  const statusLabel = {
    checking: "Checking program…",
    deployed: "Program live on devnet",
    "not-deployed": "Program not found",
    unavailable: "RPC unavailable",
  }[programStatus];

  return (
    <div className="app-shell landing-shell">
      <AppHeader />
      <main id="top">
        <section className="landing-hero" aria-labelledby="landing-title">
          <div className="landing-copy">
            <span className="landing-kicker">
              <i aria-hidden="true" /> Prediction markets on Solana.
            </span>
            <h1 id="landing-title">
              Predict what
              <br />
              <span>comes next.</span>
            </h1>
            <p>
              Trade your view on what comes next. YES or NO. Your price, your
              call.
            </p>
            <div className="landing-actions">
              <Link className="landing-action-primary" href="/predictions">
                Explore predictions <span aria-hidden="true">↗</span>
              </Link>
              <Link
                className="landing-action-secondary"
                href="#how-predictions-work"
              >
                How it works <span aria-hidden="true">→</span>
              </Link>
            </div>
            <div className="landing-tags">
              <span>YES / NO order books</span>
              <i aria-hidden="true" />
              <span>One collateral asset</span>
            </div>
          </div>
          <div className="prediction-hero-art">
            <span className="hero-art-label">
              A market for every point of view.
            </span>
            <OrderFlow />
          </div>
        </section>
        <p className="landing-rollout-note">
          Devnet preview · Prediction trading is in development. Resolution and
          reward claims are not available yet.
        </p>
        <PredictionJourney />
        <section
          className="landing-secondary"
          aria-labelledby="secondary-title"
        >
          <div className="secondary-heading">
            <span className="eyebrow">More on Tidebook</span>
            <h2 id="secondary-title">Beyond predictions.</h2>
          </div>
          <nav className="landing-destinations" aria-label="More on Tidebook">
            <Link
              className="landing-destination destination-spot"
              href="/markets"
            >
              <span className="destination-icon" aria-hidden="true">
                ↗
              </span>
              <div>
                <h2>Spot markets</h2>
                <p>Find your next trade.</p>
              </div>
              <span className="destination-arrow" aria-hidden="true">
                ↗
              </span>
            </Link>
            <Link
              className="landing-destination destination-orders"
              href="/orders"
            >
              <span className="destination-icon" aria-hidden="true">
                ≋
              </span>
              <div>
                <h2>Your orders</h2>
                <p>Track fills. Cancel open orders.</p>
              </div>
              <span className="destination-arrow" aria-hidden="true">
                ↗
              </span>
            </Link>
          </nav>
        </section>
        <div className="landing-status">
          <div role="status">
            <span
              className={`landing-status-dot landing-status-${programStatus}`}
              aria-hidden="true"
            />
            {statusLabel}
          </div>
          <button
            type="button"
            disabled={programStatus === "checking"}
            onClick={() => void refreshProgramStatus()}
            aria-label="Refresh program status"
          >
            Refresh <span aria-hidden="true">↻</span>
          </button>
          <a href={PROGRAM_EXPLORER_URL} target="_blank" rel="noreferrer">
            View program <span aria-hidden="true">↗</span>
          </a>
          <span className="landing-devnet-note">Devnet · test tokens only</span>
        </div>
      </main>
      <footer className="landing-footer">
        <span>Tidebook. Built on Solana.</span>
        <a
          href="https://github.com/kunal171/tidebook"
          target="_blank"
          rel="noreferrer"
        >
          Open source ↗
        </a>
      </footer>
    </div>
  );
}
