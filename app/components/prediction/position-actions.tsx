"use client";

import { useState } from "react";
import { BN } from "@anchor-lang/core";
import type {
  PredictionMarketAccount,
  PredictionPositionAccount,
} from "../../lib/prediction";
import { SHARED_BALANCES_ENABLED } from "../../lib/shared";
import { readableAmount } from "../../lib/market-display";

export type PositionAction = "split" | "merge" | "redeem";
export interface PositionAmounts {
  quantity?: BN;
  yes?: BN;
  no?: BN;
}
interface Props {
  market: PredictionMarketAccount;
  status: string;
  position: PredictionPositionAccount | null;
  loaded: boolean;
  failed: boolean;
  pending: boolean;
  now: BN;
  symbol: string;
  onAction: (
    action: PositionAction,
    amounts: PositionAmounts,
  ) => Promise<boolean>;
}

function whole(value: string): BN {
  if (!/^\d+$/.test(value)) throw new Error("Use whole contracts");
  const number = new BN(value);
  if (number.bitLength() > 64) throw new Error("Contract count exceeds u64");
  return number;
}

/** Owner actions are separate from resolution authority. Estimates use only free
 * contracts: YES pays yes*payout, NO pays no*payout, Invalid pays (yes+no)*payout/2.
 * Locked contracts must first be canceled; a claim never consumes them implicitly.
 */
export function PredictionPositionActions(props: Props) {
  const { market, status, position, loaded, pending, now, symbol } = props;
  const [quantity, setQuantity] = useState(""),
    [yes, setYes] = useState(""),
    [no, setNo] = useState("");
  const parse = (input: string): BN | null => {
    try {
      return whole(input || "0");
    } catch {
      return null;
    }
  };
  const pairs = parse(quantity),
    y = parse(yes),
    n = parse(no);
  const canRedeem =
    loaded &&
    !!position &&
    !!y &&
    !!n &&
    (y.gtn(0) || n.gtn(0)) &&
    y.lte(position.yesFree) &&
    n.lte(position.noFree);
  const canMerge =
    loaded &&
    !!position &&
    !!pairs &&
    pairs.gtn(0) &&
    pairs.lte(position.yesFree) &&
    pairs.lte(position.noFree);
  const hasFree =
    !!position && (position.yesFree.gtn(0) || position.noFree.gtn(0));
  const decimals = market.payoutPerContract.toString().length - 1;
  const payout =
    position && market.finalOutcome
      ? "yes" in market.finalOutcome
        ? position.yesFree.mul(market.payoutPerContract)
        : "no" in market.finalOutcome
          ? position.noFree.mul(market.payoutPerContract)
          : position.yesFree
              .add(position.noFree)
              .mul(market.payoutPerContract.divn(2))
      : new BN(0);
  async function submit(action: PositionAction, all = false) {
    const amounts =
      action === "redeem"
        ? {
            yes: all && position ? position.yesFree : (y ?? new BN(0)),
            no: all && position ? position.noFree : (n ?? new BN(0)),
          }
        : { quantity: pairs ?? new BN(0) };
    if (await props.onAction(action, amounts)) {
      setQuantity("");
      setYes("");
      setNo("");
    }
  }
  return (
    <div className="prediction-position-actions">
      {!loaded ? (
        <p className="prediction-empty-copy">
          {props.failed
            ? "Your position is unavailable."
            : "Loading your contracts…"}
        </p>
      ) : !position ? (
        <p className="prediction-empty-copy">No contracts in this market.</p>
      ) : (
        <div className="prediction-contract-balances">
          <div>
            <span>YES contracts</span>
            <strong>{position.yesFree.toString()}</strong>
            <small>{position.yesLocked.toString()} in orders</small>
          </div>
          <div>
            <span>NO contracts</span>
            <strong>{position.noFree.toString()}</strong>
            <small>{position.noLocked.toString()} in orders</small>
          </div>
        </div>
      )}
      {position && (position.yesLocked.gtn(0) || position.noLocked.gtn(0)) && (
        <p className="prediction-empty-copy">
          Cancel sell orders to release contracts before claiming.
        </p>
      )}
      {SHARED_BALANCES_ENABLED && status === "resolved" && (
        <div className="prediction-claim">
          <dl className="prediction-claim-value">
            <dt>Available payout</dt>
            <dd>
              {loaded ? `${readableAmount(payout, decimals)} ${symbol}` : "—"}
            </dd>
          </dl>
          <button
            className="prediction-claim-button"
            disabled={pending || !loaded || !hasFree}
            onClick={() => void submit("redeem", true)}
          >
            {pending
              ? "Confirm in wallet…"
              : payout.gtn(0)
                ? "Claim all available payout"
                : "Clear settled contracts"}
          </button>
          <details>
            <summary>Redeem a specific quantity</summary>
            <div className="prediction-entry-fields">
              <label>
                YES contracts to redeem
                <input
                  inputMode="numeric"
                  value={yes}
                  disabled={pending}
                  onChange={(event) => setYes(event.target.value)}
                />
              </label>
              <label>
                NO contracts to redeem
                <input
                  inputMode="numeric"
                  value={no}
                  disabled={pending}
                  onChange={(event) => setNo(event.target.value)}
                />
              </label>
            </div>
            <button
              disabled={pending || !canRedeem}
              onClick={() => void submit("redeem")}
            >
              Redeem selected free contracts
            </button>
          </details>
        </div>
      )}
      {SHARED_BALANCES_ENABLED &&
        status !== "resolved" &&
        status !== "draft" && (
          <details>
            <summary>Contract pairs</summary>
            <p className="prediction-empty-copy">
              1 {symbol} creates 1 YES + 1 NO. Merging a free pair returns 1{" "}
              {symbol}.
            </p>
            <label>
              Complete pairs
              <input
                inputMode="numeric"
                value={quantity}
                disabled={pending}
                onChange={(event) => setQuantity(event.target.value)}
              />
            </label>
            <div className="shared-actions">
              <button
                disabled={
                  pending ||
                  !loaded ||
                  !pairs ||
                  pairs.lten(0) ||
                  status !== "open" ||
                  now.gte(market.closeTs)
                }
                onClick={() => void submit("split")}
              >
                Create YES + NO pairs
              </button>
              <button
                disabled={pending || !canMerge}
                onClick={() => void submit("merge")}
              >
                Merge free pairs
              </button>
            </div>
          </details>
        )}
    </div>
  );
}
