"use client";
import Link from "next/link";
import { useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { AppHeader } from "../app-header";
import { useI18n } from "../preferences-provider";
import { useWalletSession } from "../wallet-session-provider";
import { accountExplorerUrl, transactionExplorerUrl } from "../../lib/outcomia";
import { INDEXER_ENABLED } from "../../lib/graphql/client";
import {
  getLeaderboardMints,
  getProfile,
  getTraderStats,
  type TraderStats,
} from "../../lib/graphql/social";
import { marketHref } from "./leaderboard-page";
import {
  formatAtoms,
  shortAddress,
  tokenLabel,
  useQuietData,
  WalletAvatar,
} from "./social-ui";

function isAddress(value: string) {
  try {
    new PublicKey(value);
    return value.length >= 32;
  } catch {
    return false;
  }
}

/** `/u/<username | wallet>`: public profile and trading record. */
export function ProfilePage({ id }: { id: string }) {
  const { t } = useI18n();
  const session = useWalletSession();
  const lookup = decodeURIComponent(id);
  const result = useQuietData(async () => {
    const wallet = isAddress(lookup)
      ? lookup
      : (await getProfile({ username: lookup }))?.wallet;
    if (!wallet) return null;
    const [stats, mints] = await Promise.all([
      getTraderStats(wallet),
      getLeaderboardMints(),
    ]);
    return { stats, mints: mints.leaderboardMints };
  }, [lookup]);

  return (
    <div className="app-shell">
      <AppHeader />
      <main className="route-shell profile-page">
        {!INDEXER_ENABLED ? (
          <div className="access-card">
            <h2>
              {t("Profiles need the indexer, which is off in this deployment.")}
            </h2>
          </div>
        ) : result.error && !result.data ? (
          <p role="alert">
            {t("This profile could not load. Try again shortly.")}
          </p>
        ) : result.loading ? (
          <p role="status">{t("Loading…")}</p>
        ) : !result.data ? (
          <div className="access-card">
            <h2>{t("No profile called @{value0}", { value0: lookup })}</h2>
            <Link href="/leaderboard">{t("Browse the leaderboard →")}</Link>
          </div>
        ) : (
          <ProfileBody
            stats={result.data.stats}
            symbols={Object.fromEntries(
              result.data.mints.map((m) => [m.mint, m.symbol]),
            )}
            own={session?.user?.wallet === result.data.stats.wallet}
          />
        )}
      </main>
    </div>
  );
}

function ProfileBody({
  stats,
  symbols,
  own,
}: {
  stats: TraderStats;
  symbols: Record<string, string | null>;
  own: boolean;
}) {
  const { t, locale } = useI18n();
  const { profile, wallet } = stats;
  const [mint, setMint] = useState(stats.perMint[0]?.mint ?? null);
  const current =
    stats.perMint.find((m) => m.mint === mint) ?? stats.perMint[0];
  const decimalsOf = (m: string | null) =>
    stats.perMint.find((s) => s.mint === m)?.decimals ?? 6;
  const label = (m: string | null) => (m ? tokenLabel(m, symbols[m]) : "");
  const decided = current ? current.wins + current.losses : 0;
  const [showAll, setShowAll] = useState(false);
  const [allTrades, setAllTrades] = useState(false);
  // One row per market, listing every outcome held there.
  const positions = Object.values(
    stats.openPositions.reduce<
      Record<
        string,
        {
          market: string;
          kind: string;
          title: string | null;
          holdings: TraderStats["openPositions"];
        }
      >
    >((groups, p) => {
      (groups[p.market] ??= {
        market: p.market,
        kind: p.kind,
        title: p.title,
        holdings: [],
      }).holdings.push(p);
      return groups;
    }, {}),
  );
  return (
    <>
      <section className="profile-hero">
        <WalletAvatar wallet={wallet} hue={profile?.avatarHue} size={88} />
        <div>
          <h1>
            {profile?.displayName ||
              (profile ? `@${profile.username}` : shortAddress(wallet))}
          </h1>
          {profile && <p className="profile-handle">@{profile.username}</p>}
          {profile?.bio && <p className="profile-bio">{profile.bio}</p>}
          <p className="profile-meta">
            <a
              href={accountExplorerUrl(new PublicKey(wallet))}
              target="_blank"
              rel="noreferrer"
            >
              <code>{shortAddress(wallet)}</code> ↗
            </a>
            {profile?.xHandle && (
              <a
                href={`https://x.com/${profile.xHandle}`}
                target="_blank"
                rel="noreferrer"
              >
                @{profile.xHandle} ↗
              </a>
            )}
            {profile && (
              <span>
                {t("Joined {value0}", {
                  value0: new Date(profile.createdAt).toLocaleDateString(
                    locale,
                    {
                      month: "short",
                      year: "numeric",
                    },
                  ),
                })}
              </span>
            )}
          </p>
          {own && (
            <Link className="ui-btn" href="/wallet#profile">
              {profile ? t("Edit profile") : t("Create your profile")}
            </Link>
          )}
        </div>
      </section>

      {stats.perMint.length > 1 && (
        <div className="lb-chips" role="group" aria-label={t("Token")}>
          {stats.perMint.map((m) => (
            <button
              key={m.mint}
              type="button"
              aria-pressed={m.mint === current?.mint}
              onClick={() => setMint(m.mint)}
            >
              {label(m.mint)}
            </button>
          ))}
        </div>
      )}
      {current ? (
        <section className="profile-stats">
          <article>
            <span className="card-label">{t("Volume")}</span>
            <strong>
              {formatAtoms(current.volume, current.decimals ?? 6)}{" "}
              <small>{label(current.mint)}</small>
            </strong>
          </article>
          <article>
            <span className="card-label">{t("Trades")}</span>
            <strong>{current.trades.toLocaleString()}</strong>
            <small>
              {t("in {value0} markets", { value0: current.markets })}
            </small>
          </article>
          <article>
            <span className="card-label">{t("Realized profit")}</span>
            <strong
              className={Number(current.profit) >= 0 ? "lb-up" : "lb-down"}
            >
              {formatAtoms(current.profit, current.decimals ?? 6)}{" "}
              <small>{label(current.mint)}</small>
            </strong>
            <small>{t("Settled markets only")}</small>
          </article>
          <article>
            <span className="card-label">{t("Win rate")}</span>
            <strong>
              {decided ? `${Math.round((current.wins / decided) * 100)}%` : "—"}
            </strong>
            <small>
              {t("{value0} won · {value1} lost", {
                value0: current.wins,
                value1: current.losses,
              })}
            </small>
          </article>
        </section>
      ) : (
        <p className="lb-empty">{t("No trades yet.")}</p>
      )}

      <div className="profile-grid">
        <section className="admin-card">
          <h2>{t("Open positions")}</h2>
          {stats.openPositions.length === 0 ? (
            <p className="lb-empty">{t("No open positions.")}</p>
          ) : (
            <>
              <ul className="profile-list">
                {(showAll ? positions : positions.slice(0, 8)).map((p) => (
                  <li key={p.market}>
                    <Link href={marketHref(p.kind, p.market)}>
                      {p.title ?? shortAddress(p.market)}
                    </Link>
                    <span>
                      {p.holdings.map((h, i) => (
                        <span key={h.outcome}>
                          {i > 0 && " · "}
                          <span
                            className={
                              Number(h.contracts) >= 0 ? "lb-up" : "lb-down"
                            }
                          >
                            {Number(h.contracts).toLocaleString()}
                          </span>{" "}
                          {h.outcomeLabel ?? h.outcome}
                        </span>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
              {positions.length > 8 && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => setShowAll((v) => !v)}
                >
                  {showAll
                    ? t("Show fewer")
                    : t("Show all {value0} markets", {
                        value0: positions.length,
                      })}
                </button>
              )}
            </>
          )}
        </section>
        <section className="admin-card">
          <h2>{t("Settled markets")}</h2>
          {stats.settled.length === 0 ? (
            <p className="lb-empty">{t("No settled markets yet.")}</p>
          ) : (
            <ul className="profile-list">
              {stats.settled.map((s) => (
                <li key={s.market}>
                  <Link href={marketHref(s.kind, s.market)}>
                    {s.title ?? shortAddress(s.market)}
                  </Link>
                  <span className={Number(s.profit) >= 0 ? "lb-up" : "lb-down"}>
                    {formatAtoms(s.profit, decimalsOf(s.mint))} {label(s.mint)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="admin-card">
          <h2>{t("Recent trades")}</h2>
          {stats.recentTrades.length === 0 ? (
            <p className="lb-empty">{t("No trades yet.")}</p>
          ) : (
            <ul className="profile-list">
              {(allTrades
                ? stats.recentTrades
                : stats.recentTrades.slice(0, 10)
              ).map((r) => (
                <li
                  key={`${r.signature}:${r.market}:${r.outcome}:${r.role}:${r.contracts}`}
                >
                  <Link href={marketHref(r.kind, r.market)}>
                    {r.title ?? shortAddress(r.market)}
                  </Link>
                  <span>
                    {Number(r.contracts) >= 0 ? t("Bought") : t("Sold")}{" "}
                    {Math.abs(Number(r.contracts)).toLocaleString()}{" "}
                    {r.outcomeLabel ?? ""} @{" "}
                    {formatAtoms(r.price, decimalsOf(r.mint), 4)}{" "}
                    <a
                      href={transactionExplorerUrl(r.signature)}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={t("Transaction")}
                    >
                      ↗
                    </a>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {stats.recentTrades.length > 10 && (
            <button
              type="button"
              className="text-button"
              onClick={() => setAllTrades((v) => !v)}
            >
              {allTrades
                ? t("Show fewer")
                : t("Show all {value0} trades", {
                    value0: stats.recentTrades.length,
                  })}
            </button>
          )}
        </section>
        <section className="admin-card">
          <h2>{t("Clubs")}</h2>
          {stats.clubs.length === 0 ? (
            <p className="lb-empty">{t("Not in any club.")}</p>
          ) : (
            <ul className="profile-list">
              {stats.clubs.map((c) => (
                <li key={c.club}>
                  <Link href={`/clubs/${c.club}`}>
                    {c.name ?? shortAddress(c.club)}
                  </Link>
                  <span className="lb-kind">
                    {t(
                      c.role === "owner"
                        ? "Owner"
                        : c.role === "admin"
                          ? "Admin"
                          : "Member",
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
