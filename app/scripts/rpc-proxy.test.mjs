import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
const module = { exports: {} };
runInNewContext(
  ts.transpileModule(
    readFileSync(new URL("../lib/rpc-proxy.ts", import.meta.url), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText,
  {
    module,
    exports: module.exports,
    Response,
    Request,
    TextDecoder,
    Uint8Array,
    AbortSignal,
    URL,
    Date: { now: () => 1000000 },
  },
);
const { handleRpcProxy } = module.exports,
  secret = "test-key-never-public",
  endpoint = "https://devnet.helius-rpc.com/?api-key=" + secret,
  programId = "AG4ztZvcZjzFKjoXLzH8M6U3if9CwVFTXH2FHjqg7SdL";
let peer = 0;
const request = (method, params = [], headers = {}) =>
  new Request("https://outcomia.example/api/solana", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-real-ip": String(++peer),
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
test("forwards the RPC body once while keeping the private endpoint out of the response", async () => {
  let count = 0;
  const r = await handleRpcProxy(request("getBalance", [programId]), {
    endpoint,
    programId,
    fetcher: async (url, init) => {
      count++;
      assert.equal(new URL(url).searchParams.get("api-key"), secret);
      assert.equal(init.cache, "no-store");
      assert.equal(JSON.parse(init.body).method, "getBalance");
      return Response.json({ jsonrpc: "2.0", id: 1, result: 123 });
    },
  });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).result, 123);
  assert.equal(count, 1);
});
test("signed broadcasts are forwarded once, with no server retry", async () => {
  let count = 0;
  const r = await handleRpcProxy(
    request("sendTransaction", ["signed-bytes", { encoding: "base64" }]),
    {
      endpoint,
      programId,
      fetcher: async () => {
        count++;
        throw Error(endpoint);
      },
    },
  );
  assert.equal(r.status, 503);
  assert.equal(count, 1);
  assert(!(await r.text()).includes(secret));
});
test("redacts an upstream error containing its URL and key", async () => {
  const r = await handleRpcProxy(request("getGenesisHash"), {
    endpoint,
    programId,
    fetcher: async () =>
      Response.json({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -1, message: endpoint + " " + secret },
      }),
  });
  const text = await r.text();
  assert(!text.includes(secret));
  assert(text.includes("<redacted>"));
});
test("preserves rate limiting without forwarding a provider error body", async () => {
  const r = await handleRpcProxy(request("getGenesisHash"), {
    endpoint,
    programId,
    fetcher: async () => new Response(secret, { status: 429 }),
  });
  assert.equal(r.status, 429);
  assert.equal(r.headers.get("retry-after"), "10");
  assert(!(await r.text()).includes(secret));
});
test("rejects other origins, arbitrary methods and global account scans before contacting upstream", async () => {
  let calls = 0;
  const config = {
    endpoint,
    programId,
    fetcher: async () => {
      calls++;
      return Response.json({});
    },
  };
  assert.equal(
    (
      await handleRpcProxy(
        request("getGenesisHash", [], { origin: "https://evil.example" }),
        config,
      )
    ).status,
    403,
  );
  assert.equal(
    (await handleRpcProxy(request("getBlock", [1]), config)).status,
    400,
  );
  assert.equal(
    (
      await handleRpcProxy(
        request("getProgramAccounts", ["other-program"]),
        config,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await handleRpcProxy(
        request("getMultipleAccounts", [Array(101).fill(programId)]),
        config,
      )
    ).status,
    400,
  );
  assert.equal(calls, 0);
});
test("the upstream URL is fixed server configuration, not a caller-selected proxy target", async () => {
  let calls = 0;
  const r = await handleRpcProxy(request("getBalance", [programId]), {
    endpoint: "https://attacker.example",
    programId,
    fetcher: async () => {
      calls++;
      return Response.json({});
    },
  });
  assert.equal(r.status, 503);
  assert.equal(calls, 0);
});
test("caps request and response sizes", async () => {
  const r = await handleRpcProxy(
    request("sendTransaction", ["x".repeat(65537)]),
    {
      endpoint,
      programId,
      fetcher: async () => {
        throw Error("must not fetch");
      },
    },
  );
  assert.equal(r.status, 400);
  const large = await handleRpcProxy(request("getBalance", [programId]), {
    endpoint,
    programId,
    fetcher: async () => new Response("x".repeat(4 * 1024 * 1024 + 1)),
  });
  assert.equal(large.status, 503);
});
test("bounds batches and charges each RPC call to the per-instance peer allowance", async () => {
  let calls = 0;
  const config = {
    endpoint,
    programId,
    fetcher: async () => {
      calls++;
      return Response.json([]);
    },
  };
  const message = {
    jsonrpc: "2.0",
    id: 1,
    method: "getGenesisHash",
    params: [],
  };
  const make = () =>
    new Request("https://outcomia.example/api/solana", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-real-ip": "batch-peer",
      },
      body: JSON.stringify(Array(25).fill(message)),
    });
  assert.equal((await handleRpcProxy(make(), config)).status, 200);
  assert.equal((await handleRpcProxy(make(), config)).status, 200);
  assert.equal((await handleRpcProxy(make(), config)).status, 429);
  assert.equal(calls, 2);
});
