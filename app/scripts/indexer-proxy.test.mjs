// The same-origin indexer proxy forwards the browser IP only with the shared secret.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTypeScript } from "./support/typescript.mjs";

const loaded = loadTypeScript(
  new URL("../lib/graphql/proxy.ts", import.meta.url),
);
// The loader runs in a separate VM realm; copy results into this realm.
const clientIdentityHeaders = (...args) => ({
  ...loaded.clientIdentityHeaders(...args),
});
const SECRET = "0123456789abcdef0123456789abcdef";
const request = (headers) =>
  new Request("https://outcomia.example/api/indexer/auth/challenge", {
    method: "POST",
    headers,
  });

test("forwards the client IP with the secret", () => {
  assert.deepEqual(
    clientIdentityHeaders(request({ "x-real-ip": "203.0.113.7" }), SECRET),
    {
      "x-outcomia-client-ip": "203.0.113.7",
      "x-outcomia-proxy-token": SECRET,
    },
  );
  // Falls back to the first x-forwarded-for entry.
  assert.equal(
    clientIdentityHeaders(
      request({ "x-forwarded-for": "198.51.100.4, 10.0.0.1" }),
      SECRET,
    )["x-outcomia-client-ip"],
    "198.51.100.4",
  );
});

test("sends nothing without a secret or a client IP", () => {
  assert.deepEqual(
    clientIdentityHeaders(request({ "x-real-ip": "203.0.113.7" }), undefined),
    {},
  );
  assert.deepEqual(clientIdentityHeaders(request({}), SECRET), {});
});
