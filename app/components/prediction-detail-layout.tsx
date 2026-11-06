"use client";

import { useEffect, useState, type ReactNode } from "react";
import { BN } from "@anchor-lang/core";
import Link from "next/link";
import { useAnchorWallet } from "@solana/wallet-adapter-react";
import {
  predictionStatus,
  type PredictionMarketAccount,
} from "../lib/prediction";
import type { MarketMetadataAccount } from "../lib/tidebook";
import { PredictionMarketOverview } from "./prediction/market-overview";
import { PredictionMarketRules } from "./prediction/market-rules";
import { useProtocolRole } from "./protocol-role-provider";

type Tab = "trade" | "position" | "rules" | "manage";
interface Props {
  market: PredictionMarketAccount;
  metadata: MarketMetadataAccount | null;
  loading: boolean;
  onRefresh: () => void;
  trade: (tradingOpen: boolean) => ReactNode;
  position: ReactNode;
  rules: ReactNode;
  manage: ReactNode;
}

/** Task-based navigation keeps contract administration out of the trading ticket.
 * Visited panels stay mounted: switching tabs cannot discard a pending signature.
 * No balances or lifecycle state are inferred from a missing RPC response.
 */
export function PredictionDetailLayout(props: Props) {
  const { market, metadata } = props;
  const wallet = useAnchorWallet();
  const role = useProtocolRole();
  const status = predictionStatus(market);
  const [tab, setTab] = useState<Tab>(
    status === "resolved" ? "position" : "trade",
  );
  const [visited, setVisited] = useState<Tab[]>([tab]);
  const [wasOpen, setWasOpen] = useState(status === "open");
  useEffect(() => {
    if (status === "open") setWasOpen(true);
  }, [status]);
  const [now, setNow] = useState<BN | null>(null);
  useEffect(() => {
    const tick = () => setNow(new BN(String(Math.floor(Date.now() / 1000))));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, []);
  const expired = !!now && now.gte(market.closeTs);
  const tradingClosed = status !== "open" || expired;
  const canManage =
    !!now &&
    !!wallet &&
    !role.loading &&
    !role.error &&
    (role.role === "admin" || role.role === "super-admin") &&
    (wallet.publicKey.equals(market.authority) ||
      wallet.publicKey.equals(market.resolver) ||
      !!market.fallback?.resolver.equals(wallet.publicKey));
  const tabs: { id: Tab; label: string }[] = [
    { id: "trade", label: "Trade" },
    { id: "position", label: "Your position" },
    { id: "rules", label: "Rules & outcome" },
    ...(canManage ? [{ id: "manage" as const, label: "Manage market" }] : []),
  ];
  const active = tab === "manage" && !canManage ? "trade" : tab;
  const select = (next: Tab) => {
    setTab(next);
    setVisited((current) =>
      current.includes(next) ? current : [...current, next],
    );
  };
  const symbol = metadata?.quoteSymbol ?? "collateral token";
  const label =
    status === "draft"
      ? expired
        ? "Expired draft"
        : "Not open yet"
      : status === "open"
        ? expired
          ? "Trading closed"
          : "Open for trading"
        : status === "proposed"
          ? "Outcome under review"
          : status === "resolved"
            ? `Resolved · ${Object.keys(market.finalOutcome ?? {})[0]?.toUpperCase() ?? "Unknown"}`
            : "Awaiting outcome";
  return (
    <div className="prediction-workspace">
      <PredictionMarketOverview
        market={market}
        name={metadata?.displayName ?? "Prediction market"}
        symbol={symbol}
        status={label}
        loading={props.loading}
        onRefresh={props.onRefresh}
      />
      <div
        className="prediction-task-tabs"
        role="tablist"
        aria-label="Prediction market sections"
      >
        {tabs.map((item, index) => (
          <button
            key={item.id}
            id={`prediction-tab-${item.id}`}
            type="button"
            role="tab"
            aria-selected={active === item.id}
            aria-controls={`prediction-panel-${item.id}`}
            tabIndex={active === item.id ? 0 : -1}
            onClick={() => select(item.id)}
            onKeyDown={(event) => {
              const next =
                event.key === "ArrowRight"
                  ? (index + 1) % tabs.length
                  : event.key === "ArrowLeft"
                    ? (index + tabs.length - 1) % tabs.length
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? tabs.length - 1
                        : null;
              if (next !== null) {
                event.preventDefault();
                select(tabs[next].id);
                document
                  .getElementById(`prediction-tab-${tabs[next].id}`)
                  ?.focus();
              }
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
      {tabs.map(({ id }) => (
        <section
          key={id}
          id={`prediction-panel-${id}`}
          role="tabpanel"
          aria-labelledby={`prediction-tab-${id}`}
          hidden={active !== id}
          tabIndex={0}
        >
          {(visited.includes(id) || active === id) &&
            (id === "trade" ? (
              <>
                {tradingClosed && (
                  <div className="prediction-empty-state">
                    <h2>
                      {status === "draft"
                        ? expired
                          ? "This draft never opened"
                          : "Trading hasn’t started"
                        : "Trading has ended"}
                    </h2>
                    <p>
                      {status === "draft"
                        ? expired
                          ? "Its closing time has passed. This draft cannot be opened; a creator needs to publish a new market."
                          : "The creator needs to open this market before anyone can trade."
                        : "Check your position to cancel remaining orders or claim after the outcome is final."}
                    </p>
                    <button
                      className="admin-action-button"
                      onClick={() =>
                        select(status === "draft" ? "rules" : "position")
                      }
                    >
                      {status === "draft"
                        ? "Read the rules"
                        : "View your position"}
                    </button>
                    {canManage && status === "draft" && (
                      <Link className="text-button" href="/markets/new">
                        Create a new market →
                      </Link>
                    )}
                  </div>
                )}
                {/* Keep execution mounted after cutoff so pending results remain visible. */}
                {(status === "open" || wasOpen) &&
                  props.trade(!tradingClosed && !!now)}
              </>
            ) : id === "position" ? (
              <>
                <div className="prediction-position-intro">
                  <Link className="text-button" href="/wallet">
                    Wallet →
                  </Link>
                </div>
                {props.position}
              </>
            ) : id === "rules" ? (
              <PredictionMarketRules market={market} symbol={symbol}>
                {props.rules}
              </PredictionMarketRules>
            ) : (
              props.manage
            ))}
        </section>
      ))}
    </div>
  );
}
