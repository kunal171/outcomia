"use client";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { PublicKey } from "@solana/web3.js";
import { AppHeader } from "../app-header";
import { useI18n } from "../preferences-provider";
import { useWalletSession } from "../wallet-session-provider";
import { accountExplorerUrl } from "../../lib/outcomia";
import { INDEXER_ENABLED } from "../../lib/graphql/client";
import {
  getLeaderboardMints,
  getProfile,
  getTraderStats,
  type MintStats,
  type TraderStats,
} from "../../lib/graphql/social";
import { ProfileLinks } from "./profile-links";
import { isAddress, isParty, owns } from "./profile-identity";
import { shortParty } from "./linked-accounts";
import {
  formatAtoms,
  shortAddress,
  tokenLabel,
  useQuietData,
  WalletAvatar,
  walletHue,
} from "./social-ui";

/** What the profile body shows: Solana stats when the profile has a wallet;
 * a Canton-only profile has none yet (Canton history needs its indexer). */
type ProfileView = Pick<TraderStats, "profile" | "perMint"> & {
  wallet: string | null;
};

/** `/u/<username | wallet | party>`: who the trader is and how they have done.
 * Orders, positions, clubs and balances live on their own pages. */
export function ProfilePage({ id }: { id: string }) {
  const { t } = useI18n();
  const session = useWalletSession();
  const lookup = decodeURIComponent(id);
  const result = useQuietData(async () => {
    const profile = isAddress(lookup)
      ? null
      : await getProfile(
          isParty(lookup) ? { party: lookup } : { username: lookup },
        );
    const wallet = isAddress(lookup) ? lookup : profile?.wallet;
    if (!wallet) {
      if (!profile) return null;
      const view: ProfileView = { wallet: null, profile, perMint: [] };
      return { stats: view, mints: [] };
    }
    const [stats, mints] = await Promise.all([
      getTraderStats(wallet),
      getLeaderboardMints(),
    ]);
    return { stats: stats as ProfileView, mints: mints.leaderboardMints };
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
            own={owns(session?.user, {
              wallet: result.data.stats.wallet ?? undefined,
              profile: result.data.stats.profile,
            })}
          />
        )}
      </main>
    </div>
  );
}

function sign(value: string | null | undefined) {
  if (!value) return 0;
  return value.startsWith("-") ? -1 : value.replace(/0/g, "") === "" ? 0 : 1;
}

function ProfileBody({
  stats,
  symbols,
  own,
}: {
  stats: ProfileView;
  symbols: Record<string, string | null>;
  own: boolean;
}) {
  const { t, locale } = useI18n();
  const { profile } = stats;
  // Avatar seed and fallback name: the Solana wallet, else the first party.
  const wallet = stats.wallet ?? profile?.cantonParties[0] ?? "";
  const [mint, setMint] = useState(stats.perMint[0]?.mint ?? null);
  const current =
    stats.perMint.find((m) => m.mint === mint) ?? stats.perMint[0];
  const label = (m: string) => tokenLabel(m, symbols[m]);
  const hue = profile?.avatarHue ?? walletHue(wallet);
  return (
    <>
      <section className="profile-hero">
        <div
          className="profile-banner"
          style={{
            background: `linear-gradient(120deg, hsl(${hue} 70% 55% / .55), hsl(${(hue + 60) % 360} 70% 55% / .2))`,
          }}
        />
        <div className="profile-hero-body">
          <WalletAvatar wallet={wallet} hue={profile?.avatarHue} size={96} />
          <div className="profile-identity">
            <h1>
              {profile?.displayName ||
                (profile ? `@${profile.username}` : shortAddress(wallet))}
            </h1>
            {profile && <p className="profile-handle">@{profile.username}</p>}
            {profile?.bio && <p className="profile-bio">{profile.bio}</p>}
            <p className="profile-meta">
              {profile?.location && <span>{profile.location}</span>}
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
              {stats.wallet && (
                <a
                  href={accountExplorerUrl(new PublicKey(stats.wallet))}
                  target="_blank"
                  rel="noreferrer"
                >
                  <code>{shortAddress(stats.wallet)}</code> ↗
                </a>
              )}
              {profile?.cantonParties.map((p) => (
                <span key={p} title={p}>
                  Canton <code>{shortParty(p)}</code>
                </span>
              ))}
            </p>
            {profile && <ProfileLinks profile={profile} />}
          </div>
          {own && (
            <Link
              className="ui-btn profile-edit"
              href={`/u/${encodeURIComponent(profile?.username ?? wallet)}/edit`}
            >
              {profile ? t("Edit profile") : t("Create your profile")}
            </Link>
          )}
        </div>
      </section>

      {stats.perMint.length > 1 && (
        <div
          className="lb-chips profile-tokens"
          role="group"
          aria-label={t("Token")}
        >
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
        <PnlPanel stats={current} unit={label(current.mint)} />
      ) : (
        <p className="lb-empty">{t("No trades yet.")}</p>
      )}
      <p className="profile-footnote">
        {t(
          "Realized P&L counts settled markets. Unrealized P&L values open positions at each outcome’s last traded price.",
        )}{" "}
        <Link href="/leaderboard">{t("See the leaderboard →")}</Link>
      </p>
      {!!profile?.cantonParties.length && (
        <p className="profile-footnote">
          {t(
            "Canton trading is not included yet; it is added once Canton history is indexed.",
          )}
        </p>
      )}
    </>
  );
}

function PnlPanel({ stats, unit }: { stats: MintStats; unit: string }) {
  const { t } = useI18n();
  const decimals = stats.decimals ?? 6;
  const money = (v: string | null | undefined) =>
    formatAtoms(v ?? "0", decimals);
  const total = (BigInt(stats.profit) + BigInt(stats.unrealized)).toString();
  const decided = stats.wins + stats.losses;
  const tone = (v: string | null | undefined) =>
    sign(v) >= 0 ? "lb-up" : "lb-down";
  const makerShare =
    stats.volume !== "0"
      ? `${Math.round((Number(stats.makerVolume) / Number(stats.volume)) * 100)}%`
      : "—";
  const cards: { label: string; value: ReactNode; note?: string }[] = [
    {
      label: "Volume",
      value: (
        <>
          {money(stats.volume)} <small>{unit}</small>
        </>
      ),
    },
    {
      label: "Trades",
      value: stats.trades.toLocaleString(),
      note: t("in {value0} markets", { value0: stats.markets }),
    },
    { label: "Open markets", value: stats.openMarkets.toLocaleString() },
    {
      label: "Win rate",
      value: decided ? `${Math.round((stats.wins / decided) * 100)}%` : "—",
      note: t("{value0} won · {value1} lost", {
        value0: stats.wins,
        value1: stats.losses,
      }),
    },
    {
      label: "Biggest win",
      value: stats.biggestWin ? (
        <span className="lb-up">
          {money(stats.biggestWin)} <small>{unit}</small>
        </span>
      ) : (
        "—"
      ),
    },
    {
      label: "Biggest loss",
      value: stats.biggestLoss ? (
        <span className="lb-down">
          {money(stats.biggestLoss)} <small>{unit}</small>
        </span>
      ) : (
        "—"
      ),
    },
    {
      label: "Maker share",
      value: makerShare,
      note: t("of volume as the resting order"),
    },
  ];
  return (
    <section className="profile-pnl">
      <article className="profile-pnl-total">
        <span className="card-label">{t("Total P&L")}</span>
        <strong className={tone(total)}>
          {sign(total) > 0 ? "+" : ""}
          {money(total)} <small>{unit}</small>
        </strong>
        <div className="profile-pnl-split">
          <span>
            {t("Realized")}{" "}
            <b className={tone(stats.profit)}>{money(stats.profit)}</b>
          </span>
          <span>
            {t("Unrealized")}{" "}
            <b className={tone(stats.unrealized)}>{money(stats.unrealized)}</b>
          </span>
        </div>
      </article>
      <div className="profile-stats">
        {cards.map((c) => (
          <article key={c.label}>
            <span className="card-label">{t(c.label)}</span>
            <strong>{c.value}</strong>
            {c.note && <small>{c.note}</small>}
          </article>
        ))}
      </div>
    </section>
  );
}
