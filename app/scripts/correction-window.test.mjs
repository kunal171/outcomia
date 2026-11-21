// Client mirror of the program's per-phase correction deadline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { loadTypeScript } from "./support/typescript.mjs";

const require = createRequire(import.meta.url),
  { BN } = require("@anchor-lang/core");
const { correctionDeadline, correctionOpen } = loadTypeScript(
  new URL("../lib/correction-window.ts", import.meta.url),
);
const base = {
  closeTs: new BN(100),
  earliestResolutionTs: null,
  resolutionDelaySeconds: new BN(10),
  fallbackPhase: false,
  fallbackAvailableTs: null,
};

test("primary deadline is the earliest resolution time plus two delays", () => {
  assert.equal(correctionDeadline(base).toNumber(), 120);
  assert.equal(
    correctionDeadline({
      ...base,
      earliestResolutionTs: new BN(150),
    }).toNumber(),
    170,
  );
  // A configured but inactive fallback does not move the primary window.
  assert.equal(
    correctionDeadline({
      ...base,
      fallbackAvailableTs: new BN(500),
    }).toNumber(),
    120,
  );
});

test("fallback deadline restarts at fallback availability", () => {
  assert.equal(
    correctionDeadline({
      ...base,
      fallbackPhase: true,
      fallbackAvailableTs: new BN(500),
    }).toNumber(),
    520,
  );
});

test("a correction needs an immature proposal inside the window", () => {
  // Same timeline as the program's LiteSVM test: proposal at 118 matures at 128.
  const maturity = new BN(128);
  assert.equal(correctionOpen(base, maturity, new BN(119)), true);
  assert.equal(correctionOpen(base, maturity, new BN(120)), false);
  assert.equal(correctionOpen(base, new BN(115), new BN(115)), false);
  assert.equal(correctionOpen(base, null, new BN(101)), false);
});
