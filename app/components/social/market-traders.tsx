"use client";
import { useI18n } from "../preferences-provider";
import { INDEXER_ENABLED } from "../../lib/graphql/client";
import { getMarketTraders } from "../../lib/graphql/social";
import { formatAtoms, TraderName, useQuietData } from "./social-ui";

/** "Top traders" tab on a prediction market: who traded it most, what they
 * hold now and, once resolved, what they made. */
export function MarketTraders({
  market,
  decimals,
  symbol,
}: {
  market: string;
  decimals: number;
  symbol: string;
}) {
  const { t } = useI18n();
  const rows = useQuietData(() => getMarketTraders(market, 50), [market]);
  if (!INDEXER_ENABLED)
    return (
      <p className="lb-empty">
        {t("Top traders need the indexer, which is off in this deployment.")}
      </p>
    );
  if (rows.error && !rows.data)
    return (
      <p role="alert">{t("Top traders could not load. Try again shortly.")}</p>
    );
  if (!rows.data) return <p role="status">{t("Loading…")}</p>;
  if (rows.data.length === 0)
    return <p className="lb-empty">{t("No trades in this market yet.")}</p>;
  const resolved = rows.data.some((r) => r.profit !== null);
  return (
    <div className="lb-table-wrap market-traders">
      <table className="lb-table">
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">{t("Trader")}</th>
            <th scope="col" className="lb-num">
              {t("Volume")}
            </th>
            <th scope="col" className="lb-num">
              {resolved ? t("Profit") : t("Holding")}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.data.map((r) => (
            <tr key={r.wallet}>
              <td className="lb-rank">{r.rank}</td>
              <td>
                <TraderName wallet={r.wallet} profile={r.profile} />
              </td>
              <td className="lb-num">
                {formatAtoms(r.volume, decimals)}
                <small> {symbol}</small>
              </td>
              <td className="lb-num">
                {resolved ? (
                  <span
                    className={Number(r.profit ?? 0) >= 0 ? "lb-up" : "lb-down"}
                  >
                    {formatAtoms(r.profit ?? "0", decimals)}
                    <small> {symbol}</small>
                  </span>
                ) : r.holdings.length === 0 ? (
                  "—"
                ) : (
                  r.holdings
                    .map(
                      (h) =>
                        `${Number(h.contracts).toLocaleString()} ${h.label ?? h.outcome}`,
                    )
                    .join(" · ")
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
