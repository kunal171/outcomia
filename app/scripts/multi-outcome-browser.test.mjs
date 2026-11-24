/** Local-only wallet/RPC fixture. No live keys or external ledger calls. */
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import {
  setMarketMissing,
  setAskLadder,
  setLedgerNow,
  wallet,
  owner,
  mint,
  market,
  marketState,
  submissions,
  creations,
  rpc,
  account,
} from "./fixtures/multi-outcome.mjs";
const require = createRequire(import.meta.url),
  { Transaction } = require("@solana/web3.js");
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright"
);
const base = new URL(
  process.env.MULTI_BROWSER_BASE_URL ?? "http://localhost:3017",
);
if (!["localhost", "127.0.0.1"].includes(base.hostname))
  throw new Error("Local fixtures only.");
const browser = await chromium.launch({
  executablePath: process.env.MULTI_BROWSER_EXECUTABLE,
  headless: true,
  args: ["--no-sandbox"],
});
let page;
try {
  page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => {
    errors.push(e.message);
    console.log("PAGE_ERROR", e.message);
  });
  let rejectSignature = false,
    signCalls = 0,
    publishedRules = "",
    holdRules = false,
    releaseRules;
  let announceRules;
  const rulesStarted = new Promise((resolve) => {
    announceRules = resolve;
  });
  await page.exposeFunction("fixtureSign", (encoded) => {
    signCalls++;
    if (rejectSignature) {
      rejectSignature = false;
      throw new Error("Fixture wallet rejected the transaction");
    }
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
    if (url.href === "https://example.com/rules") {
      if (holdRules) {
        announceRules();
        await new Promise((resolve) => {
          releaseRules = resolve;
        });
      }
      try {
        return await route.fulfill({
          body: publishedRules,
          contentType: "text/plain",
          headers: { "access-control-allow-origin": "*" },
        });
      } catch (error) {
        if (!holdRules) throw error;
        return;
      }
    }
    if (url.origin !== base.origin) return route.abort();
    return route.continue();
  });
  if (process.env.MULTI_BROWSER_DISABLED === "true") {
    await page.goto(new URL("/predictions/multi/new", base).href);
    await page
      .getByRole("heading", {
        name: "Create a multi-outcome market",
        exact: true,
      })
      .waitFor({ timeout: 120000 });
    await page
      .getByText(
        "Creation is disabled until the matching program deployment is verified.",
        { exact: true },
      )
      .waitFor();
    await page.getByLabel(/I reviewed/).check();
    assert.equal(
      await page
        .getByRole("button", {
          name: "Upload rules & create draft",
          exact: true,
        })
        .isDisabled(),
      true,
    );
    assert.equal(submissions.length, 0);
    console.log(
      "PASS: unverified deployment disables creation and submits no transactions.",
    );
  } else {
    if (process.env.MULTI_BROWSER_CREATION_ONLY !== "true") {
      await page.goto(new URL("/wallet", base).href);
      await page
        .getByRole("heading", { name: "Multi-outcome positions", exact: true })
        .waitFor({ timeout: 120000 });
      await page.getByRole("link", { name: "Manage position →" }).waitFor();
      await page.goto(new URL("/orders", base).href);
      await page
        .getByRole("heading", { name: "Multi-outcome orders", exact: true })
        .waitFor();
      await page
        .getByRole("link", { name: /Which colour wins/ })
        .first()
        .waitFor();
      await page.goto(new URL("/predictions/multi", base).href);
      await page
        .getByRole("link", { name: /Which colour wins/ })
        .waitFor({ timeout: 120000 });
      await page.getByRole("link", { name: /Which colour wins/ }).click();
      await page
        .getByRole("heading", { name: "Which colour wins?", exact: true })
        .waitFor();
      setMarketMissing(true);
      await page
        .getByRole("button", { name: "Refresh market", exact: true })
        .click();
      await page
        .getByText("Multi-outcome market not found on this network.", {
          exact: true,
        })
        .waitFor();
      assert.equal(
        await page
          .getByRole("button", { name: "Refresh market", exact: true })
          .isEnabled(),
        true,
      );
      setMarketMissing(false);
      await page
        .getByRole("button", { name: "Refresh market", exact: true })
        .click();
      await page
        .getByRole("heading", { name: "Which colour wins?", exact: true })
        .waitFor();
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await page
        .getByRole("button", { name: "Cancel", exact: true })
        .waitFor({ state: "detached", timeout: 30000 });
      await page.getByLabel(/Limit price/).fill("0.4");
      await page.getByLabel(/Contracts \(multiples/).fill("3");
      rejectSignature = true;
      await page
        .getByRole("button", { name: "Review in wallet", exact: true })
        .click();
      await page
        .getByRole("main")
        .getByText("Fixture wallet rejected the transaction", { exact: true })
        .waitFor();
      assert.equal(
        await page.getByLabel(/Contracts \(multiples/).inputValue(),
        "3",
      );
      assert.equal(
        submissions.filter((n) => n === "matchMultiOutcomeOrder").length,
        0,
      );

      await page
        .getByRole("button", { name: "Review in wallet", exact: true })
        .click();
      await page.waitForFunction(() =>
        document.body.textContent.includes("Transaction confirmed"),
      );
      assert.ok(submissions.includes("matchMultiOutcomeOrder"));
      await page.waitForFunction(
        () =>
          document.querySelector('input[inputmode="numeric"]')?.value === "",
      );
      await setAskLadder(4);
      await page
        .getByRole("button", { name: "Refresh market", exact: true })
        .click();
      await page.getByLabel(/Contracts \(multiples/).fill("12");
      await page
        .getByRole("button", { name: "Review in wallet", exact: true })
        .click();
      await page.waitForFunction(
        () =>
          document.querySelector('input[inputmode="numeric"]')?.value === "3",
      );
      assert.equal(
        submissions.filter((n) => n === "matchMultiOutcomeOrder").length,
        4,
      );
      assert.ok(
        (await page.locator("body").innerText()).includes(
          "3 contracts remain unsubmitted",
        ),
      );
      await page
        .getByRole("button", { name: "Review in wallet", exact: true })
        .click();
      await page.waitForFunction(
        () =>
          document.querySelector('input[inputmode="numeric"]')?.value === "",
      );
      assert.equal(
        submissions.filter((n) => n === "matchMultiOutcomeOrder").length,
        5,
      );
      // Fee withdrawal sits on the super-admin Manage market tab.
      await page.getByRole("tab", { name: "Manage market" }).click();
      await page.getByText("Protocol fees", { exact: true }).click();
      await page.getByLabel(/Fee withdrawal/).fill("0.01");
      await page
        .getByRole("button", { name: "Withdraw earned fees", exact: true })
        .click();
      await page.waitForFunction(() =>
        document.body.textContent.includes("Transaction confirmed"),
      );
      assert.ok(submissions.includes("withdrawMultiOutcomeFees"));
      await page.clock.setFixedTime(new Date(2000000005 * 1000));
      setLedgerNow(2000000005);
      // Resolution actions sit on the Rules & outcome tab.
      await page.getByRole("tab", { name: "Rules & outcome" }).click();
      await page
        .getByRole("button", { name: "Freeze at cutoff", exact: true })
        .click();
      await page
        .getByLabel("Evidence URI", { exact: true })
        .fill("ar://evidence");
      await page
        .getByLabel("Evidence SHA-256", { exact: true })
        .fill("12".repeat(32));
      await page
        .getByRole("form", { name: "Resolution proposal" })
        .getByRole("combobox")
        .selectOption("0");
      await page
        .getByRole("button", { name: "Review proposal in wallet", exact: true })
        .click();
      await page.getByRole("heading", { name: "Correct proposal" }).waitFor();
      await page.clock.setFixedTime(new Date(2000000065 * 1000));
      await page
        .getByRole("button", { name: "Finalize outcome", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Refresh market", exact: true })
        .click();
      // Redemption sits on the Your position tab.
      await page.getByRole("tab", { name: "Your position" }).click();
      await page
        .getByRole("button", { name: "Redeem available contracts" })
        .waitFor();
      await page
        .getByRole("button", { name: "Redeem available contracts" })
        .click();
      await page.waitForFunction(() =>
        document.body.textContent.includes("Transaction confirmed"),
      );
      assert.ok(submissions.includes("redeemMultiOutcome"));
    }
    await page.goto(new URL("/predictions/multi/new", base).href);
    await page
      .getByRole("heading", { name: "Create a multi-outcome market" })
      .waitFor();
    await page
      .getByLabel("Short display name", { exact: true })
      .fill("Who wins?");
    await page.getByLabel(/Outcomes \(one per line/).fill("Red\nBlue\nGreen");
    await page.getByLabel(/I reviewed/).check();
    assert.equal(await page.getByLabel(/I reviewed/).isChecked(), true);
    await page
      .getByLabel("Short display name", { exact: true })
      .fill("Changed terms");
    assert.equal(await page.getByLabel(/I reviewed/).isChecked(), false);
    await page
      .getByLabel("Collateral mint", { exact: true })
      .fill(mint.toBase58());
    await page.getByLabel("Collateral symbol", { exact: true }).fill("USDC");
    await page
      .getByLabel("Trading close (local time)", { exact: true })
      .fill("2033-05-18T12:00");
    assert.equal(
      await page
        .getByRole("button", {
          name: "Upload rules & create draft",
          exact: true,
        })
        .count(),
      1,
    );
    await page
      .getByText("Already published these rules?", { exact: true })
      .click();
    await page
      .getByLabel("Use an existing rules document", { exact: true })
      .check();
    await page
      .getByLabel("Published rules URI", { exact: true })
      .fill("https://example.com/rules");
    await page
      .getByLabel("Full question", { exact: true })
      .fill("Which colour wins?");
    await page
      .getByLabel("Authoritative resolution source", { exact: true })
      .fill("https://example.com/results");
    for (let i = 1; i <= 3; i++)
      await page
        .getByLabel(`Outcome ${i} criteria`, { exact: true })
        .fill(`Outcome ${i} is the declared winner.`);
    publishedRules = await page
      .locator(".rules-json-preview pre")
      .textContent();
    await page.getByLabel(/I reviewed/).check();
    await page.waitForFunction(() =>
      [...document.querySelectorAll("button")].some(
        (b) =>
          b.textContent.includes("Review creation in wallet") && !b.disabled,
      ),
    );
    mkdirSync("target/multi-browser-artifacts", { recursive: true });
    await page.screenshot({
      path: "target/multi-browser-artifacts/creation-desktop.png",
      fullPage: true,
    });
    const reviewedJSON = publishedRules,
      beforeCreation = submissions.length;
    publishedRules += " ";
    await page
      .getByRole("button", { name: "Review creation in wallet", exact: true })
      .click();
    await page
      .getByText("Published rules differ from the reviewed document.", {
        exact: true,
      })
      .waitFor();
    assert.equal(
      submissions.length,
      beforeCreation,
      "Mismatched published rules must stop before wallet submission",
    );
    publishedRules = reviewedJSON;
    await page
      .getByRole("button", { name: "Review creation in wallet", exact: true })
      .click();
    await page
      .getByRole("link", { name: "Open created market →" })
      .waitFor({ timeout: 30000 });
    assert.ok(submissions.includes("initializeMultiOutcomeMarket"));
    assert.equal(
      Buffer.from(creations[0].terms.rulesHash).toString("hex"),
      createHash("sha256").update(reviewedJSON).digest("hex"),
    );
    assert.equal(
      Buffer.from(creations[0].terms.questionHash).toString("hex"),
      createHash("sha256").update("Which colour wins?").digest("hex"),
    );
    assert.deepEqual(creations[0].terms.outcomeLabels, [
      "Red",
      "Blue",
      "Green",
    ]);
    await page.getByText("Recover uploaded-term rent", { exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      true,
      "Expanded rent recovery must fit the mobile screen",
    );
    await page.setViewportSize({ width: 1440, height: 1000 });
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
    await page.goto(new URL("/predictions/multi/new", base).href);
    await page
      .getByLabel("Short display name", { exact: true })
      .fill("Canceled creation");
    await page.getByLabel(/Outcomes \(one per line/).fill("Red\nBlue\nGreen");
    await page
      .getByLabel("Collateral mint", { exact: true })
      .fill(mint.toBase58());
    await page.getByLabel("Collateral symbol", { exact: true }).fill("USDC");
    await page
      .getByLabel("Trading close (local time)", { exact: true })
      .fill("2040-05-18T12:00");
    assert.equal(
      await page
        .getByRole("button", {
          name: "Upload rules & create draft",
          exact: true,
        })
        .count(),
      1,
    );
    await page
      .getByText("Already published these rules?", { exact: true })
      .click();
    await page
      .getByLabel("Use an existing rules document", { exact: true })
      .check();
    await page
      .getByLabel("Published rules URI", { exact: true })
      .fill("https://example.com/rules");
    await page
      .getByLabel("Full question", { exact: true })
      .fill("Which colour wins?");
    await page
      .getByLabel("Authoritative resolution source", { exact: true })
      .fill("https://example.com/results");
    for (let i = 1; i <= 3; i++)
      await page
        .getByLabel(`Outcome ${i} criteria`, { exact: true })
        .fill(`Outcome ${i} is the declared winner.`);
    publishedRules = await page
      .locator(".rules-json-preview pre")
      .textContent();
    await page.getByLabel(/I reviewed/).check();
    holdRules = true;
    await page
      .getByRole("button", { name: "Review creation in wallet", exact: true })
      .click();
    await Promise.race([
      rulesStarted,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("Pending rules request was not started")),
          15000,
        ),
      ),
    ]);
    const signedBeforeNavigation = signCalls,
      submittedBeforeNavigation = submissions.length;
    await page.goto(new URL("/predictions/multi", base).href);
    releaseRules();
    await page.waitForTimeout(250);
    assert.equal(
      signCalls,
      signedBeforeNavigation,
      "Navigating away must cancel a pending rules check before wallet approval",
    );
    assert.equal(submissions.length, submittedBeforeNavigation);
    console.log(
      process.env.MULTI_BROWSER_CREATION_ONLY === "true"
        ? "PASS: structured creation, exact published bytes and hashes, review reset, rent recovery, navigation cancellation and mobile layout."
        : "PASS: wallet/orders integration, rejected approvals, recovery, capped retries, fees, resolution, redemption, structured creation and mobile layout.",
    );
  }
} catch (error) {
  if (page) {
    mkdirSync("target/multi-browser-artifacts", { recursive: true });
    await page
      .screenshot({
        path: "target/multi-browser-artifacts/failure.png",
        fullPage: true,
      })
      .catch(() => {});
    console.error(
      "FIXTURE_UI",
      await page
        .locator("main")
        .innerText()
        .catch(() => "No main view"),
    );
  }
  throw error;
} finally {
  await browser.close();
}
