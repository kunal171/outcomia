import { graphql } from "./client";

export type Candle = {
  time: string;
  open: string;
  high: string;
  low: string;
  close: string;
  quantity: string;
  quoteVolume: string;
  trades: number;
};

export type CandleSeries = {
  supported: boolean;
  coverage: string;
  commitment: string;
  error: string | null;
  candles: Candle[];
};

export type ChartFilter = {
  market: string;
  engine: string;
  outcome: string;
  interval: number;
  from: string;
  to: string;
};

export function getCandles(filter: ChartFilter, signal?: AbortSignal) {
  return graphql<{ candles: CandleSeries }>(
    `
      query GetCandles(
        $market: String!
        $engine: String!
        $outcome: String!
        $interval: Int!
        $from: String!
        $to: String!
      ) {
        candles(
          market: $market
          engine: $engine
          outcome: $outcome
          interval: $interval
          from: $from
          to: $to
        ) {
          supported
          coverage
          commitment
          error
          candles {
            time
            open
            high
            low
            close
            quantity
            quoteVolume
            trades
          }
        }
      }
    `,
    filter,
    signal,
  ).then((result) => result.candles);
}
