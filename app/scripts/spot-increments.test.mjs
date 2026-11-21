// Client mirror of the program's spot increment rule (tick * lot >= 10^decimals).
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTypeScript } from "./support/typescript.mjs";

const { spotIncrementsError } = loadTypeScript(
  new URL("../lib/spot-increments.ts", import.meta.url),
);

test("one whole base token is the accepted boundary", () => {
  assert.equal(spotIncrementsError(9, 10_000n, 100_000n), null);
  assert.equal(spotIncrementsError(6, 1n, 1_000_000n), null);
  assert.equal(spotIncrementsError(0, 1n, 1n), null);
  assert.equal(spotIncrementsError(8, 10_000n, 100_000n), null);
});

test("increments below one whole base token are rejected", () => {
  assert.match(spotIncrementsError(9, 1n, 1n), /at least 1000000000/);
  assert.notEqual(spotIncrementsError(9, 10_000n, 99_999n), null);
  assert.notEqual(spotIncrementsError(6, 1n, 999_999n), null);
});

test("zero increments and invalid decimals are rejected", () => {
  assert.notEqual(spotIncrementsError(6, 0n, 1_000_000n), null);
  assert.notEqual(spotIncrementsError(6, 1_000_000n, 0n), null);
  assert.notEqual(spotIncrementsError(-1, 1n, 1n), null);
  assert.notEqual(spotIncrementsError(1.5, 1n, 1n), null);
});

test("u64-sized increments do not overflow", () => {
  const max = (1n << 64n) - 1n;
  assert.equal(spotIncrementsError(19, max, max), null);
});
