// Prediction chart series: YES/NO merge, held lines, hover values and axes.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  binarySeries,
  heldLine,
  percent,
  pointsFrom,
  tickLabel,
  probabilityAxis,
  stepPath,
  valueAt,
} from "../lib/prediction-series.ts";

const c = (time, close) => ({ time: String(time), close: String(close) });

test("NO trades become YES probability; a YES trade in the same bucket wins", () => {
  // 6-decimal prices; interval 60 so each point sits at its bucket's end.
  const yes = [c(0, 600000), c(120, 620000)];
  const no = [c(60, 350000), c(120, 300000)];
  assert.deepEqual(binarySeries(yes, no, 6, 60), [
    { t: 60, v: 0.6 },
    { t: 120, v: 0.65 },
    { t: 180, v: 0.62 },
  ]);
});

test("held lines start at the prior price, step at trades and reach the window end", () => {
  const pts = [
    { t: 50, v: 0.3 },
    { t: 150, v: 0.4 },
    { t: 250, v: 0.9 },
  ];
  assert.deepEqual(heldLine(pts, 100, 200, 0.35), [
    { t: 100, v: 0.35 },
    { t: 150, v: 0.4 },
    { t: 200, v: 0.4 },
  ]);
  // No earlier price: the line starts at the first trade inside the window.
  assert.deepEqual(heldLine(pts, 100, 200, null), [
    { t: 150, v: 0.4 },
    { t: 200, v: 0.4 },
  ]);
  // A quiet window still shows the price it already had.
  assert.deepEqual(heldLine([], 100, 200, 0.7), [
    { t: 100, v: 0.7 },
    { t: 200, v: 0.7 },
  ]);
  assert.deepEqual(heldLine([], 100, 200, null), []);
});

test("hover reads the held value at any time", () => {
  const line = [
    { t: 100, v: 0.35 },
    { t: 150, v: 0.4 },
    { t: 200, v: 0.4 },
  ];
  assert.equal(valueAt(line, 99), null);
  assert.equal(valueAt(line, 120), 0.35);
  assert.equal(valueAt(line, 150), 0.4);
  assert.equal(
    stepPath(
      line,
      (t) => t,
      (v) => v * 100,
    ),
    "M100.0,35.0 H150.0 V40.0 H200.0 V40.0",
  );
});

test("axes use round percent steps, a 10-point minimum and stay within 0–100%", () => {
  const near = probabilityAxis([0.6, 0.62]);
  assert.ok(near.max - near.min >= 0.1);
  assert.ok(near.min <= 0.6 && near.max >= 0.62);
  for (const axis of [
    near,
    probabilityAxis([0.01, 0.02]),
    probabilityAxis([0.98, 0.99]),
    probabilityAxis([0.05, 0.95]),
  ]) {
    assert.ok(axis.min >= 0 && axis.max <= 1, JSON.stringify(axis));
    const steps = axis.ticks
      .slice(1)
      .map((v, i) => +(v - axis.ticks[i]).toFixed(4));
    assert.ok(
      steps.every((s) => s === steps[0]),
      JSON.stringify(axis.ticks),
    );
    assert.ok(
      axis.ticks.length >= 3 && axis.ticks.length <= 7,
      JSON.stringify(axis.ticks),
    );
  }
  assert.deepEqual(probabilityAxis([]).ticks, [0, 0.25, 0.5, 0.75, 1]);
});

test("points sit at bucket ends and percent labels stay readable at the extremes", () => {
  assert.deepEqual(pointsFrom([c(3600, 250000)], 6, 3600), [
    { t: 7200, v: 0.25 },
  ]);
  assert.equal(percent(0.62), "62%");
  assert.equal(percent(0.004), "0.4%");
  assert.equal(percent(0.995), "99.5%");
  assert.equal(percent(1), "100%");
});

test("the bucket still open now keeps its trade, clamped to the window end", () => {
  // A trade in the current 5-minute bucket ends at 1500, after `to` = 1320.
  assert.deepEqual(heldLine([{ t: 1500, v: 0.42 }], 1000, 1320, 0.4, 300), [
    { t: 1000, v: 0.4 },
    { t: 1320, v: 0.42 },
    { t: 1320, v: 0.42 },
  ]);
  assert.equal(tickLabel(0.275), "27.5%");
  assert.equal(tickLabel(0.3), "30%");
});
