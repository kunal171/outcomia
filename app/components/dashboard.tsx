"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
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
      aria-label="Illustration of buy and sell orders meeting"
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
          Sell orders <i>↘</i>
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
          Buy orders <i>↗</i>
        </span>
        <div>
          <b />
          <b />
          <b />
        </div>
      </div>
      <span className="flow-caption" aria-hidden="true">
        Different sides. One atomic trade.
      </span>
    </div>
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
              <i aria-hidden="true" /> Made for the order book.
            </span>
            <h1 id="landing-title">
              Your price.
              <br />
              <span>Your move.</span>
            </h1>
            <p>Trade on Solana. Set your limit. Keep control.</p>
            <div className="landing-actions">
              <Link className="landing-action-primary" href="/markets">
                Explore markets <span aria-hidden="true">↗</span>
              </Link>
              <Link className="landing-action-secondary" href="/orders">
                Your orders <span aria-hidden="true">→</span>
              </Link>
            </div>
            <div className="landing-tags">
              <span>Price-time priority</span>
              <i aria-hidden="true" />
              <span>Atomic settlement</span>
            </div>
          </div>
          <OrderFlow />
        </section>
        <nav className="landing-destinations" aria-label="Explore Tidebook">
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
          <Link
            className="landing-destination destination-prediction"
            href="/predictions"
          >
            <span className="destination-icon" aria-hidden="true">
              ◈
            </span>
            <div>
              <h2>
                Predictions <small>In development</small>
              </h2>
              <p>Explore the YES / NO books.</p>
            </div>
            <span className="destination-arrow" aria-hidden="true">
              ↗
            </span>
          </Link>
        </nav>
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
