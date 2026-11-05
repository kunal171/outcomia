"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useConnection } from "@solana/wallet-adapter-react";
import {
  accountExplorerUrl,
  decodeMarketKind,
  decodeMarketStatus,
  getTidebookAccounts,
  getTidebookReadProgram,
  type MarketMetadataAccount,
  type MarketView,
} from "../lib/tidebook";
import { AppHeader } from "./app-header";
import { marketLabels, readableAmount } from "../lib/market-display";
import { rpcErrorMessage } from "../lib/rpc-transport";

function shortAddress(value: string) {
  return `${value.slice(0, 6)}…${value.slice(-6)}`;
}

function getErrorMessage(cause: unknown) {
  return rpcErrorMessage(cause, "Unable to load markets");
}

export function Markets() {
  const { connection } = useConnection();
  const [markets, setMarkets] = useState<MarketView[]>([]);
  const [metadataByMarket, setMetadataByMarket] = useState<
    Map<string, MarketMetadataAccount>
  >(() => new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [labelNotice, setLabelNotice] = useState<string | null>(null);

  const program = useMemo(
    () => getTidebookReadProgram(connection),
    [connection],
  );

  const loadMarkets = useCallback(async () => {
    setLoading(true);
    setError(null);
    setLabelNotice(null);

    try {
      const accounts = getTidebookAccounts(program);
      const [marketRead, metadataRead] = await Promise.allSettled([
        accounts.market.all(),
        accounts.marketMetadata.all(),
      ]);
      if (marketRead.status === "rejected") throw marketRead.reason;
      const records = marketRead.value;
      const metadataRecords =
        metadataRead.status === "fulfilled" ? metadataRead.value : [];
      if (metadataRead.status === "rejected")
        setLabelNotice(
          "Market names could not be refreshed. Known test-token labels are shown where available.",
        );
      setMetadataByMarket(
        new Map(
          metadataRecords.map(({ account }) => [
            account.market.toBase58(),
            account,
          ]),
        ),
      );
      setMarkets(
        records
          .map(({ publicKey, account }) => ({
            address: publicKey,
            ...account,
          }))
          .sort((left, right) => {
            const leftStatus = decodeMarketStatus(left.status);
            const rightStatus = decodeMarketStatus(right.status);

            if (leftStatus !== rightStatus) {
              return leftStatus === "active" ? -1 : 1;
            }

            return left.address
              .toBase58()
              .localeCompare(right.address.toBase58());
          }),
      );
    } catch (cause) {
      setError(getErrorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [program]);

  useEffect(() => {
    void loadMarkets();
  }, [loadMarkets]);

  const activeCount = markets.filter(
    (market) => decodeMarketStatus(market.status) === "active",
  ).length;

  return (
    <div className="app-shell">
      <AppHeader />

      <main className="route-shell">
        <div className="route-heading markets-heading">
          <div>
            <div className="eyebrow">Market discovery</div>
            <h1>Markets</h1>
            <p>
              Explore Tidebook markets without connecting a wallet. Active
              markets can accept new orders; paused markets remain visible for
              inspection and cancellation.
            </p>
          </div>

          <div className="market-summary" aria-label="Market summary">
            <strong>
              {markets.length === 0 && (loading || error) ? "—" : activeCount}
            </strong>
            <span>
              {markets.length === 0 && error
                ? "Status unavailable"
                : loading && !markets.length
                  ? "Loading markets"
                  : `Active of ${markets.length}`}
            </span>
          </div>
        </div>

        <div className="market-list-heading">
          <h2>On-chain markets</h2>
          <button
            className="text-button"
            type="button"
            disabled={loading}
            onClick={() => void loadMarkets()}
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>

        {loading && markets.length === 0 && (
          <div className="access-card">Loading markets…</div>
        )}

        {!loading && !error && markets.length === 0 && (
          <div className="access-card">No markets have been created yet.</div>
        )}
        {labelNotice && (
          <p className="order-book-note" role="status">
            {labelNotice}
          </p>
        )}

        <section className="markets-grid" aria-live="polite">
          {markets.map((market) => {
            const status = decodeMarketStatus(market.status);
            const metadata = metadataByMarket.get(market.address.toBase58());
            const kind = metadata ? decodeMarketKind(metadata.kind) : null;
            const labels = marketLabels(market, metadata);

            return (
              <article className="market-card" key={market.address.toBase58()}>
                <div className="market-card-heading">
                  <div>
                    <span className="card-label">
                      {kind ? `${kind} market` : "Spot market"}
                    </span>
                    <strong>{labels.name}</strong>
                    <small className="market-address-caption">
                      {shortAddress(market.address.toBase58())}
                    </small>
                  </div>
                  <span className={`role-badge market-${status}`}>
                    {status}
                  </span>
                </div>

                <div className="market-pair">
                  <div>
                    <span>Trading</span>
                    <strong>{labels.base}</strong>
                    <small>{shortAddress(market.baseMint.toBase58())}</small>
                  </div>
                  <span aria-hidden="true">/</span>
                  <div>
                    <span>Priced in</span>
                    <strong>{labels.quote}</strong>
                    <small>{shortAddress(market.quoteMint.toBase58())}</small>
                  </div>
                </div>

                <dl className="market-metadata">
                  <div>
                    <dt>Authority</dt>
                    <dd>{shortAddress(market.authority.toBase58())}</dd>
                  </div>
                  <div>
                    <dt>Next order</dt>
                    <dd>#{market.nextOrderId.toString()}</dd>
                  </div>
                  <div>
                    <dt>Open orders</dt>
                    <dd>{market.openOrderCount.toString()}</dd>
                  </div>
                  <div>
                    <dt>Price step</dt>
                    <dd>
                      {readableAmount(
                        market.priceTickSize,
                        market.quoteDecimals,
                      )}{" "}
                      {labels.quote}
                    </dd>
                  </div>
                  <div>
                    <dt>Order size step</dt>
                    <dd>
                      {readableAmount(
                        market.quantityLotSize,
                        market.baseDecimals,
                      )}{" "}
                      {labels.base}
                    </dd>
                  </div>
                  <div>
                    <dt>Highest buy price</dt>
                    <dd>
                      {market.bestBid
                        ? `${readableAmount(market.bestBid, market.quoteDecimals)} ${labels.quote}`
                        : "No buy orders"}
                    </dd>
                  </div>
                  <div>
                    <dt>Lowest sell price</dt>
                    <dd>
                      {market.bestAsk
                        ? `${readableAmount(market.bestAsk, market.quoteDecimals)} ${labels.quote}`
                        : "No sell orders"}
                    </dd>
                  </div>
                </dl>

                <div className="market-card-actions">
                  <Link
                    className="market-open-link"
                    href={`/markets/${market.address.toBase58()}`}
                  >
                    {status === "active" ? "Open market" : "View details"}
                  </Link>
                  <a
                    className="market-explorer-link"
                    href={accountExplorerUrl(market.address)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Explorer ↗
                  </a>
                </div>
              </article>
            );
          })}
        </section>

        {error && (
          <div className="transaction-message transaction-error">{error}</div>
        )}
      </main>
    </div>
  );
}
