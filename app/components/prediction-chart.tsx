"use client";
import { useEffect, useId, useRef, useState } from "react";
import { getCandles, type CandleSeries } from "../lib/graphql/charts";
import { INDEXER_ENABLED } from "../lib/graphql/client";
import {
  RANGES,
  binarySeries,
  heldLine,
  percent,
  pointsFrom,
  probabilityAxis,
  stepPath,
  tickLabel,
  valueAt,
  type Point,
  type RangeLabel,
} from "../lib/prediction-series";
import { useIndexerUpdates } from "./use-indexer-updates";
import "./prediction-chart.css";

type Props = {
  market: string;
  engine: string;
  priceDecimals: number;
  /** Outcome labels; binary markets pass ["YES", "NO"] and chart YES. */
  outcomes: string[];
  binary?: boolean;
};
type Loaded = {
  key: string;
  from: number;
  to: number;
  lines: Point[][];
  coverage: string;
};

const HEIGHT = 300,
  TOP = 18,
  BOTTOM = 30,
  LEFT = 8,
  RIGHT = 52;
const DAY = 86_400;
/** Earlier history used to start a window at the price it already had. */
const PRIOR_DAYS = 89;

/**
 * Prediction-market chart in the Polymarket style: a probability line per
 * outcome (one for binary markets), range tabs, a headline with the change
 * over the range, a hover crosshair and a pulsing live point. The line draws
 * itself in when a market or range first appears; live updates move it
 * without replaying that animation.
 */
export function PredictionChart(props: Props) {
  const [range, setRange] = useState<RangeLabel>("1D");
  /** Multi-outcome filter: one outcome's line only, or null for all. */
  const [focus, setFocus] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const [width, setWidth] = useState(720);
  const box = useRef<HTMLDivElement | null>(null);
  // Earlier history changes rarely: reuse it for a minute per market/range
  // instead of refetching it on every live update.
  const priorCache = useRef<{
    key: string;
    at: number;
    value: (CandleSeries | null)[];
  } | null>(null);
  const title = useId();
  useIndexerUpdates(() => setRevision((v) => v + 1), [props.market]);

  useEffect(() => {
    if (!INDEXER_ENABLED || !box.current) return;
    const element = box.current;
    const measure = () => setWidth(Math.max(280, element.clientWidth));
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, []);

  const spec = RANGES.find((r) => r.label === range)!;
  const key = `${props.market}:${props.engine}:${range}`;
  const sources = props.binary
    ? ["0", "1"]
    : props.outcomes.map((_, i) => String(i));

  useEffect(() => {
    if (!INDEXER_ENABLED) return;
    const controller = new AbortController();
    const to = Math.floor(Date.now() / 1000),
      from = to - spec.seconds;
    const fetchSeries = (
      outcome: string,
      start: number,
      end: number,
      interval: number,
    ) =>
      getCandles(
        {
          market: props.market,
          engine: props.engine,
          outcome,
          interval,
          from: String(start),
          to: String(end),
        },
        controller.signal,
      );
    setLoading(true);
    setError("");
    void (async () => {
      try {
        const windowed = await Promise.all(
          sources.map((o) => fetchSeries(o, from, to, spec.interval)),
        );
        // The last daily close before the window starts each line at the
        // price it already had (ALL already covers the retained history).
        const cached = priorCache.current;
        const prior: (CandleSeries | null)[] =
          range === "ALL"
            ? sources.map(() => null)
            : cached && cached.key === key && Date.now() - cached.at < 60_000
              ? cached.value
              : await Promise.all(
                  sources.map((o) =>
                    fetchSeries(o, from - PRIOR_DAYS * DAY, from, DAY),
                  ),
                );
        if (range !== "ALL" && prior !== cached?.value)
          priorCache.current = { key, at: Date.now(), value: prior };
        if (controller.signal.aborted) return;
        const failed = windowed.find((s) => s.error);
        if (failed?.error) throw new Error(failed.error);
        const lastClose = (series: CandleSeries | null) =>
          series?.candles.at(-1) ?? null;
        let lines: Point[][];
        if (props.binary) {
          const pts = binarySeries(
            windowed[0].candles,
            windowed[1].candles,
            props.priceDecimals,
            spec.interval,
          );
          const before = binarySeries(
            lastClose(prior[0]) ? [lastClose(prior[0])!] : [],
            lastClose(prior[1]) ? [lastClose(prior[1])!] : [],
            props.priceDecimals,
            DAY,
          ).at(-1);
          lines = [heldLine(pts, from, to, before?.v ?? null, spec.interval)];
        } else {
          lines = windowed.map((series, i) => {
            const before = lastClose(prior[i]);
            return heldLine(
              pointsFrom(series.candles, props.priceDecimals, spec.interval),
              from,
              to,
              before ? Number(before.close) / 10 ** props.priceDecimals : null,
              spec.interval,
            );
          });
        }
        setLoaded({
          key,
          from,
          to,
          lines,
          coverage: windowed.every((s) => s.coverage === "COMPLETE")
            ? "complete"
            : "partial",
        });
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(
            cause instanceof Error ? cause.message : "Chart data unavailable",
          );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [
    props.market,
    props.engine,
    props.binary,
    props.priceDecimals,
    sources.length,
    range,
    revision,
  ]);

  if (!INDEXER_ENABLED) return null;

  // Keep the previous range on screen until the new one arrives.
  const data = loaded;
  const series = (data?.lines ?? []).map((line, i) => ({
    label: props.binary ? "Yes" : props.outcomes[i],
    line,
    color: props.binary
      ? "var(--accent)"
      : `rgb(var(--hue-${(i % 6) + 1}-rgb))`,
  }));
  const traded = series.filter((s) => s.line.length > 0);
  // A selected outcome hides the others and rezooms the axis to its line.
  const focused = traded.find((s) => s.label === focus) ?? null;
  const drawn = focused ? [focused] : traded;
  const values = drawn.flatMap((s) => s.line.map((p) => p.v));
  const axis = probabilityAxis(values);
  const plotRight = width - RIGHT;
  const from = data?.from ?? 0,
    to = data?.to ?? 1;
  const x = (t: number) =>
    LEFT + ((t - from) / Math.max(1, to - from)) * (plotRight - LEFT);
  const y = (v: number) =>
    TOP +
    ((axis.max - v) / Math.max(1e-9, axis.max - axis.min)) *
      (HEIGHT - TOP - BOTTOM);
  const current = traded.map((s) => ({
    ...s,
    now: s.line.at(-1)!.v,
    start: s.line[0].v,
  }));
  const headline = props.binary
    ? current[0]
    : (current.find((s) => s.label === focused?.label) ?? null);
  const change = headline ? (headline.now - headline.start) * 100 : 0;
  const timeLabel = (t: number) =>
    new Date(t * 1000).toLocaleString(
      undefined,
      spec.seconds <= DAY
        ? { hour: "numeric", minute: "2-digit" }
        : { month: "short", day: "numeric" },
    );
  const hoverValues =
    hover === null
      ? null
      : drawn.map((s) => ({ ...s, value: valueAt(s.line, hover) }));

  return (
    <section className="prediction-chart pc-root" aria-labelledby={title}>
      <div className="pc-head">
        <div>
          <h2 id={title} className="pc-title">
            {props.binary
              ? "Chance of Yes"
              : focused
                ? focused.label
                : "Outcome chances"}
          </h2>
          {headline && (
            <p className="pc-headline">
              <strong>{percent(headline.now)}</strong> chance
              {Math.abs(change) >= 0.05 && (
                <span className={change > 0 ? "pc-up" : "pc-down"}>
                  {change > 0 ? "▲" : "▼"} {Math.abs(change).toFixed(1)} pts{" "}
                  <small>{range}</small>
                </span>
              )}
            </p>
          )}
          {!props.binary && (
            <ul className="pc-legend" aria-label="Show outcome">
              {focused && (
                <li>
                  <button
                    type="button"
                    className="pc-legend-all"
                    onClick={() => setFocus(null)}
                  >
                    All outcomes
                  </button>
                </li>
              )}
              {[...current]
                .sort((a, b) => b.now - a.now)
                .map((s) => (
                  <li key={s.label}>
                    <button
                      type="button"
                      aria-pressed={focused?.label === s.label}
                      className={
                        focused && focused.label !== s.label
                          ? "pc-legend-dim"
                          : undefined
                      }
                      title={
                        focused?.label === s.label
                          ? "Show all outcomes"
                          : `Show only ${s.label}`
                      }
                      onClick={() =>
                        setFocus(focused?.label === s.label ? null : s.label)
                      }
                    >
                      <i style={{ background: s.color }} />
                      {s.label} <strong>{percent(s.now)}</strong>
                    </button>
                  </li>
                ))}
            </ul>
          )}
        </div>
        <div className="pc-ranges" role="group" aria-label="Chart range">
          {RANGES.map((r) => (
            <button
              key={r.label}
              type="button"
              aria-pressed={range === r.label}
              onClick={() => setRange(r.label)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>
      <div
        ref={box}
        className="pc-plot"
        onPointerMove={(e) => {
          if (!drawn.length) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - rect.left) / rect.width) * width;
          if (px < LEFT || px > plotRight) return setHover(null);
          setHover(from + ((px - LEFT) / (plotRight - LEFT)) * (to - from));
        }}
        onPointerLeave={() => setHover(null)}
      >
        {error && <p role="alert">{error}</p>}
        {!error && data && !drawn.length && (
          <p className="pc-empty" role="status">
            No trades yet. The chart starts with the first fill.
          </p>
        )}
        {!data && !error && (
          <p className="pc-empty" role="status">
            Loading chart…
          </p>
        )}
        {drawn.length > 0 && (
          <svg
            viewBox={`0 0 ${width} ${HEIGHT}`}
            role="img"
            aria-label={`${props.binary ? "Chance of Yes" : "Outcome chances"} over ${range}: ${current
              .map((s) => `${s.label} ${percent(s.now)}`)
              .join(", ")}.`}
          >
            {axis.ticks.map((v) => (
              <g key={v} className="pc-grid">
                <line x1={LEFT} x2={plotRight} y1={y(v)} y2={y(v)} />
                <text x={width - 6} y={y(v) + 4} textAnchor="end">
                  {tickLabel(v)}
                </text>
              </g>
            ))}
            {[0, 1, 2, 3].map((i) => {
              const t = from + ((to - from) * (i + 0.5)) / 4;
              return (
                <text
                  key={i}
                  className="pc-time"
                  x={x(t)}
                  y={HEIGHT - 8}
                  textAnchor="middle"
                >
                  {timeLabel(t)}
                </text>
              );
            })}
            {drawn.map((s) => (
              <g
                key={`${data!.key}:${focused?.label ?? "all"}:${s.label}`}
                className="pc-series"
              >
                {props.binary && (
                  <path
                    className="pc-area"
                    d={`${stepPath(s.line, x, y)} V${HEIGHT - BOTTOM} H${x(s.line[0].t)} Z`}
                    style={{ fill: s.color }}
                  />
                )}
                <path
                  className="pc-line"
                  d={stepPath(s.line, x, y)}
                  pathLength={1}
                  style={{ stroke: s.color }}
                />
                <g
                  className="pc-live"
                  style={{
                    transform: `translate(${x(s.line.at(-1)!.t)}px, ${y(s.line.at(-1)!.v)}px)`,
                    color: s.color,
                  }}
                >
                  <circle className="pc-pulse" r="5" />
                  <circle r="4" />
                </g>
              </g>
            ))}
            {hover !== null && (
              <g className="pc-cross">
                <line
                  x1={x(hover)}
                  x2={x(hover)}
                  y1={TOP}
                  y2={HEIGHT - BOTTOM}
                />
                {hoverValues!.map(
                  (s) =>
                    s.value !== null && (
                      <circle
                        key={s.label}
                        cx={x(hover)}
                        cy={y(s.value)}
                        r="4"
                        style={{ fill: s.color }}
                      />
                    ),
                )}
              </g>
            )}
          </svg>
        )}
        {hover !== null && hoverValues && (
          <div
            className="pc-tip"
            style={{
              left: `${(x(hover) / width) * 100}%`,
              transform: `translateX(${x(hover) > width * 0.6 ? "calc(-100% - 12px)" : "12px"})`,
            }}
          >
            <time>
              {new Date(hover * 1000).toLocaleString(undefined, {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })}
            </time>
            {hoverValues
              .filter((s) => s.value !== null)
              .sort((a, b) => b.value! - a.value!)
              .map((s) => (
                <span key={s.label}>
                  <i style={{ background: s.color }} />
                  {s.label} <strong>{percent(s.value!)}</strong>
                </span>
              ))}
          </div>
        )}
      </div>
      <p className="pc-foot">
        {/* Only a new market or range shows progress; live refreshes are silent. */}
        {loading && data?.key !== key
          ? "Updating…"
          : `Indexed trades · ${data?.coverage ?? "loading"}`}{" "}
        · Prices are the last trade; the line holds it until the next fill.
      </p>
    </section>
  );
}
