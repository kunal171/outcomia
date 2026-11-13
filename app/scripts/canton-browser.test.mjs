/** Local browser integration with fixture contracts and an extension bridge mock.
 * All external requests are blocked. No real wallet or ledger submission occurs.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import {
  snapshot,
  owned,
  c,
  key,
  terms,
  book,
  event,
} from "./fixtures/canton.mjs";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright"
);
const base = new URL(
  process.env.CANTON_BROWSER_BASE_URL ?? "http://127.0.0.1:3016",
);
if (!["127.0.0.1", "localhost"].includes(base.hostname))
  throw new Error("Browser fixtures require a local test server.");
const output =
  process.env.CANTON_BROWSER_OUTPUT ?? "target/canton-browser-artifacts";
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CANTON_BROWSER_EXECUTABLE,
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
    console.log("BROWSER_ERROR", e.stack);
  });
  const party = "alice::1220test",
    publicData = structuredClone(snapshot),
    privateData = structuredClone(owned);
  publicData.contracts.forEach((c) => {
    if (c.data.creator === "alice") c.data.creator = party;
    if (c.kind === "Protocol") c.data.admins = ["operator", party];
  });
  privateData.forEach((c) => (c.data.owner = party));
  const order = c("LimitOrder", "cancel-me", {
    key,
    owner: party,
    instrument: terms.collateral,
    factory: "factory",
    side: "Buy",
    outcome: "Yes",
    price: "0.4",
    quantity: "1",
  });
  privateData.push(order);
  publicData.contracts.find((c) => c.kind === "OrderBook").data.orders = [
    { order: order.id },
  ];
  await page.route("**/*", async (route) => {
    const u = new URL(route.request().url());
    if (u.origin !== base.origin) return route.abort();
    if (u.pathname === "/api/canton/catalog") {
      const count = await page.evaluate(() => window.__commands?.length ?? 0);
      if (count) {
        const book = publicData.contracts.find((c) => c.kind === "OrderBook");
        book.id = "book-next";
        book.data.orders = [];
      }
      return route.fulfill({ json: publicData });
    }
    if (u.pathname === "/api/canton/context")
      return route.fulfill({
        json: {
          party,
          network: snapshot.deployment.network,
          extraArgs: { context: { values: [] }, meta: { values: {} } },
          disclosedContracts: [],
        },
      });
    return route.continue();
  });
  await page.addInitScript(
    ({ privateData, party }) => {
      sessionStorage.setItem("outcomia:active-chain", "canton");
      sessionStorage.setItem("outcomia-canton:wallet", "console");
      window.__private = privateData;
      window.__commands = [];
      window.addEventListener("message", (e) => {
        const m = e.data;
        if (
          m?.target !== "consoleWalletPixelplex" ||
          m.type.endsWith("_RESPONSE")
        )
          return;
        let data;
        switch (m.type) {
          case "GET_STATUS":
            data = {
              connection: { isConnected: true, isNetworkConnected: true },
              network: { networkId: "canton:testnet" },
            };
            break;
          case "GET_ACTIVE_ACCOUNT":
            data = {
              partyId: party,
              primary: true,
              status: "allocated",
              networkId: "CANTON_NETWORK_TEST",
              publicKey: "test-public",
            };
            break;
          case "GET_ACTIVE_NETWORK":
            data = { networkId: "canton:testnet" };
            break;
          case "GET_ACTIVE_CONTRACTS":
            data = {
              items: window.__private.map((x) => ({
                contractEntry: {
                  JsActiveContract: {
                    createdEvent: {
                      contractId: x.id,
                      templateId: x.templateId,
                      createArgument: x.data,
                      createdEventBlob: x.blob,
                    },
                  },
                },
              })),
            };
            break;
          case "GET_COINS_BALANCE":
            data = { tokens: [] };
            break;
          case "EXECUTE_AND_WAIT":
            window.__commands.push(m);
            const choice = m.commands[0].ExerciseCommand.choice;
            window.__private = window.__private.filter((c) =>
              choice === "SettledReserve_Redeem"
                ? c.kind !== "PositionLot"
                : c.id !== "cancel-me",
            );
            data = {
              tx: {
                status: "executed",
                commandId: m.commandId,
                payload: { updateId: "mock-update" },
              },
            };
            break;
          default:
            return;
        }
        setTimeout(
          () =>
            window.postMessage(
              { target: m.target, type: m.type + "_RESPONSE", id: m.id, data },
              "*",
            ),
          0,
        );
      });
    },
    { privateData, party },
  );
  await page.goto(new URL("/canton/markets", base).href);
  await page
    .getByRole("link", { name: terms.question })
    .waitFor({ timeout: 120000 });
  await page.getByRole("link", { name: terms.question }).click();
  await page.getByRole("heading", { name: terms.question }).waitFor();
  await page.getByLabel("Price", { exact: true }).fill("0.40");
  await page.getByLabel("Contracts", { exact: true }).fill("3");
  await page.getByText("Maximum debit:").waitFor();
  assert.ok((await page.locator("body").innerText()).includes("1.203"));
  await page.screenshot({
    path: join(output, "market-desktop.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Rules", exact: true }).click();
  await page.getByText("Two launches", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Manage", exact: true }).click();
  await page
    .getByRole("button", { name: "Close market", exact: true })
    .waitFor();
  await page.getByRole("link", { name: "Orders", exact: true }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByText("Transaction confirmed:", { exact: false }).waitFor();
  await page.getByText("No open orders.", { exact: true }).waitFor();
  const commands = await page.evaluate(() => window.__commands);
  assert.equal(commands.length, 1);
  assert.equal(
    commands[0].commands[0].ExerciseCommand.choice,
    "OrderBook_Cancel",
  );
  assert.deepEqual(commands[0].actAs, [party]);
  await page.getByRole("link", { name: "Positions", exact: true }).click();
  await page.getByText("YES 5 · NO 5").waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: join(output, "positions-mobile.png"),
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );
  publicData.contracts = publicData.contracts.filter(
    (c) => c.kind !== "BinaryMarket",
  );
  publicData.contracts.push(
    c("FinalResolution", "final", {
      proposal: {
        key,
        creator: party,
        terms,
        outcome: "YesWins",
        finalizableAt: "2026-01-01T00:00:00Z",
      },
    }),
    c("SettledReserve", "settled", {
      key,
      vault: snapshot.deployment.vault,
      creator: party,
      terms,
      factory: "factory",
      assetDecimals: "6",
      outcome: "YesWins",
      yesOutstanding: "5",
      noOutstanding: "5",
      remainingCollateral: "5",
    }),
  );
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByRole("button", { name: "Claim", exact: true }).waitFor();
  await page.getByRole("button", { name: "Claim", exact: true }).click();
  await page.getByText("No positions yet.", { exact: true }).waitFor();
  const claimed = await page.evaluate(() => window.__commands);
  assert.equal(
    claimed.at(-1).commands[0].ExerciseCommand.choice,
    "SettledReserve_Redeem",
  );
  assert.deepEqual(
    claimed.at(-1).commands[0].ExerciseCommand.choiceArgument.positions,
    ["position"],
  );
  publicData.contracts = publicData.contracts.filter(
    (c) => c.kind !== "AssetAdmission",
  );
  publicData.contracts.find((c) => c.kind === "SettledReserve").id =
    "settled-next";
  await page.evaluate(() => {
    window.__private = window.__private
      .filter((c) => c.kind === "AssetBalance")
      .map((c) => ({ ...c, data: { ...c.data, available: "0", cash: null } }));
  });
  await page.getByRole("link", { name: "Wallet", exact: true }).click();
  await page.getByRole("heading", { name: "Trading balances" }).waitFor();
  await page
    .getByRole("button", { name: "Refresh", exact: true })
    .last()
    .click();
  await page.getByRole("button", { name: "Withdraw", exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Withdraw", exact: true })
      .isDisabled(),
    true,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Deposit", exact: true })
      .isDisabled(),
    true,
  );
  await page.getByRole("heading", { name: "USD", exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "PASS: wallet restore, discovery, detail quote, rules, admin controls, cancellation submission/refresh, positions, redemption submission/refresh, revoked-asset exits, zero-balance withdrawal controls and mobile layout; no browser errors.",
  );
} finally {
  await browser.close();
}
