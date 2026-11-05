"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { AppHeader } from "./app-header";
import { PredictionPositionPanel } from "./prediction-position";
import { PredictionLifecycle } from "./prediction-lifecycle";
import { PredictionBook } from "./prediction-book";
import { useProtocolRole } from "./protocol-role-provider";
import {
  predictionStatus,
  predictionTime,
  derivePredictionBookPda,
  type PredictionOrderBookAccount,
  type PredictionMarketAccount,
} from "../lib/prediction";
import {
  accountExplorerUrl,
  getTidebookAccounts,
  getTidebookReadProgram,
  type MarketMetadataAccount,
} from "../lib/tidebook";

type Record = {
  address: PublicKey;
  market: PredictionMarketAccount;
  metadata: MarketMetadataAccount | null;
  book: PredictionOrderBookAccount | null;
};

/** Public discovery and account inspection; RPC failure never becomes an empty book. */
export function PredictionMarkets({ address }: { address?: string }) {
  const { connection } = useConnection();
  const { role, loading: roleLoading } = useProtocolRole();
  const program = useMemo(
    () => getTidebookReadProgram(connection),
    [connection],
  );
  const [records, setRecords] = useState<Record[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [bookRevision, setBookRevision] = useState(0);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let canceled = false;
    setLoading(true);
    setError(null);
    setRecords([]);
    async function load() {
      try {
        const accounts = getTidebookAccounts(program);
        let markets: Array<{
          publicKey: PublicKey;
          account: PredictionMarketAccount;
        }>;
        if (address) {
          const key = new PublicKey(address);
          const account = await accounts.predictionMarket.fetchNullable(key);
          if (!account)
            throw new Error("Prediction market was not found on this network");
          markets = [{ publicKey: key, account }];
        } else {
          markets = await accounts.predictionMarket.all();
        }
        const rows = await Promise.all(
          markets.map(async ({ publicKey, account }) => {
            const [metadata, book] = await Promise.all([
              accounts.marketMetadata.fetchNullable(account.metadata),
              accounts.predictionOrderBook.fetchNullable(
                derivePredictionBookPda(publicKey),
              ),
            ]);
            if (book && !book.market.equals(publicKey))
              throw new Error(
                "Order book belongs to a different prediction market",
              );
            if (metadata && !metadata.market.equals(publicKey))
              throw new Error("Metadata belongs to a different market");
            return { address: publicKey, market: account, metadata, book };
          }),
        );
        if (!canceled)
          setRecords(
            rows.sort((a, b) =>
              a.address.toBase58().localeCompare(b.address.toBase58()),
            ),
          );
      } catch (cause) {
        if (!canceled)
          setError(
            cause instanceof Error
              ? cause.message
              : "Unable to load prediction markets",
          );
      } finally {
        if (!canceled) setLoading(false);
      }
    }
    void load();
    return () => {
      canceled = true;
    };
  }, [program, address, refresh]);

  const isAdmin = !roleLoading && (role === "admin" || role === "super-admin");
  const visibleRecords = records.filter(
    (row) =>
      address ||
      `${row.metadata?.displayName ?? ""} ${row.address.toBase58()}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  return (
    <div className="app-shell">
      <AppHeader />
      <main className="route-shell">
        {address && (
          <Link className="text-button" href="/predictions">
            ← Prediction markets
          </Link>
        )}
        <div className="route-heading">
          <div className="eyebrow">Binary outcomes</div>
          <h1>
            {address
              ? (records[0]?.metadata?.displayName ?? "Prediction market")
              : "Trade your view."}
          </h1>
          <p>
            {address
              ? "Buy and sell YES or NO contracts using one collateral asset. Read the rules before taking a position."
              : "Explore questions with on-chain order books. Choose an outcome, set your price, and trade with other participants."}
          </p>
          <p className="prediction-release-note">
            Prediction trading is in development. Resolution and reward claims
            are not available yet.
          </p>
        </div>
        {!address && (
          <label className="prediction-search">
            Find a market
            <input
              type="search"
              placeholder="Search questions or market addresses"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        )}
        <div className="market-list-heading">
          <h2>{address ? "Market terms" : "On-chain markets"}</h2>
          <div className="admin-actions">
            {isAdmin && (
              <Link className="admin-action-button" href="/predictions/new">
                Create draft
              </Link>
            )}
            <button
              className="text-button"
              type="button"
              disabled={loading}
              onClick={() => setRefresh((value) => value + 1)}
            >
              Refresh
            </button>
          </div>
        </div>
        {loading && (
          <div className="access-card">Loading prediction markets…</div>
        )}
        {error && (
          <div className="access-card access-denied" role="alert">
            {error}
          </div>
        )}
        {!loading && !error && records.length === 0 && (
          <div className="access-card">
            No prediction markets exist on this network yet.
          </div>
        )}
        {!loading &&
          !error &&
          records.length > 0 &&
          visibleRecords.length === 0 && (
            <div className="access-card">No markets match your search.</div>
          )}
        <section
          className={address ? "prediction-detail-grid" : "markets-grid"}
          aria-live="polite"
        >
          {visibleRecords.map(({ address: key, market, metadata }) => {
            const status = predictionStatus(market);
            const decimals = market.payoutPerContract.toString().length - 1;
            const fields = [
              ["Collateral mint", market.collateralMint.toBase58()],
              ["Collateral vault", market.collateralVault.toBase58()],
              ["Creator", market.authority.toBase58()],
              ["Primary resolver", market.resolver.toBase58()],
              ["Trading close", predictionTime(market.closeTs)],
              [
                "Earliest proposal",
                predictionTime(market.earliestResolutionTs ?? market.closeTs),
              ],
              [
                "Review delay",
                `${market.resolutionDelaySeconds.toString()} seconds`,
              ],
              [
                "Fallback resolver",
                market.fallback?.resolver.toBase58() ?? "Not configured",
              ],
              [
                "Fallback activation",
                predictionTime(market.fallback?.availableTs ?? null),
              ],
              [
                "Fallback deadline",
                predictionTime(market.fallback?.deadlineTs ?? null),
              ],
              [
                "Winning payout",
                `1 ${metadata?.quoteSymbol ?? "collateral token"} per contract`,
              ],
              [
                "Question SHA-256",
                Buffer.from(market.questionHash).toString("hex"),
              ],
              ["Rules SHA-256", Buffer.from(market.rulesHash).toString("hex")],
              ["Rules reference", market.rulesUri],
            ];
            return (
              <article className="market-card" key={key.toBase58()}>
                <div className="market-card-heading">
                  <div>
                    <span className="card-label">Prediction · {status}</span>
                    <strong>{metadata?.displayName ?? key.toBase58()}</strong>
                  </div>
                  <span className="role-badge">{status}</span>
                </div>
                <p className="market-address-caption">{key.toBase58()}</p>
                {address ? (
                  <>
                    <div className="prediction-market-summary">
                      <div>
                        <span className="card-label">Trading closes</span>
                        <strong>{predictionTime(market.closeTs)}</strong>
                      </div>
                      <div>
                        <span className="card-label">Winning contract</span>
                        <strong>
                          1 {metadata?.quoteSymbol ?? "collateral token"}
                        </strong>
                      </div>
                      <div>
                        <span className="card-label">Open orders</span>
                        <strong>{market.openOrderCount.toString()}</strong>
                      </div>
                    </div>
                    <details className="prediction-rules">
                      <summary>Market rules &amp; resolution terms</summary>
                      <dl className="market-metadata prediction-terms">
                        {fields.map(([label, value]) => (
                          <div key={label}>
                            <dt>{label}</dt>
                            <dd>{value}</dd>
                          </div>
                        ))}
                      </dl>
                    </details>
                  </>
                ) : (
                  <p>
                    Trading closes {predictionTime(market.closeTs)}. Collateral:{" "}
                    {metadata?.quoteSymbol ?? market.collateralMint.toBase58()}.
                  </p>
                )}
                {address &&
                  (!market.fallback || !market.fallback.deadlineTs) && (
                    <p>
                      No automatic timeout payout is configured. Resolver
                      silence can leave unpaired positions unresolved.
                    </p>
                  )}
                <div className="market-card-actions">
                  {!address && (
                    <Link
                      className="market-open-link"
                      href={`/predictions/${key.toBase58()}`}
                    >
                      View market →
                    </Link>
                  )}
                  <a
                    className="market-explorer-link"
                    href={accountExplorerUrl(key)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View account ↗
                  </a>
                </div>
                {address && (
                  <PredictionBook
                    program={program}
                    market={key}
                    decimals={decimals}
                    symbol={metadata?.quoteSymbol ?? "collateral"}
                    revision={`${refresh}:${bookRevision}`}
                  />
                )}
                {address && (
                  <PredictionLifecycle
                    address={key}
                    market={market}
                    onOpened={(updated) => {
                      setRecords((current) =>
                        current.map((row) =>
                          row.address.equals(key)
                            ? { ...row, market: updated }
                            : row,
                        ),
                      );
                    }}
                  />
                )}
                {address && (
                  <PredictionPositionPanel
                    market={key}
                    collateralMint={market.collateralMint}
                    collateralVault={market.collateralVault}
                    status={status}
                    payoutPerContract={market.payoutPerContract}
                    collateralSymbol={metadata?.quoteSymbol ?? "Collateral"}
                    onOrderPlaced={() => {
                      setBookRevision((value) => value + 1);
                      const accounts = getTidebookAccounts(program);
                      void Promise.all([
                        accounts.predictionMarket.fetchNullable(key),
                        accounts.predictionOrderBook.fetchNullable(
                          derivePredictionBookPda(key),
                        ),
                      ])
                        .then(([updatedMarket, updatedBook]) => {
                          if (
                            !updatedMarket ||
                            !updatedBook ||
                            !updatedBook.market.equals(key)
                          )
                            throw new Error("Updated market/book unavailable");
                          setRecords((current) =>
                            current.map((row) =>
                              row.address.equals(key)
                                ? {
                                    ...row,
                                    market: updatedMarket,
                                    book: updatedBook,
                                  }
                                : row,
                            ),
                          );
                        })
                        .catch(() =>
                          setError(
                            "Order confirmed; refresh to load the updated book.",
                          ),
                        );
                    }}
                  />
                )}
              </article>
            );
          })}
        </section>
      </main>
    </div>
  );
}
