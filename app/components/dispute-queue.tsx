"use client";
/** Admin queue of disputes waiting for a ruling, soonest deadline first
 * (docs/club-rules-and-disputes.md §3). Rulings happen on each market's page,
 * where eligibility is checked. */
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useConnection } from "@solana/wallet-adapter-react";
import type { PublicKey } from "@solana/web3.js";
import { AppHeader } from "./app-header";
import { useI18n } from "./preferences-provider";
import { useProtocolRole } from "./protocol-role-provider";
import { getOutcomiaReadProgram } from "../lib/outcomia";
import { readOpenDisputes, type MarketDisputeAccount } from "../lib/disputes";
import { clubAccounts, clubMarketHref } from "../lib/clubs";

type Row = { dispute: MarketDisputeAccount; href: string; name: string | null };

export function DisputeQueue() {
  const { t } = useI18n();
  const { connection } = useConnection();
  const { role, loading } = useProtocolRole();
  const reader = useMemo(() => getOutcomiaReadProgram(connection), [connection]);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [issue, setIssue] = useState<string | null>(null);
  const admin = role === "admin" || role === "super-admin";

  useEffect(() => {
    if (!admin) return;
    let dead = false;
    void readOpenDisputes(reader)
      .then(async (open) => {
        const a = clubAccounts(reader);
        const resolved = await Promise.all(
          open.map(async ({ account }) => {
            const market: PublicKey = account.market;
            // Club markets link to their club page; others to the market page.
            const binary = await a.predictionMarket.fetchNullable(market).catch(() => null);
            if (binary) {
              const metadata = await a.marketMetadata
                .fetchNullable(binary.metadata)
                .catch(() => null);
              if (account.clubMarket) {
                const binding = await a.clubMarket
                  .all([{ memcmp: { offset: 40, bytes: market.toBase58() } }])
                  .catch(() => []);
                const club = binding.find((b) => b.account.market.equals(market));
                if (club)
                  return {
                    dispute: account,
                    href: clubMarketHref(club.account.club, market),
                    name: metadata?.displayName ?? null,
                  };
              }
              return {
                dispute: account,
                href: `/predictions/${market.toBase58()}`,
                name: metadata?.displayName ?? null,
              };
            }
            return {
              dispute: account,
              href: `/predictions/multi/${market.toBase58()}`,
              name: null,
            };
          }),
        );
        if (!dead) setRows(resolved);
      })
      .catch((cause) => !dead && setIssue(cause instanceof Error ? cause.message : String(cause)));
    return () => {
      dead = true;
    };
  }, [reader, admin]);

  const now = Math.floor(Date.now() / 1000);
  return (
    <div className="app-shell">
      <AppHeader />
      <main className="route-shell route-shell-narrow">
        <div className="route-heading">
          <h1>{t("Disputes")}</h1>
          <p>
            {t(
              "Disputes waiting for a ruling, soonest deadline first. Open a market to rule; its creator, resolvers and club admins cannot.",
            )}
          </p>
        </div>
        {loading ? (
          <div className="access-card">{t("Checking role…")}</div>
        ) : !admin ? (
          <div className="access-card">{t("An active administrator role is required.")}</div>
        ) : issue ? (
          <div className="access-card" role="alert">
            {t(issue)}
          </div>
        ) : rows === null ? (
          <div className="access-card">{t("Loading…")}</div>
        ) : rows.length === 0 ? (
          <div className="access-card">{t("No disputes are waiting for a ruling.")}</div>
        ) : (
          <ul className="ui-list">
            {rows.map((row) => {
              const deadline = row.dispute.rulingDeadline.toNumber();
              return (
                <li className="ui-row" key={row.dispute.market.toBase58()}>
                  <Link href={row.href}>
                    <p className="ui-row-title">
                      {row.name ?? row.dispute.market.toBase58()}
                    </p>
                    <p className="ui-row-meta">
                      {row.dispute.clubMarket ? t("Club market") : t("Market")} ·{" "}
                      {deadline > now
                        ? t("Rule by {value0}", {
                            value0: new Date(deadline * 1000).toLocaleString(),
                          })
                        : t("Deadline passed: anyone can make it invalid")}
                    </p>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </main>
    </div>
  );
}
