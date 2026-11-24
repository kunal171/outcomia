"use client";
import {
  getCandles,
  type Candle,
  type CandleSeries,
} from "../lib/graphql/charts";
import { useEffect, useId, useRef, useState } from "react";
import { BN } from "@anchor-lang/core";
import { INDEXER_ENABLED } from "../lib/graphql/client";
import { readableAmount } from "../lib/market-display";
import { useIndexerUpdates } from "./use-indexer-updates";
type Series = CandleSeries;
type Props = {
  market: string;
  engine: string;
  priceDecimals: number;
  symbol: string;
  outcomes?: string[];
};
const steps = [60, 300, 900, 3600, 14400, 86400];
const stepLabels = ["1m", "5m", "15m", "1h", "4h", "1d"];
const chartTypes = ["Candlestick", "OHLC bars", "Line", "Area"] as const;
/** Prediction prices are shares of the 1-token payout, so they live in [0, 1]. */
const predictionEngines = new Set([
  "SHARED_BINARY",
  "LEGACY_BINARY",
  "MULTI_OUTCOME",
]);
export function TradingChart(props: Props) {
  const prediction = predictionEngines.has(props.engine);
  // Sparse prediction trading reads best as a held-price line.
  const [kind, setKind] = useState<(typeof chartTypes)[number]>(
      prediction ? "Line" : "Candlestick",
    ),
    [interval, setInterval] = useState(3600),
    [range, setRange] = useState(7 * 86400),
    [outcome, setOutcome] = useState(props.outcomes ? "0" : "spot"),
    [volume, setVolume] = useState(true);
  const [result, setSeries] = useState<Series | null>(null),
    // The requested window, so the x-axis shows the selected range even when
    // trades cover only part of it (or a single interval).
    [loadedWindow, setLoadedWindow] = useState({ from: 0, to: 0 }),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [revision, setRevision] = useState(0);
  const title = useId();
  const container = useRef<HTMLElement | null>(null);
  const [plotWidth, setPlotWidth] = useState(900);
  useEffect(() => {
    if (!INDEXER_ENABLED || !container.current) return;
    const element = container.current;
    const measure = () => {
      const style = getComputedStyle(element);
      setPlotWidth(
        Math.max(
          280,
          Math.floor(
            element.clientWidth -
              parseFloat(style.paddingLeft) -
              parseFloat(style.paddingRight),
          ),
        ),
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, []);
  const selectionKey = [
    props.market,
    props.engine,
    interval,
    range,
    outcome,
  ].join(":");
  const [loadedKey, setLoadedKey] = useState("");
  const series = loadedKey === selectionKey ? result : null;
  useIndexerUpdates(() => setRevision((value) => value + 1));
  useEffect(() => {
    if (!INDEXER_ENABLED) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const to = Math.floor(Date.now() / 1000),
      from = to - range;
    void getCandles(
      {
        market: props.market,
        engine: props.engine,
        outcome: props.outcomes ? outcome : "spot",
        interval,
        from: String(from),
        to: String(to),
      },
      controller.signal,
    )
      .then((result) => {
        if (!controller.signal.aborted) {
          setSeries(result);
          setLoadedWindow({ from, to });
          setLoadedKey(selectionKey);
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setSeries(null);
          setError(
            cause instanceof Error ? cause.message : "Chart data unavailable",
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [
    props.market,
    props.engine,
    !!props.outcomes,
    interval,
    range,
    outcome,
    revision,
  ]);
  if (!INDEXER_ENABLED) return null;
  const candles = series?.candles ?? [];
  const value = (raw: string) => Number(raw) / 10 ** props.priceDecimals;
  const valid = candles.every((c) =>
    [c.open, c.high, c.low, c.close, c.quoteVolume].every(
      (v) => /^\d+$/.test(v) && Number.isFinite(Number(v)),
    ),
  );
  const highs = candles.map((c) => value(c.high)),
    lows = candles.map((c) => value(c.low));
  const min = Math.min(...lows),
    max = Math.max(...highs);
  // Price axis: never zoom tighter than 10 cents for prediction markets
  // (prices are 0–1) or 4% of price for spot, so one trade or a tiny move
  // does not fill the whole height. Prediction axes stay within [0, 1].
  const minimumSpan = Math.max(
      prediction ? 0.1 : max * 0.04,
      10 ** -props.priceDecimals,
    ),
    pad = Math.max((max - min) * 0.1, (minimumSpan - (max - min)) / 2, 0);
  let floor = min - pad,
    ceiling = max + pad;
  if (prediction) {
    // Four equal steps of a round size (0.01, 0.02, 0.025, 0.05, …) so the
    // labels read as plain cents, kept inside [0, 1].
    const step =
      [0.01, 0.02, 0.025, 0.05, 0.1, 0.2, 0.25].find(
        (size) => size * 4 >= ceiling - floor,
      ) ?? 0.25;
    floor = Math.max(0, Math.floor(floor / step + 1e-9) * step);
    if (floor + 4 * step > 1) floor = Math.max(0, 1 - 4 * step);
    ceiling = floor + 4 * step;
  }
  // Time axis: the requested window, aligned to whole intervals.
  const first = Math.floor(loadedWindow.from / interval) * interval,
    last = Math.max(loadedWindow.to, first + interval),
    span = last - first;
  const at = (time: number) => 60 + ((time - first) / span) * (plotWidth - 110);
  const x = (c: Candle) => at(Number(c.time) + interval / 2);
  const y = (raw: string) =>
    245 - ((value(raw) - floor) / (ceiling - floor)) * 215;
  const width = Math.max(
    1,
    Math.min(12, ((plotWidth - 110) / (span / interval)) * 0.7),
  );
  const maxVolume = Math.max(...candles.map((c) => Number(c.quoteVolume)), 1);
  // Line/Area: the price holds at the last trade until the next one (a step
  // line), then a dashed segment carries the latest price to the window end.
  const lastClose = candles.at(-1);
  const stepPath = candles
    .map((c, i) => (i ? `H${x(c)} V${y(c.close)}` : `M${x(c)},${y(c.close)}`))
    .join(" ");
  const tail = lastClose
    ? `M${x(lastClose)},${y(lastClose.close)} H${at(last)}`
    : "";
  const label = (time: number) =>
    plotWidth < 600 || span <= 86400
      ? new Date(time * 1000).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })
      : new Date(time * 1000).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
        });
  const exact = (raw: string) =>
    readableAmount(new BN(raw), props.priceDecimals);
  return (
    <section ref={container} className="trading-chart" aria-labelledby={title}>
      <div className="chart-heading">
        <h2 id={title}>Trading chart</h2>
        <span>
          {loading
            ? "Updating…"
            : series
              ? `${series.commitment} · ${series.coverage.toLowerCase()}`
              : "Indexed executions"}
        </span>
      </div>
      <div className="chart-controls">
        <label>
          Chart type
          <select
            aria-label="Chart type"
            value={kind}
            onChange={(e) => setKind(e.target.value as typeof kind)}
          >
            {chartTypes.map((type) => (
              <option key={type}>{type}</option>
            ))}
          </select>
        </label>
        <label>
          Interval
          <select
            aria-label="Interval"
            value={interval}
            onChange={(e) => setInterval(Number(e.target.value))}
          >
            {steps.map((step, i) => (
              <option key={step} value={step} disabled={range / step > 2000}>
                {stepLabels[i]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Range
          <select
            aria-label="Range"
            value={range}
            onChange={(e) => {
              const next = Number(e.target.value);
              setRange(next);
              if (next / interval > 2000)
                setInterval(steps.find((step) => next / step <= 2000)!);
            }}
          >
            <option value={86400}>24 hours</option>
            <option value={7 * 86400}>7 days</option>
            <option value={30 * 86400}>30 days</option>
          </select>
        </label>
        {props.outcomes && (
          <label>
            Chart outcome
            <select
              aria-label="Chart outcome"
              value={outcome}
              onChange={(e) => setOutcome(e.target.value)}
            >
              {props.outcomes.map((label, index) => (
                <option key={index} value={index}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="chart-volume-toggle">
          <input
            type="checkbox"
            checked={volume}
            onChange={(e) => setVolume(e.target.checked)}
          />
          Volume
        </label>
      </div>
      {error && <p role="alert">{error}</p>}
      {series?.error && <p role="status">{series.error}</p>}
      {series && !candles.length && !series.error && (
        <p role="status">
          {series.coverage === "COMPLETE"
            ? "No executions in this range."
            : "Trade history is still being indexed."}
        </p>
      )}
      {!valid && <p role="alert">Chart values could not be displayed.</p>}
      {valid && candles.length > 0 && (
        <>
          <svg
            className="chart-plot"
            viewBox={`0 0 ${plotWidth} ${volume ? 340 : 275}`}
            role="img"
            aria-label={`${kind} chart of ${props.symbol} prices, ${stepLabels[steps.indexOf(interval)]} intervals. ${series?.commitment} executions.`}
          >
            <title>
              {kind} chart; prices in {props.symbol}
            </title>
            {[0, 1, 2, 3, 4].map((i) => (
              <g className="chart-grid" key={i}>
                <line
                  x1="58"
                  x2={plotWidth - 20}
                  y1={30 + i * 53.75}
                  y2={30 + i * 53.75}
                />
                <text x="53" y={34 + i * 53.75} textAnchor="end">
                  {prediction
                    ? (ceiling - (i / 4) * (ceiling - floor))
                        .toFixed(3)
                        .replace(/0$/, "")
                    : (ceiling - (i / 4) * (ceiling - floor)).toPrecision(5)}
                </text>
              </g>
            ))}
            {kind === "Line" || kind === "Area"
              ? lastClose && (
                  <g>
                    {kind === "Area" && (
                      <path
                        className="chart-area"
                        d={`${stepPath} H${at(last)} V245 H${x(candles[0])} Z`}
                      />
                    )}
                    <path className="chart-line" d={stepPath} />
                    <path className="chart-line chart-line-held" d={tail} />
                    {candles.map((c) => (
                      <circle key={c.time} cx={x(c)} cy={y(c.close)} r="3">
                        <title>
                          {new Date(Number(c.time) * 1000).toISOString()}:{" "}
                          {exact(c.close)} {props.symbol}
                        </title>
                      </circle>
                    ))}
                  </g>
                )
              : candles.map((c) => (
                  <g
                    key={c.time}
                    className={
                      new BN(c.close).gte(new BN(c.open))
                        ? "chart-rise"
                        : "chart-fall"
                    }
                    tabIndex={0}
                    aria-label={`${new Date(Number(c.time) * 1000).toISOString()} open ${exact(c.open)}, high ${exact(c.high)}, low ${exact(c.low)}, close ${exact(c.close)} ${props.symbol}`}
                  >
                    <title>{`O ${exact(c.open)} · H ${exact(c.high)} · L ${exact(c.low)} · C ${exact(c.close)}`}</title>
                    <line x1={x(c)} x2={x(c)} y1={y(c.high)} y2={y(c.low)} />
                    {kind === "Candlestick" ? (
                      <rect
                        x={x(c) - width / 2}
                        y={Math.min(y(c.open), y(c.close))}
                        width={width}
                        height={Math.max(1, Math.abs(y(c.open) - y(c.close)))}
                      />
                    ) : (
                      <>
                        <line
                          x1={x(c) - width / 2}
                          x2={x(c)}
                          y1={y(c.open)}
                          y2={y(c.open)}
                        />
                        <line
                          x1={x(c)}
                          x2={x(c) + width / 2}
                          y1={y(c.close)}
                          y2={y(c.close)}
                        />
                      </>
                    )}
                  </g>
                ))}
            <text className="chart-time" x="60" y="266">
              {label(first)}
            </text>
            <text
              className="chart-time"
              x={plotWidth - 50}
              y="266"
              textAnchor="end"
            >
              {label(last)}
            </text>
            {volume &&
              candles.map((c) => (
                <rect
                  className="chart-volume"
                  key={c.time}
                  x={x(c) - width / 2}
                  y={325 - (Number(c.quoteVolume) / maxVolume) * 45}
                  width={width}
                  height={(Number(c.quoteVolume) / maxVolume) * 45}
                >
                  <title>
                    Volume: {exact(c.quoteVolume)} {props.symbol}
                  </title>
                </rect>
              ))}
          </svg>
          <p className="rules-help">
            Execution prices · {props.symbol} per contract or base token.{" "}
            {kind === "Line" || kind === "Area"
              ? "The line holds the last trade price between trades (dashed after the latest)."
              : "Intervals without trades are empty."}{" "}
            {series?.commitment === "confirmed"
              ? "Latest updates await finalization."
              : "Finalized execution history."}
          </p>
          <details className="chart-data">
            <summary>Chart data (latest 20 intervals)</summary>
            <div className="chart-table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>UTC time</th>
                    <th>Open</th>
                    <th>High</th>
                    <th>Low</th>
                    <th>Close</th>
                    <th>Volume</th>
                  </tr>
                </thead>
                <tbody>
                  {candles.slice(-20).map((c) => (
                    <tr key={c.time}>
                      <td>{new Date(Number(c.time) * 1000).toISOString()}</td>
                      {[c.open, c.high, c.low, c.close, c.quoteVolume].map(
                        (raw, i) => (
                          <td key={i}>{exact(raw)}</td>
                        ),
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </section>
  );
}
