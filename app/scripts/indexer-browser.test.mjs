/** Local API/DB fixture; the browser is forbidden from making a Solana RPC read. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createPrivateKey, sign } from "node:crypto";
import { mkdirSync } from "node:fs";
import { wallet, owner, market, rpc } from "./fixtures/multi-outcome.mjs";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ??
    "/tmp/outcomia-browser/node_modules/playwright/index.mjs"
);
const base = new URL(
  process.env.INDEXER_BROWSER_BASE_URL ?? "http://127.0.0.1:3024",
);
if (!["localhost", "127.0.0.1"].includes(base.hostname))
  throw new Error("Local fixture only");
// The backend wallet ingestion worker talks to this bounded fake upstream.
const upstream = createServer(async (request, response) => {
  let input = "";
  for await (const part of request) input += part;
  try {
    const body = JSON.parse(input);
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({ jsonrpc: "2.0", id: body.id, result: await rpc(body) }),
    );
  } catch {
    response.statusCode = 500;
    response.end();
  }
});
await new Promise((resolve) => upstream.listen(8085, "127.0.0.1", resolve));
const browser = await chromium.launch({
  executablePath:
    process.env.MULTI_BROWSER_EXECUTABLE ??
    "/home/shady/.cache/ms-playwright/chromium-1194/chrome-linux/chrome",
  headless: true,
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
let messages = 0,
  rpcReads = 0;
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const privateKey = createPrivateKey({
  key: Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    Buffer.from(wallet.secretKey.slice(0, 32)),
  ]),
  format: "der",
  type: "pkcs8",
});
await page.exposeFunction("fixtureSignMessage", (message) => {
  messages++;
  return sign(null, Buffer.from(message), privateKey).toString("base64");
});
await page.addInitScript(
  ({ address, publicKey }) => {
    sessionStorage.setItem("outcomia:active-chain", "solana");
    localStorage.setItem("walletName", JSON.stringify("Indexed Fixture"));
    const account = {
      address,
      publicKey: new Uint8Array(publicKey),
      chains: ["solana:devnet"],
      features: ["solana:signMessage", "solana:signTransaction"],
    };
    const adapter = {
      version: "1.0.0",
      name: "Indexed Fixture",
      icon: "data:image/svg+xml;base64,PHN2Zy8+",
      chains: ["solana:devnet"],
      accounts: [account],
      features: {
        "standard:connect": {
          version: "1.0.0",
          connect: async () => ({ accounts: [account] }),
        },
        "standard:disconnect": { version: "1.0.0", disconnect: async () => {} },
        "standard:events": { version: "1.0.0", on: () => () => {} },
        "solana:signTransaction": {
          version: "1.0.0",
          supportedTransactionVersions: ["legacy", 0],
          signTransaction: async () => {
            throw new Error("This read test must not submit a transaction");
          },
        },
        "solana:signMessage": {
          version: "1.0.0",
          signMessage: async (...inputs) =>
            Promise.all(
              inputs.map(async (input) => ({
                signedMessage: input.message,
                signature: Uint8Array.from(
                  atob(await window.fixtureSignMessage([...input.message])),
                  (c) => c.charCodeAt(0),
                ),
              })),
            ),
        },
      },
    };
    const register = (api) => api.register(adapter);
    window.addEventListener("wallet-standard:app-ready", (event) =>
      register(event.detail),
    );
    window.dispatchEvent(
      new CustomEvent("wallet-standard:register-wallet", { detail: register }),
    );
  },
  { address: owner.toBase58(), publicKey: [...owner.toBytes()] },
);
await page.route("**/*", (route) => {
  const request = route.request(),
    url = new URL(request.url());
  if (request.method() === "POST") {
    try {
      if (request.postDataJSON()?.jsonrpc) {
        rpcReads++;
        return route.abort();
      }
    } catch {}
  }
  return url.origin === base.origin ? route.continue() : route.abort();
});
try {
  await page.goto(new URL(`/predictions/multi/${market}`, base).href);
  await page
    .getByText("Signed in", { exact: true })
    .waitFor({ timeout: 60000 });
  await page
    .getByRole("heading", { name: "Which colour wins?", exact: true })
    .waitFor();
  await page.getByRole("img", { name: /Candlestick chart/ }).waitFor();
  assert.equal(messages, 1, "First login signs exactly one challenge");
  const quantity = page.getByLabel(/Contracts \(multiples/);
  await quantity.fill("12");
  for (const kind of ["OHLC bars", "Line", "Area", "Candlestick"]) {
    await page.getByLabel("Chart type", { exact: true }).selectOption(kind);
    await page
      .getByRole("img", { name: new RegExp(`${kind} chart`) })
      .waitFor();
  }
  await page.getByLabel("Chart outcome", { exact: true }).selectOption("1");
  await page
    .getByText("No executions in this range.", { exact: true })
    .waitFor();
  assert.equal(await page.locator(".chart-plot").count(), 0);
  await page.getByLabel("Chart outcome", { exact: true }).selectOption("0");
  await page.getByRole("img", { name: /Candlestick chart/ }).waitFor();
  await fetch("http://127.0.0.1:8084/fixture/update", { method: "POST" });
  await page.getByText(/^Available collateral:\s*77\./).waitFor();
  assert.equal(
    await quantity.inputValue(),
    "12",
    "Live data refresh must preserve the trade draft",
  );
  await page.goto(new URL("/wallet", base).href);
  await page.getByText("Signed in", { exact: true }).waitFor();
  await page.waitForFunction(
    () =>
      document
        .querySelector(".wallet-summary article strong")
        ?.textContent.replace(/\s+/g, " ")
        .trim() === "1 SOL",
    { timeout: 30000 },
  );
  assert.equal(
    messages,
    1,
    "A valid session is reused without another signature",
  );
  mkdirSync("target/indexer-browser-artifacts", { recursive: true });
  await page.goto(new URL(`/predictions/multi/${market}`, base).href);
  await page.getByRole("img", { name: /Candlestick chart/ }).waitFor();
  await page.screenshot({
    path: "target/indexer-browser-artifacts/chart-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "target/indexer-browser-artifacts/chart-mobile.png",
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  assert.equal(rpcReads, 0, "Indexed page rendering must not call Solana RPC");
  assert.deepEqual(errors, []);
  const [logout] = await Promise.all([
    page.waitForResponse((response) =>
      response.url().endsWith("/api/indexer/auth/logout"),
    ),
    page.getByRole("button", { name: "Disconnect", exact: true }).click(),
  ]);
  assert.equal(logout.status(), 204);
  const session = await page.evaluate(() =>
    fetch("/api/indexer/auth/me", { cache: "no-store" }).then((response) =>
      response.json(),
    ),
  );
  assert.equal(session, null);
  console.log(
    "PASS: real API/DB login and session reuse, four chart types, empty intervals, live revisions, preserved trade draft, wallet holdings, mobile layout and zero browser RPC reads.",
  );
} catch (error) {
  mkdirSync("target/indexer-browser-artifacts", { recursive: true });
  await page
    .screenshot({
      path: "target/indexer-browser-artifacts/failure.png",
      fullPage: true,
    })
    .catch(() => {});
  console.error(
    await page
      .locator("main")
      .innerText()
      .catch(() => "No main view"),
  );
  throw error;
} finally {
  await browser.close();
  await new Promise((resolve) => upstream.close(resolve));
}
