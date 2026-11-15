/** Local-only wallet/RPC fixture. No live keys or external ledger calls. */
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import {
  wallet,
  owner,
  mint,
  market,
  marketState,
  submissions,
  rpc,
  account,
} from "./fixtures/multi-outcome.mjs";
const require = createRequire(import.meta.url),
  { Transaction } = require("@solana/web3.js");
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright"
);
const base = new URL(
  process.env.MULTI_BROWSER_BASE_URL ?? "http://127.0.0.1:3017",
);
if (!["localhost", "127.0.0.1"].includes(base.hostname))
  throw new Error("Local fixtures only.");
const browser = await chromium.launch({
  executablePath: process.env.MULTI_BROWSER_EXECUTABLE,
  headless: true,
  args: ["--no-sandbox"],
});
try {
  const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    }),
    errors = [];
  page.on("pageerror", (e) => {
    errors.push(e.message);
    console.log("PAGE_ERROR", e.message);
  });
  await page.exposeFunction("fixtureSign", (encoded) => {
    const tx = Transaction.from(Buffer.from(encoded, "base64"));
    tx.partialSign(wallet);
    return tx.serialize().toString("base64");
  });
  await page.addInitScript(
    ({ address, publicKey }) => {
      sessionStorage.setItem("outcomia:active-chain", "solana");
      localStorage.setItem("walletName", JSON.stringify("Fixture Solana"));
      const account = {
        address,
        publicKey: new Uint8Array(publicKey),
        chains: ["solana:devnet"],
        features: ["solana:signTransaction"],
      };
      const w = {
        version: "1.0.0",
        name: "Fixture Solana",
        icon: "data:image/svg+xml;base64,PHN2Zy8+",
        chains: ["solana:devnet"],
        accounts: [account],
        features: {
          "standard:connect": {
            version: "1.0.0",
            connect: async () => ({ accounts: [account] }),
          },
          "standard:disconnect": {
            version: "1.0.0",
            disconnect: async () => {},
          },
          "standard:events": { version: "1.0.0", on: () => () => {} },
          "solana:signTransaction": {
            version: "1.0.0",
            supportedTransactionVersions: ["legacy", 0],
            signTransaction: async (...inputs) =>
              Promise.all(
                inputs.map(async (input) => {
                  const encoded = btoa(
                    String.fromCharCode(...input.transaction),
                  );
                  const signed = await window.fixtureSign(encoded);
                  return {
                    signedTransaction: Uint8Array.from(atob(signed), (c) =>
                      c.charCodeAt(0),
                    ),
                  };
                }),
              ),
          },
        },
      };
      const register = (api) => api.register(w);
      window.addEventListener("wallet-standard:app-ready", (e) =>
        register(e.detail),
      );
      window.dispatchEvent(
        new CustomEvent("wallet-standard:register-wallet", {
          detail: register,
        }),
      );
    },
    { address: owner.toBase58(), publicKey: [...owner.toBytes()] },
  );
  await page.route("**/*", async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    if (req.method() === "POST") {
      let data;
      try {
        data = req.postDataJSON();
      } catch {}
      if (data?.jsonrpc) {
        try {
          return route.fulfill({
            json: { jsonrpc: "2.0", id: data.id, result: await rpc(data) },
          });
        } catch (e) {
          console.log(e.message);
          return route.fulfill({
            json: {
              jsonrpc: "2.0",
              id: data.id,
              error: { code: -32601, message: e.message },
            },
          });
        }
      }
    }
    if (url.href === "https://example.com/rules")
      return route.fulfill({
        body: "Published rules for the fixture.",
        contentType: "text/plain",
        headers: { "access-control-allow-origin": "*" },
      });
    if (url.origin !== base.origin) return route.abort();
    return route.continue();
  });
  await page.goto(new URL("/predictions/multi", base).href);
  await page
    .getByRole("link", { name: /Which colour wins/ })
    .waitFor({ timeout: 120000 });
  await page.getByRole("link", { name: /Which colour wins/ }).click();
  await page
    .getByRole("heading", { name: "Which colour wins?", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("button", { name: "Cancel", exact: true })
    .waitFor({ state: "detached", timeout: 30000 });
  await page.getByLabel(/Limit price/).fill("0.4");
  await page.getByLabel(/Contracts \(multiples/).fill("3");
  await page
    .getByRole("button", { name: "Review in wallet", exact: true })
    .click();
  await page.waitForFunction(() =>
    document.body.textContent.includes("Confirmed:"),
  );
  assert.ok(submissions.includes("matchMultiOutcomeOrder"));
  marketState.status = { resolved: {} };
  marketState.finalOutcome = { winner: [[0]] };
  await account("multiOutcomeMarket", market, marketState);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page
    .getByRole("button", { name: "Redeem available contracts" })
    .waitFor();
  await page
    .getByRole("button", { name: "Redeem available contracts" })
    .click();
  await page.waitForFunction(() =>
    document.body.textContent.includes("Confirmed:"),
  );
  assert.ok(submissions.includes("redeemMultiOutcome"));
  await page.goto(new URL("/predictions/multi/new", base).href);
  await page
    .getByRole("heading", { name: "Create a multi-outcome market" })
    .waitFor();
  await page.getByLabel("Question / name").fill("Who wins?");
  await page.getByLabel(/Outcomes \(one per line/).fill("Red\nBlue\nGreen");
  await page.getByLabel(/I reviewed/).check();
  assert.equal(await page.getByLabel(/I reviewed/).isChecked(), true);
  await page.getByLabel("Question / name").fill("Changed terms");
  assert.equal(await page.getByLabel(/I reviewed/).isChecked(), false);
  await page
    .getByLabel("Collateral mint", { exact: true })
    .fill(mint.toBase58());
  await page.getByLabel("Collateral symbol", { exact: true }).fill("USDC");
  await page.getByLabel(/Trading closes/).fill("2033-05-18T12:00");
  await page
    .getByLabel("Published rules URI", { exact: true })
    .fill("https://example.com/rules");
  await page
    .getByLabel("Exact published rules document", { exact: true })
    .fill("Published rules for the fixture.");
  await page.getByLabel(/I reviewed/).check();
  await page.waitForFunction(() =>
    [...document.querySelectorAll("button")].some(
      (b) => b.textContent.includes("Review creation in wallet") && !b.disabled,
    ),
  );
  await page
    .getByRole("button", { name: "Review creation in wallet", exact: true })
    .click();
  await page
    .getByRole("link", { name: "Open created market →" })
    .waitFor({ timeout: 30000 });
  assert.ok(submissions.includes("initializeMultiOutcomeMarket"));
  await page.getByText("Recover uploaded-term rent", { exact: true }).click();
  await page
    .getByRole("button", { name: "Close upload and recover rent" })
    .click();
  await page
    .getByRole("button", { name: "Close upload and recover rent" })
    .waitFor({ state: "detached", timeout: 30000 });
  assert.ok(submissions.includes("closeMultiOutcomeTerms"));
  mkdirSync("target/multi-browser-artifacts", { recursive: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "target/multi-browser-artifacts/creation-mobile.png",
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: discovery, wallet connection, cancellation, trading, redemption, creation with verified rules, upload rent recovery and mobile layout.",
  );
} finally {
  await browser.close();
}
