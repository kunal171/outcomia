/** Storage boundaries use a fake Turbo service and fetch; no external uploads. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { loadTypeScript } from "./support/typescript.mjs";
const require = createRequire(import.meta.url);
const { PublicKey } = require("@solana/web3.js");
const draft = loadTypeScript(
  new URL("../lib/prediction-rules-draft.ts", import.meta.url),
);
const code = ts.transpileModule(
  readFileSync(new URL("../lib/arweave-rules.ts", import.meta.url), "utf8"),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;
function fixture({
  response = "{}\n",
  bytesRemaining = 100000,
  signalCheck = false,
} = {}) {
  const calls = { uploads: 0, signatures: 0, adapter: null, content: null };
  const mod = { exports: {} };
  runInNewContext(code, {
    module: mod,
    exports: mod.exports,
    File,
    Buffer,
    TextEncoder,
    AbortSignal,
    setTimeout,
    fetch: async (_url, options) => {
      if (signalCheck) options.signal.throwIfAborted();
      return new Response(response);
    },
    require: (name) => {
      if (name === "./prediction-rules-draft") return draft;
      if (name === "@ardrive/turbo-sdk/web")
        return {
          TurboFactory: {
            authenticated: (options) => {
              calls.adapter = options.walletAdapter;
              return {
                getFreeStatus: async () => ({ bytesRemaining }),
                uploadFile: async ({ file }) => {
                  calls.uploads++;
                  calls.content = await file.text();
                  await options.walletAdapter.signMessage(
                    new Uint8Array([1, 2, 3]),
                  );
                  return { id: "a".repeat(43) };
                },
              };
            },
          },
        };
      return require(name);
    },
  });
  return {
    ...mod.exports,
    calls,
    wallet: {
      publicKey: new PublicKey(Buffer.alloc(32, 2)),
      signMessage: async () => {
        calls.signatures++;
        return new Uint8Array(64);
      },
    },
  };
}

test("rules upload preserves reviewed bytes and receipt and cannot authorize SOL payments", async () => {
  const f = fixture();
  const receipt = await f.uploadArweaveRules("{}\n", f.wallet);
  assert.equal(f.calls.content, "{}\n");
  assert.equal(f.calls.signatures, 1);
  assert.equal(receipt.content, "{}\n");
  assert.equal(receipt.owner, f.wallet.publicKey.toBase58());
  assert.equal(receipt.uri, `ar://${"a".repeat(43)}`);
  await assert.rejects(
    f.calls.adapter.signTransaction(),
    /cannot authorize Solana payments/,
  );
  await f.verifyArweaveRules(receipt);
});

test("insufficient free allowance stops before upload or signing", async () => {
  const f = fixture({ bytesRemaining: 0 });
  await assert.rejects(
    f.uploadArweaveRules("{}\n", f.wallet),
    /free upload allowance/,
  );
  assert.equal(f.calls.uploads, 0);
  assert.equal(f.calls.signatures, 0);
});

test("gateway verification rejects changed bytes and honors navigation cancellation", async () => {
  const f = fixture({ response: "{}" });
  await assert.rejects(
    f.verifyArweaveRules({ id: "a".repeat(43), content: "{}\n" }),
    /incomplete/,
  );
  const mismatch = fixture({ response: "[]\n" });
  await assert.rejects(
    mismatch.verifyArweaveRules({ id: "a".repeat(43), content: "{}\n" }),
    /do not match/,
  );
  const canceled = fixture({ signalCheck: true }),
    controller = new AbortController();
  controller.abort();
  await assert.rejects(
    canceled.verifyArweaveRules(
      { id: "a".repeat(43), content: "{}\n" },
      controller.signal,
    ),
    { name: "AbortError" },
  );
});
