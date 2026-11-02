"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { PROGRAM_EXPLORER_URL, PROGRAM_ID } from "../lib/solana";
import { AppHeader } from "./app-header";

type ProgramStatus = "checking" | "deployed" | "not-deployed" | "unavailable";

const shortAddress = (address: string) =>
  `${address.slice(0, 5)}…${address.slice(-5)}`;

const executionSteps = [
  { number: "01", label: "Fund", detail: "Deposit into a market balance" },
  { number: "02", label: "Place", detail: "Submit a collateralized limit order" },
  { number: "03", label: "Settle", detail: "Match FIFO and settle atomically" },
];

export function Dashboard() {
  const { connection } = useConnection();
  const [programStatus, setProgramStatus] =
    useState<ProgramStatus>("checking");

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
    checking: "Checking program",
    deployed: "Live on devnet",
    "not-deployed": "Deployment not found",
    unavailable: "RPC unavailable",
  }[programStatus];

  return (
    <div className="app-shell home-shell">
      <AppHeader />

      <main id="top">
        <section className="home-hero">
          <div className="home-hero-copy">
            <div className="eyebrow">
              <span className="eyebrow-dot" />
              Solana central limit order book
            </div>
            <h1>
              Price-time priority,
              <span> settled on-chain.</span>
            </h1>
            <p>
              Tidebook is a working limit-order exchange on Solana devnet. Fund
              a market, place bids and asks, and watch every fill settle
              atomically into trader balances.
            </p>

            <div className="home-actions">
              <Link className="home-primary-action" href="/markets">
                Explore markets
                <span aria-hidden="true">↗</span>
              </Link>
              <Link className="home-secondary-action" href="/orders">
                View my orders
              </Link>
            </div>

            <div className="home-trust-row" aria-label="Protocol properties">
              <span>Non-custodial withdrawal</span>
              <span>FIFO matching</span>
              <span>Atomic settlement</span>
            </div>
          </div>

          <div className="execution-panel" aria-label="Tidebook execution model">
            <div className="execution-panel-head">
              <div>
                <span className="panel-kicker">Execution model</span>
                <strong>One transaction path</strong>
              </div>
              <div className={`program-chip program-chip-${programStatus}`}>
                <span />
                {statusLabel}
              </div>
            </div>

            <div className="book-visual" aria-hidden="true">
              <div className="book-side book-sells">
                <span>SELL</span>
                <i style={{ width: "47%" }} />
                <i style={{ width: "68%" }} />
                <i style={{ width: "84%" }} />
              </div>
              <div className="book-midline">
                <span>maker price</span>
                <strong>atomic fill</strong>
              </div>
              <div className="book-side book-buys">
                <i style={{ width: "76%" }} />
                <i style={{ width: "57%" }} />
                <i style={{ width: "38%" }} />
                <span>BUY</span>
              </div>
            </div>

            <div className="execution-steps">
              {executionSteps.map((step) => (
                <div className="execution-step" key={step.number}>
                  <span>{step.number}</span>
                  <div>
                    <strong>{step.label}</strong>
                    <p>{step.detail}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="protocol-strip" aria-label="Protocol status">
          <article>
            <div className="protocol-strip-top">
              <span className={`status-indicator status-${programStatus}`} />
              <span>Program</span>
            </div>
            <strong>{statusLabel}</strong>
            <button
              className="text-button"
              type="button"
              onClick={() => void refreshProgramStatus()}
              disabled={programStatus === "checking"}
            >
              Refresh status
            </button>
          </article>
          <article>
            <div className="protocol-strip-top">
              <span className="strip-index">01</span>
              <span>Matching</span>
            </div>
            <strong>Price, then time</strong>
            <p>Orders at each price level execute in FIFO order.</p>
          </article>
          <article>
            <div className="protocol-strip-top">
              <span className="strip-index">02</span>
              <span>Risk model</span>
            </div>
            <strong>Fully collateralized</strong>
            <p>Balances are locked before an order enters the book.</p>
          </article>
          <article>
            <div className="protocol-strip-top">
              <span className="strip-index">03</span>
              <span>Data</span>
            </div>
            <strong>Indexer-ready events</strong>
            <p>Finalized protocol events flow into PostgreSQL.</p>
          </article>
        </section>

        <section className="home-capabilities">
          <div className="home-section-heading">
            <div>
              <div className="eyebrow">The complete trading loop</div>
              <h2>More than an order form.</h2>
            </div>
            <p>
              The interface exposes the same lifecycle enforced by the
              program—from collateral to cancellation, matching, fees, and
              withdrawal.
            </p>
          </div>

          <div className="capability-grid">
            <article>
              <span className="capability-number">01 / MARKETS</span>
              <h3>Discover the live book</h3>
              <p>
                Inspect active markets, price levels, vaults, balances, and the
                latest traded price.
              </p>
              <Link href="/markets">Open markets →</Link>
            </article>
            <article>
              <span className="capability-number">02 / ORDERS</span>
              <h3>Control every order</h3>
              <p>
                Track open, filled, and cancelled orders. Release locked funds
                by cancelling directly from your wallet.
              </p>
              <Link href="/orders">Review orders →</Link>
            </article>
            <article>
              <span className="capability-number">03 / SETTLEMENT</span>
              <h3>Keep assets accounted for</h3>
              <p>
                Maker and taker balances update atomically while protocol fees
                remain separately accounted for.
              </p>
              <a href={PROGRAM_EXPLORER_URL} target="_blank" rel="noreferrer">
                Inspect program ↗
              </a>
            </article>
          </div>
        </section>

        <section className="home-program-callout">
          <div>
            <span className="panel-kicker">Verifiable by default</span>
            <h2>The program is the source of truth.</h2>
          </div>
          <div className="program-address-block">
            <span>Devnet program</span>
            <code>{shortAddress(PROGRAM_ID.toBase58())}</code>
            <a href={PROGRAM_EXPLORER_URL} target="_blank" rel="noreferrer">
              View on Explorer ↗
            </a>
          </div>
        </section>
      </main>

      <footer>
        <span>Tidebook · on-chain order book</span>
        <span>Anchor · Solana · PostgreSQL</span>
      </footer>
    </div>
  );
}
