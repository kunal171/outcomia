// Early-access gate: public paths, redirect safety, token comparison and the
// locked-by-default production behaviour.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  gateToken,
  hasAccess,
  isPublicPath,
  safeNext,
  sameText,
} from "../lib/gate.ts";

test("only the landing page and the gate are public", () => {
  for (const p of ["/", "/unlock", "/api/unlock"]) assert.ok(isPublicPath(p));
  for (const p of ["/app", "/canton/markets", "/api/canton/catalog", "/design"])
    assert.ok(!isPublicPath(p));
});

test("redirect targets stay on this site", () => {
  assert.equal(safeNext("/canton/markets?x=1"), "/canton/markets?x=1");
  for (const bad of [
    "//evil.com",
    "/\\evil.com",
    "https://evil.com",
    "",
    null,
    "/unlock?next=/app",
  ])
    assert.equal(safeNext(bad), "/app");
});

test("tokens depend on the password and compare in constant time", async () => {
  const a = await gateToken("one"),
    b = await gateToken("two");
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
  assert.ok(sameText(a, a));
  assert.ok(!sameText(a, b));
  assert.ok(!sameText(a, a.slice(0, 63)));
});

test("a password is required in production and checked when set", async () => {
  const env = { ...process.env };
  try {
    process.env.NODE_ENV = "production";
    delete process.env.APP_PASSWORD;
    assert.equal(await hasAccess(undefined), false);
    assert.equal(await hasAccess("anything"), false);
    process.env.APP_PASSWORD = "secret";
    assert.equal(await hasAccess(await gateToken("secret")), true);
    assert.equal(await hasAccess(await gateToken("wrong")), false);
    process.env.NODE_ENV = "development";
    delete process.env.APP_PASSWORD;
    assert.equal(await hasAccess(undefined), true);
  } finally {
    process.env = env;
  }
});
