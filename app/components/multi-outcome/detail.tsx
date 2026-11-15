"use client";
import Link from "next/link";
import { AppHeader } from "../app-header";
import { transactionExplorerUrl } from "../../lib/outcomia";
import { readableAmount } from "../../lib/market-display";
import { MULTI_OUTCOME_ENABLED, statusOf } from "../../lib/multi-outcome";
import { useMultiMarket } from "./use-market";
import { SharedAssetFunds } from "../shared-wallet";
import { MultiTrading } from "./trading";
import { MultiPositions } from "./positions";
import { MultiFees } from "./fees";
import { MultiResolution } from "./resolution";
import "./multi-outcome.css";
export function MultiOutcomeDetail({ address }: { address: string }) {
  const s = useMultiMarket(address),
    d = s.data;
  return (
    <div className="app-shell">
      <AppHeader />
      <main className="route-shell multi-outcome">
        <Link href="/predictions/multi">← Multi-outcome markets</Link>
        <h1>{d?.metadata?.displayName ?? "Multi-outcome market"}</h1>
        {!MULTI_OUTCOME_ENABLED && (
          <p role="status">
            Multi-outcome trading is awaiting deployment verification on devnet.
          </p>
        )}
        <button
          onClick={() => void s.refresh()}
          disabled={!MULTI_OUTCOME_ENABLED || s.busy || s.loading}
        >
          Refresh
        </button>
        {s.loading && <p role="status">Refreshing market…</p>}
        {s.error && <p role="alert">{s.error}</p>}
        {s.signature && (
          <p role="status">
            Confirmed:{" "}
            <a
              href={transactionExplorerUrl(s.signature)}
              target="_blank"
              rel="noreferrer"
            >
              View transaction
            </a>
          </p>
        )}
        {d && (
          <>
            <p>
              {statusOf(d.market)} · Face payout{" "}
              {readableAmount(d.market.terms.payoutPerContract, d.decimals)}{" "}
              {d.metadata?.quoteSymbol} · Minimum{" "}
              {d.market.terms.quantityLot.toString()} contracts
            </p>
            <MultiTrading session={s} />
            <details>
              <summary>Deposit or withdraw collateral</summary>
              <SharedAssetFunds
                mint={d.market.collateralMint}
                decimals={d.decimals}
                symbol={d.metadata?.quoteSymbol ?? "collateral"}
                onChanged={() => void s.refresh()}
              />
            </details>
            <MultiPositions session={s} />
            <MultiResolution session={s} />
            <MultiFees session={s} />
            <details>
              <summary>Market details</summary>
              <p>
                Market: <code>{address}</code>
              </p>
              <p>
                Resolver: <code>{d.market.terms.resolver.toBase58()}</code>
              </p>
              <p>
                Close:{" "}
                {new Date(
                  d.market.terms.closeTs.toNumber() * 1000,
                ).toLocaleString()}
              </p>
              <p>
                Review delay: {d.market.terms.resolutionDelaySeconds.toString()}{" "}
                seconds
              </p>
              <p>
                Reserve: {readableAmount(d.market.backingReserve, d.decimals)}
              </p>
            </details>
          </>
        )}
      </main>
    </div>
  );
}
