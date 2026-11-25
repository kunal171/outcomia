"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { AppHeader } from "../app-header";
import { useI18n } from "../preferences-provider";
import { INDEXER_ENABLED } from "../../lib/graphql/client";
import {
  getBestCalls,
  getClubLeaderboard,
  getCreatorLeaderboard,
  getLeaderboardMints,
  getMarketLeaderboard,
  getTraderLeaderboard,
  type MintRow,
  type Period,
  type TraderBoard,
} from "../../lib/graphql/social";
import { formatAtoms, TraderName, tokenLabel, useQuietData } from "./social-ui";

type Board =
  | "traders"
  | "profit"
  | "forecasters"
  | "calls"
  | "markets"
  | "clubs"
  | "creators";
const BOARDS: { id: Board; label: string }[] = [
  { id: "traders", label: "Top traders" },
  { id: "profit", label: "Profit" },
  { id: "forecasters", label: "Forecasters" },
  { id: "calls", label: "Best calls" },
  { id: "markets", label: "Markets" },
  { id: "clubs", label: "Clubs" },
  { id: "creators", label: "Creators" },
];
const PERIODS: { id: Period; label: string }[] = [
  { id: "DAY", label: "24h" },
  { id: "WEEK", label: "7d" },
  { id: "MONTH", label: "30d" },
  { id: "ALL", label: "All time" },
];
const TRADER_VIEWS: { id: TraderBoard; label: string }[] = [
  { id: "VOLUME", label: "Volume" },
  { id: "ACTIVITY", label: "Most active" },
  { id: "MAKERS", label: "Market makers" },
];
/** Settled-market boards are all-time by definition. */
const ALL_TIME: Board[] = ["profit", "forecasters", "calls"];
const MIN_DECIDED = 3;

export function marketHref(kind: string | null | undefined, market: string) {
  return kind === "MULTI"
    ? `/predictions/multi/${market}`
    : kind === "SPOT"
      ? `/markets/${market}`
      : `/predictions/${market}`;
}

export function LeaderboardPage() {
  const { t } = useI18n();
  const [board, setBoard] = useState<Board>("traders");
  const [traderView, setTraderView] = useState<TraderBoard>("VOLUME");
  const [period, setPeriod] = useState<Period>("WEEK");
  const [mint, setMint] = useState<string | null>(null);
  const mints = useQuietData(
    (signal) => {
      void signal;
      return getLeaderboardMints();
    },
    [],
    30_000,
  );
  const tokens = mints.data?.leaderboardMints ?? [];
  useEffect(() => {
    if (!mint && tokens.length) setMint(tokens[0].mint);
  }, [mint, tokens]);
  const token = tokens.find((m) => m.mint === mint) ?? null;
  const allTime = ALL_TIME.includes(board);

  return (
    <div className="app-shell">
      <AppHeader />
      <main className="route-shell leaderboard-page">
        <div className="route-heading">
          <h1>{t("Leaderboard")}</h1>
          <p>
            {t(
              "Rankings from every indexed trade on devnet. Amounts are per token and never added across tokens.",
            )}
          </p>
        </div>
        {!INDEXER_ENABLED ? (
          <div className="access-card">
            <h2>
              {t(
                "Leaderboards need the indexer, which is off in this deployment.",
              )}
            </h2>
          </div>
        ) : (
          <>
            <div
              className="lb-boards"
              role="tablist"
              aria-label={t("Leaderboard")}
            >
              {BOARDS.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  role="tab"
                  aria-selected={board === b.id}
                  onClick={() => setBoard(b.id)}
                >
                  {t(b.label)}
                </button>
              ))}
            </div>
            <div className="lb-controls">
              {board === "traders" && (
                <div
                  className="lb-chips"
                  role="group"
                  aria-label={t("Ranking")}
                >
                  {TRADER_VIEWS.map((v) => (
                    <button
                      key={v.id}
                      type="button"
                      aria-pressed={traderView === v.id}
                      onClick={() => setTraderView(v.id)}
                    >
                      {t(v.label)}
                    </button>
                  ))}
                </div>
              )}
              {allTime ? (
                <span className="lb-note">
                  {board === "forecasters"
                    ? t(
                        "All time · settled markets · at least {value0} decided",
                        { value0: MIN_DECIDED },
                      )
                    : t("All time · settled markets")}
                </span>
              ) : (
                <div className="lb-chips" role="group" aria-label={t("Period")}>
                  {PERIODS.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      aria-pressed={period === p.id}
                      onClick={() => setPeriod(p.id)}
                    >
                      {t(p.label)}
                    </button>
                  ))}
                </div>
              )}
              <label className="lb-token">
                <span>{t("Token")}</span>
                <select
                  value={mint ?? ""}
                  onChange={(e) => setMint(e.target.value)}
                  disabled={!tokens.length}
                >
                  {tokens.map((m) => (
                    <option key={m.mint} value={m.mint}>
                      {tokenLabel(m.mint, m.symbol)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {mints.error && !tokens.length ? (
              <p role="alert">
                {t(
                  "Leaderboards are unavailable right now. Try again shortly.",
                )}
              </p>
            ) : !mint || !token ? (
              <p role="status">
                {mints.loading ? t("Loading…") : t("No trades yet.")}
              </p>
            ) : (
              <BoardTable
                board={board}
                traderView={traderView}
                period={period}
                token={token}
              />
            )}
            {mints.data?.leaderboardSlot && (
              <p className="lb-asof">
                {t(
                  "As of slot {value0}. Wallets can opt out in their profile.",
                  {
                    value0: Number(mints.data.leaderboardSlot).toLocaleString(),
                  },
                )}
              </p>
            )}
          </>
        )}
      </main>
    </div>
  );
}

function BoardTable({
  board,
  traderView,
  period,
  token,
}: {
  board: Board;
  traderView: TraderBoard;
  period: Period;
  token: MintRow;
}) {
  const { t } = useI18n();
  const decimals = token.decimals ?? 0;
  const symbol = tokenLabel(token.mint, token.symbol);
  const money = (v: string | null) => formatAtoms(v, decimals);
  const kind: TraderBoard =
    board === "profit"
      ? "PROFIT"
      : board === "forecasters"
        ? "ACCURACY"
        : traderView;
  const rows = useQuietData<unknown[]>(() => {
    switch (board) {
      case "traders":
      case "profit":
      case "forecasters":
        return getTraderLeaderboard(kind, period, token.mint, 50);
      case "calls":
        return getBestCalls(token.mint, 50);
      case "markets":
        return getMarketLeaderboard(period, token.mint, 50);
      case "clubs":
        return getClubLeaderboard(period, token.mint, 50);
      default:
        return getCreatorLeaderboard(period, token.mint, 50);
    }
  }, [board, kind, period, token.mint]);
  if (rows.error && !rows.data)
    return (
      <p role="alert">
        {t("This leaderboard could not load. Try again shortly.")}
      </p>
    );
  if (!rows.data) return <p role="status">{t("Loading…")}</p>;
  if (rows.data.length === 0)
    return (
      <p className="lb-empty">
        {ALL_TIME.includes(board)
          ? t(
              "No settled {value0} markets to rank yet. Results appear once markets resolve.",
              { value0: symbol },
            )
          : t("Nothing to rank for {value0} in this period yet.", {
              value0: symbol,
            })}
      </p>
    );
  const head = (cells: string[]) => (
    <thead>
      <tr>
        {cells.map((c, i) => (
          <th key={c} scope="col" className={i > 1 ? "lb-num" : undefined}>
            {t(c)}
          </th>
        ))}
      </tr>
    </thead>
  );
  const unit = <small> {symbol}</small>;

  if (board === "traders" || board === "profit" || board === "forecasters") {
    const data = rows.data as Awaited<ReturnType<typeof getTraderLeaderboard>>;
    return (
      <div className="lb-table-wrap">
        <table className="lb-table">
          {board === "profit"
            ? head(["#", "Trader", "Profit", "Return", "Won – lost"])
            : board === "forecasters"
              ? head(["#", "Trader", "Win rate", "Won – lost", "Profit"])
              : kind === "MAKERS"
                ? head([
                    "#",
                    "Trader",
                    "Maker volume",
                    "Total volume",
                    "Trades",
                  ])
                : kind === "ACTIVITY"
                  ? head(["#", "Trader", "Trades", "Markets", "Volume"])
                  : head(["#", "Trader", "Volume", "Trades", "Markets"])}
          <tbody>
            {data.map((r) => {
              const decided = (r.wins ?? 0) + (r.losses ?? 0);
              const ret =
                r.invested && r.invested !== "0" && r.profit
                  ? `${((Number(r.profit) / Number(r.invested)) * 100).toFixed(1)}%`
                  : "—";
              const cells =
                board === "profit"
                  ? [
                      <span
                        key="p"
                        className={Number(r.profit) >= 0 ? "lb-up" : "lb-down"}
                      >
                        {money(r.profit)}
                        {unit}
                      </span>,
                      ret,
                      `${r.wins ?? 0} – ${r.losses ?? 0}`,
                    ]
                  : board === "forecasters"
                    ? [
                        decided
                          ? `${Math.round(((r.wins ?? 0) / decided) * 100)}%`
                          : "—",
                        `${r.wins ?? 0} – ${r.losses ?? 0}`,
                        <span
                          key="p"
                          className={
                            Number(r.profit) >= 0 ? "lb-up" : "lb-down"
                          }
                        >
                          {money(r.profit)}
                          {unit}
                        </span>,
                      ]
                    : kind === "MAKERS"
                      ? [
                          <span key="m">
                            {money(r.makerVolume)}
                            {unit}
                          </span>,
                          money(r.volume),
                          String(r.trades ?? 0),
                        ]
                      : kind === "ACTIVITY"
                        ? [
                            String(r.trades ?? 0),
                            String(r.markets ?? 0),
                            money(r.volume),
                          ]
                        : [
                            <span key="v">
                              {money(r.volume)}
                              {unit}
                            </span>,
                            String(r.trades ?? 0),
                            String(r.markets ?? 0),
                          ];
              return (
                <tr key={r.wallet}>
                  <td className="lb-rank">{r.rank}</td>
                  <td>
                    <TraderName wallet={r.wallet} profile={r.profile} />
                  </td>
                  {cells.map((c, i) => (
                    <td key={i} className="lb-num">
                      {c}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }
  if (board === "calls") {
    const data = rows.data as Awaited<ReturnType<typeof getBestCalls>>;
    return (
      <div className="lb-table-wrap">
        <table className="lb-table">
          {head([
            "#",
            "Trader",
            "Call",
            "Entry → payout",
            "Multiple",
            "Profit",
          ])}
          <tbody>
            {data.map((r) => (
              <tr key={`${r.signature}:${r.wallet}:${r.rank}`}>
                <td className="lb-rank">{r.rank}</td>
                <td>
                  <TraderName wallet={r.wallet} profile={r.profile} />
                </td>
                <td className="lb-num lb-call">
                  <Link href={marketHref(r.kind, r.market)}>
                    {r.title ?? t("Prediction market")}
                  </Link>
                  <small>
                    {t("{value0} contracts of {value1}", {
                      value0: Number(r.quantity).toLocaleString(),
                      value1: r.outcomeLabel ?? r.outcome,
                    })}
                  </small>
                </td>
                <td className="lb-num">
                  {formatAtoms(r.price, decimals, 4)} →{" "}
                  {formatAtoms(r.payout, decimals)}
                </td>
                <td className="lb-num">
                  <strong>×{r.multiple}</strong>
                </td>
                <td className="lb-num lb-up">
                  {money(r.profit)}
                  {unit}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (board === "markets") {
    const data = rows.data as Awaited<ReturnType<typeof getMarketLeaderboard>>;
    return (
      <div className="lb-table-wrap">
        <table className="lb-table">
          {head(["#", "Market", "Volume", "Trades", "Traders"])}
          <tbody>
            {data.map((r) => (
              <tr key={r.market}>
                <td className="lb-rank">{r.rank}</td>
                <td>
                  <Link
                    className="lb-market"
                    href={marketHref(r.kind, r.market)}
                  >
                    <span className={`lb-kind lb-kind-${r.kind.toLowerCase()}`}>
                      {r.kind === "MULTI"
                        ? t("Multi-outcome")
                        : r.kind === "SPOT"
                          ? t("Spot")
                          : t("Binary")}
                    </span>
                    {r.title ?? `${r.market.slice(0, 6)}…`}
                  </Link>
                </td>
                <td className="lb-num">
                  {money(r.volume)}
                  {unit}
                </td>
                <td className="lb-num">{r.trades}</td>
                <td className="lb-num">{r.traders}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (board === "clubs") {
    const data = rows.data as Awaited<ReturnType<typeof getClubLeaderboard>>;
    return (
      <div className="lb-table-wrap">
        <table className="lb-table">
          {head(["#", "Club", "Volume", "Markets", "Members"])}
          <tbody>
            {data.map((r) => (
              <tr key={r.club}>
                <td className="lb-rank">{r.rank}</td>
                <td>
                  <Link href={`/clubs/${r.club}`}>
                    {r.name || `${r.club.slice(0, 6)}…`}
                  </Link>
                </td>
                <td className="lb-num">
                  {money(r.volume)}
                  {unit}
                </td>
                <td className="lb-num">{r.markets}</td>
                <td className="lb-num">{r.members}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  const data = rows.data as Awaited<ReturnType<typeof getCreatorLeaderboard>>;
  return (
    <div className="lb-table-wrap">
      <table className="lb-table">
        {head(["#", "Creator", "Volume drawn", "Markets", "Traders"])}
        <tbody>
          {data.map((r) => (
            <tr key={r.wallet}>
              <td className="lb-rank">{r.rank}</td>
              <td>
                <TraderName wallet={r.wallet} profile={r.profile} />
              </td>
              <td className="lb-num">
                {money(r.volume)}
                {unit}
              </td>
              <td className="lb-num">{r.markets}</td>
              <td className="lb-num">{r.traders}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
