"use client";
import { LegacyBalanceTransfer } from "./legacy-balance-transfer";
import {
  PREDICTION_RESOLUTION_ENABLED,
  SHARED_BALANCES_ENABLED,
} from "../lib/shared";
import { SharedAssetFunds } from "./shared-wallet";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { BN } from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { AppHeader } from "./app-header";
import { accountExplorerUrl, TOKEN_PROGRAM_ID } from "../lib/tidebook";
import { marketLabels, readableAmount } from "../lib/market-display";
import { rpcErrorMessage } from "../lib/rpc-transport";
import {
  loadWalletOverview,
  walletAssetRows,
  type WalletOverview,
  type ReadResult,
} from "../lib/wallet-overview";

function short(key: PublicKey) {
  const value = key.toBase58();
  return `${value.slice(0, 6)}…${value.slice(-6)}`;
}
function value(amount: BN | null, decimals: number, symbol?: string) {
  return amount === null
    ? "—"
    : `${readableAmount(amount, decimals)}${symbol ? ` ${symbol}` : ""}`;
}
function ReadError({
  label,
  result,
}: {
  label: string;
  result: ReadResult<unknown>;
}) {
  return result.error ? (
    <div className="wallet-read-error" role="alert">
      <strong>{label} unavailable</strong>
      <span>{result.error}</span>
    </div>
  ) : null;
}

/** A read-only view. Identity changes invalidate old responses before any balances render. */
export function WalletWorkspace() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [mounted, setMounted] = useState(false);
  const [snapshot, setSnapshot] = useState<WalletOverview | null>(null);
  const [pending, setPending] = useState(false);
  const [revision, setRevision] = useState(0);
  const [fatal, setFatal] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hideEmpty, setHideEmpty] = useState(true);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const owner = mounted ? (publicKey?.toBase58() ?? null) : null;
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    let canceled = false;
    setSnapshot(null);
    setFatal(null);
    setCopied(false);
    setCopyError(false);
    setQuery("");
    if (!owner) {
      setPending(false);
      return;
    }
    setPending(true);
    void loadWalletOverview(connection, new PublicKey(owner))
      .then((result) => {
        if (!canceled) setSnapshot(result);
      })
      .catch((cause) => {
        if (!canceled)
          setFatal(rpcErrorMessage(cause, "Unable to load your wallet"));
      })
      .finally(() => {
        if (!canceled) setPending(false);
      });
    return () => {
      canceled = true;
    };
  }, [connection, owner, revision]);
  const data = snapshot?.owner.toBase58() === owner ? snapshot : null;
  const assets = useMemo(() => (data ? walletAssetRows(data) : []), [data]);
  const visibleAssets = assets.filter((row) => {
    if (
      query &&
      !`${row.symbol} ${row.mint.toBase58()}`
        .toLowerCase()
        .includes(query.trim().toLowerCase())
    )
      return false;
    return (
      !hideEmpty ||
      row.precisionIssue ||
      [row.wallet, row.available, row.inOrders].some(
        (amount) => amount === null || !amount.isZero(),
      )
    );
  });
  const tokenCount =
    data && data.tokens.data !== null && data.catalog.data !== null
      ? assets.filter((row) => row.wallet?.gtn(0)).length
      : null;
  const marketCount =
    data?.spot.data && data.predictions.data
      ? data.spot.data.length + data.predictions.data.length
      : null;
  const depositsComplete =
    data &&
    data.spot.data !== null &&
    data.predictions.data !== null &&
    [...data.spot.data, ...data.predictions.data].every(
      (row) => row.market !== null,
    );
  async function copyAddress() {
    if (!owner) return;
    try {
      await navigator.clipboard.writeText(owner);
      setCopied(true);
      setCopyError(false);
    } catch {
      setCopyError(true);
    }
  }
  return (
    <div className="app-shell">
      <AppHeader />
      <main className="route-shell wallet-workspace">
        <div className="wallet-page-heading">
          <div className="route-heading">
            <span className="eyebrow">Your assets</span>
            <h1>Wallet</h1>
            <p>What’s in your wallet. What’s working on Tidebook.</p>
          </div>
          <button
            className="admin-action-button"
            type="button"
            disabled={!owner || pending}
            onClick={() => setRevision((n) => n + 1)}
          >
            {pending ? "Refreshing…" : "Refresh balances"}
          </button>
        </div>
        {!owner ? (
          <div className="access-card wallet-connect">
            <h2>Connect to see your balances</h2>
            <p>
              Use the wallet button above. No signature is needed to view your
              assets.
            </p>
          </div>
        ) : (
          <>
            <div className="wallet-address-bar">
              <span className="wallet-network-tag">Devnet</span>
              <code>{short(new PublicKey(owner))}</code>
              <button
                type="button"
                className="text-button"
                onClick={() => void copyAddress()}
              >
                {copied ? "Copied" : "Copy address"}
              </button>
              <a
                href={accountExplorerUrl(new PublicKey(owner))}
                target="_blank"
                rel="noreferrer"
              >
                Explorer ↗
              </a>
              {data && (
                <span className="wallet-updated">
                  Updated {new Date(data.readAt).toLocaleTimeString()}
                </span>
              )}
            </div>
            {copyError && (
              <p className="wallet-muted" role="status">
                Copy unavailable. Open Explorer to view the full address.
              </p>
            )}
            {fatal && (
              <div className="access-card access-denied" role="alert">
                {fatal}
              </div>
            )}
            <section
              className="wallet-summary"
              aria-label="Wallet summary"
              aria-busy={pending}
            >
              <article>
                <span className="card-label">SOL in wallet</span>
                <strong>
                  {value(data?.sol.data ?? null, 9)} <small>SOL</small>
                </strong>
                <p>Native balance for transactions and rent.</p>
              </article>
              <article>
                <span className="card-label">Tokens in wallet</span>
                <strong>
                  {tokenCount ?? "—"} <small>assets</small>
                </strong>
                <p>Tidebook-listed assets across your token accounts.</p>
              </article>
              <article>
                <span className="card-label">Tidebook accounts</span>
                <strong>
                  {marketCount ?? "—"} <small>markets</small>
                </strong>
                <p>Market balances and prediction positions.</p>
              </article>
            </section>
            {data && (
              <div className="wallet-errors">
                {data.shared && (
                  <details className="admin-card">
                    <summary>Deposit or withdraw shared assets</summary>
                    {assets.map((a) => (
                      <SharedAssetFunds
                        key={a.mint.toBase58()}
                        mint={a.mint}
                        decimals={a.decimals}
                        symbol={a.symbol}
                        onChanged={() => setRevision((v) => v + 1)}
                      />
                    ))}
                  </details>
                )}
                <ReadError label="SOL balance" result={data.sol} />
                <ReadError label="SPL token balances" result={data.tokens} />
                <ReadError
                  label="Tidebook asset listings"
                  result={data.catalog}
                />
                {data.shared && (
                  <ReadError label="Shared assets" result={data.shared} />
                )}
                <ReadError label="Spot deposits" result={data.spot} />
                <ReadError
                  label="Prediction positions"
                  result={data.predictions}
                />
              </div>
            )}
            <section
              className="admin-card wallet-assets"
              aria-labelledby="wallet-assets-title"
              aria-busy={pending}
            >
              <div className="wallet-section-heading">
                <div>
                  <span className="eyebrow">By asset</span>
                  <h2 id="wallet-assets-title">Your Tidebook assets</h2>
                </div>
                <Link className="text-button" href="/orders">
                  Manage spot orders →
                </Link>
              </div>
              <p className="wallet-muted">
                Only assets listed in Tidebook markets are shown. Deposits stay
                visible even if your wallet balance is zero. YES/NO contracts
                are listed separately below.
              </p>
              <div className="wallet-asset-controls">
                <label className="wallet-search-label">
                  Find an asset
                  <input
                    type="search"
                    placeholder="Symbol or mint address"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </label>
                <label className="wallet-hide-empty">
                  <input
                    type="checkbox"
                    checked={hideEmpty}
                    onChange={(e) => setHideEmpty(e.target.checked)}
                  />{" "}
                  Hide empty assets
                </label>
              </div>
              {data?.catalog.error && (
                <p className="wallet-incomplete" role="status">
                  Market listings could not be fully checked. Only assets
                  verified through your existing Tidebook accounts are shown.
                </p>
              )}
              {data && !depositsComplete && (
                <p className="wallet-incomplete" role="status">
                  Some market balances or token units are unavailable. Tidebook
                  totals are hidden until all market balances can be read.
                </p>
              )}
              {!data ? (
                <p className="wallet-empty" role="status">
                  {pending
                    ? "Reading confirmed balances…"
                    : "Balances are unavailable. Try refreshing."}
                </p>
              ) : visibleAssets.length === 0 ? (
                <p className="wallet-empty">
                  {query
                    ? "No assets match your search."
                    : "No held or deposited Tidebook assets to show. Turn off “Hide empty assets” to include empty listed token accounts."}
                </p>
              ) : (
                <div
                  className="wallet-table-scroll"
                  role="region"
                  aria-label="Asset balances"
                  tabIndex={0}
                >
                  <table className="wallet-assets-table">
                    <thead>
                      <tr>
                        <th scope="col">Asset / mint</th>
                        <th scope="col">In wallet</th>
                        <th scope="col">Tidebook available</th>
                        <th scope="col">In orders</th>
                        <th scope="col">Tidebook total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleAssets.map((row) => (
                        <tr key={`${row.tokenProgram}:${row.mint}`}>
                          <th scope="row">
                            <strong>{row.symbol}</strong>
                            <a
                              href={accountExplorerUrl(row.mint)}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {short(row.mint)} ↗
                            </a>
                            {row.labelConflict && (
                              <small>Market labels differ; verify mint</small>
                            )}
                            {!row.tokenProgram.equals(TOKEN_PROGRAM_ID) && (
                              <small>Token-2022 · display only</small>
                            )}
                          </th>
                          {row.precisionIssue ? (
                            <td colSpan={4}>
                              Conflicting token units. Refresh before managing
                              funds.
                            </td>
                          ) : (
                            <>
                              <td>
                                {value(row.wallet, row.decimals)}
                                {row.frozen.gtn(0) && (
                                  <small>
                                    {value(row.frozen, row.decimals)} frozen
                                  </small>
                                )}
                                <small>
                                  {row.accountCount} token account
                                  {row.accountCount === 1 ? "" : "s"}
                                </small>
                              </td>
                              <td>{value(row.available, row.decimals)}</td>
                              <td
                                className={
                                  row.inOrders?.gtn(0) ? "wallet-locked" : ""
                                }
                              >
                                {value(row.inOrders, row.decimals)}
                              </td>
                              <td>
                                {value(
                                  row.available && row.inOrders
                                    ? row.available.add(row.inOrders)
                                    : null,
                                  row.decimals,
                                )}
                              </td>
                            </>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="wallet-table-note">
                Amounts are token units, not a combined dollar value. Tidebook
                total = available + in orders; it excludes outcome contracts and
                collateral backing them. Wallet balances include any frozen
                tokens.
              </p>
            </section>
            <section
              className="wallet-market-section"
              aria-labelledby="spot-balances-title"
            >
              <div className="wallet-section-heading">
                <div>
                  <span className="eyebrow">Deposited assets</span>
                  <h2 id="spot-balances-title">
                    {SHARED_BALANCES_ENABLED
                      ? "Legacy spot deposits"
                      : "Spot market balances"}
                  </h2>
                </div>
                <Link className="text-button" href="/markets">
                  Explore spot →
                </Link>
              </div>
              {!data || data.spot.error ? (
                <p className="wallet-empty">
                  {pending
                    ? "Loading spot balances…"
                    : "Spot balances could not be loaded."}
                </p>
              ) : data.spot.data?.length === 0 ? (
                <p className="wallet-empty">
                  No spot market balance accounts yet. Open a market to deposit
                  your first assets.
                </p>
              ) : (
                <div className="wallet-market-grid">
                  {data.spot.data?.map((item) => {
                    const { balance, market, metadata } = item;
                    const labels = market
                      ? marketLabels(market, metadata)
                      : null;
                    return (
                      <article
                        className="admin-card wallet-market-card"
                        key={item.address.toBase58()}
                      >
                        <span className="card-label">Spot</span>
                        <h3>{labels?.name ?? short(balance.market)}</h3>
                        <a
                          className="wallet-market-address"
                          href={accountExplorerUrl(balance.market)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {short(balance.market)} ↗
                        </a>
                        {market && labels ? (
                          <dl className="wallet-market-numbers">
                            {[
                              [
                                `${labels.base} available`,
                                value(balance.baseFree, market.baseDecimals),
                              ],
                              [
                                `${labels.base} in orders`,
                                value(balance.baseLocked, market.baseDecimals),
                              ],
                              [
                                `${labels.quote} available`,
                                value(balance.quoteFree, market.quoteDecimals),
                              ],
                              [
                                `${labels.quote} in orders`,
                                value(
                                  balance.quoteLocked,
                                  market.quoteDecimals,
                                ),
                              ],
                            ].map(([label, amount], index) => (
                              <div key={`${index}-${label}`}>
                                <dt>{label}</dt>
                                <dd>{amount}</dd>
                              </div>
                            ))}
                          </dl>
                        ) : (
                          <p className="wallet-incomplete">{item.issue}</p>
                        )}
                        {market && labels && (
                          <>
                            <LegacyBalanceTransfer
                              market={balance.market}
                              mint={market.baseMint}
                              amount={balance.baseFree}
                              symbol={labels.base}
                              kind="spot"
                              onChanged={() => setRevision((v) => v + 1)}
                            />
                            <LegacyBalanceTransfer
                              market={balance.market}
                              mint={market.quoteMint}
                              amount={balance.quoteFree}
                              symbol={labels.quote}
                              kind="spot"
                              onChanged={() => setRevision((v) => v + 1)}
                            />
                          </>
                        )}
                        <Link
                          className="market-open-link"
                          href={`/markets/${balance.market.toBase58()}#balances`}
                        >
                          Deposit / withdraw →
                        </Link>
                      </article>
                    );
                  })}
                </div>
              )}
            </section>
            <section
              className="wallet-market-section"
              aria-labelledby="prediction-balances-title"
            >
              <div className="wallet-section-heading">
                <div>
                  <span className="eyebrow">Collateral & contracts</span>
                  <h2 id="prediction-balances-title">Prediction positions</h2>
                </div>
                <Link className="text-button" href="/predictions">
                  Explore predictions →
                </Link>
              </div>
              <p className="wallet-muted">
                Contract counts are not cash balances. Merge an available YES/NO
                pair to recover its collateral.{" "}
                {PREDICTION_RESOLUTION_ENABLED
                  ? "After final resolution, redeem free contracts on the market page."
                  : "Resolution and claims require the next program upgrade."}
              </p>
              {!data || data.predictions.error ? (
                <p className="wallet-empty">
                  {pending
                    ? "Loading prediction positions…"
                    : "Prediction positions could not be loaded."}
                </p>
              ) : data.predictions.data?.length === 0 ? (
                <p className="wallet-empty">
                  No prediction positions yet. Open a prediction market to
                  initialize one.
                </p>
              ) : (
                <div className="wallet-market-grid">
                  {data.predictions.data?.map((item) => {
                    const { balance, market, metadata } = item;
                    const symbol = metadata?.quoteSymbol ?? "Collateral";
                    const decimals = market
                      ? market.payoutPerContract.toString().length - 1
                      : null;
                    return (
                      <article
                        className="admin-card wallet-market-card"
                        key={item.address.toBase58()}
                      >
                        <span className="card-label">Prediction</span>
                        <h3>
                          {metadata?.displayName ?? short(balance.market)}
                        </h3>
                        <a
                          className="wallet-market-address"
                          href={accountExplorerUrl(balance.market)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {short(balance.market)} ↗
                        </a>
                        {decimals !== null ? (
                          <dl className="wallet-market-numbers">
                            <div>
                              <dt>{symbol} available</dt>
                              <dd>{value(balance.collateralFree, decimals)}</dd>
                            </div>
                            <div>
                              <dt>{symbol} in orders</dt>
                              <dd>
                                {value(balance.collateralLocked, decimals)}
                              </dd>
                            </div>
                            <div className="wallet-yes">
                              <dt>YES contracts</dt>
                              <dd>
                                {value(balance.yesFree, 0)}{" "}
                                <small>
                                  free · {value(balance.yesLocked, 0)} in orders
                                </small>
                              </dd>
                            </div>
                            <div className="wallet-no">
                              <dt>NO contracts</dt>
                              <dd>
                                {value(balance.noFree, 0)}{" "}
                                <small>
                                  free · {value(balance.noLocked, 0)} in orders
                                </small>
                              </dd>
                            </div>
                          </dl>
                        ) : (
                          <p className="wallet-incomplete">{item.issue}</p>
                        )}
                        {market && (
                          <LegacyBalanceTransfer
                            market={balance.market}
                            mint={market.collateralMint}
                            amount={balance.collateralFree}
                            symbol={symbol}
                            kind="prediction"
                            onChanged={() => setRevision((v) => v + 1)}
                          />
                        )}
                        <Link
                          className="market-open-link"
                          href={`/predictions/${balance.market.toBase58()}#position`}
                        >
                          Manage position →
                        </Link>
                      </article>
                    );
                  })}
                </div>
              )}
            </section>
            <p className="wallet-footnote">
              Confirmed RPC reads may span different slots. Refresh after a
              deposit, withdrawal or trade. Transfers require your wallet
              signature; reading balances does not.
            </p>
          </>
        )}
      </main>
    </div>
  );
}
