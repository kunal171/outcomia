"use client";
import { useEffect, useState } from "react";
import { useI18n } from "../preferences-provider";
import { combinePnl, type PnlRow, type Price } from "../../lib/prices/usd";

/** "$1.50" or "-$1.50" from a signed 2-decimal string. */
function dollars(value: string) {
  return value.startsWith("-") ? `-$${value.slice(1)}` : `$${value}`;
}

/** Total P&L across every asset and chain, in USD at current prices. Assets
 * without a price are named and left out of the total. */
export function CombinedPnl({ rows }: { rows: PnlRow[] }) {
  const { t } = useI18n();
  const [prices, setPrices] = useState<Record<string, Price> | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const request = new AbortController();
    fetch("/api/prices", { signal: request.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("prices"))))
      .then((body: { prices: Record<string, Price> }) => setPrices(body.prices))
      .catch(() => {
        if (!request.signal.aborted) setFailed(true);
      });
    return () => request.abort();
  }, []);
  if (rows.length === 0 || failed) return null;
  if (!prices)
    return (
      <p role="status" className="profile-footnote">
        {t("Loading…")}
      </p>
    );
  const result = combinePnl(rows, prices);
  return (
    <section className="profile-combined" aria-label={t("Total P&L")}>
      <span className="card-label">{t("Total P&L")}</span>
      <strong className={result.totalUsd.startsWith("-") ? "lb-down" : "lb-up"}>
        {dollars(result.totalUsd)}
      </strong>
      <small>
        {result.priced.map((r) => `${r.label} ${dollars(r.usd)}`).join(" · ")}
      </small>
      {result.unpriced.length > 0 && (
        <small>
          {t("Not priced, left out: {value0}", {
            value0: result.unpriced.map((r) => r.label).join(", "),
          })}
        </small>
      )}
      <small>
        {t(
          "Realized plus unrealized P&L at current USD prices (Pyth); test stablecoins count as one dollar.",
        )}
      </small>
    </section>
  );
}
