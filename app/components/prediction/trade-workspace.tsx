"use client";

import {
  PredictionTradeTicket,
  type PredictionTradeTicketProps,
} from "./trade-ticket";
import { PredictionOrderBook } from "./order-book";

/** One snapshot feeds the ticket and ladder; presentation never performs an RPC read. */
export function PredictionTradeWorkspace(props: PredictionTradeTicketProps) {
  return (
    <div className="prediction-trading-layout">
      <PredictionOrderBook
        snapshot={props.snapshot}
        loaded={props.loaded}
        failed={props.failed}
        outcome={props.outcome}
        decimals={props.decimals}
        symbol={props.symbol}
        disabled={props.pending}
        onPrice={props.onPrice}
      />
      <PredictionTradeTicket {...props} />
    </div>
  );
}
