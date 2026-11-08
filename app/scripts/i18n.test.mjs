import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
const require = createRequire(import.meta.url);
const ts = require("typescript");
const root = new URL("../", import.meta.url);
const catalogs = Object.fromEntries(
  ["en", "hi", "es", "fr", "pt"].map((locale) => [
    locale,
    JSON.parse(
      readFileSync(new URL(`i18n/messages/${locale}.json`, root), "utf8"),
    ),
  ]),
);
const keys = Object.keys(catalogs.en).sort();
const placeholders = (text) =>
  [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
for (const [locale, catalog] of Object.entries(catalogs)) {
  test(`${locale}: complete catalog and unchanged interpolation arguments`, () => {
    assert.deepEqual(Object.keys(catalog).sort(), keys);
    for (const key of keys) {
      assert.equal(typeof catalog[key], "string", `${locale}: ${key}`);
      assert.ok(catalog[key].trim(), `${locale}: empty ${key}`);
      assert.deepEqual(
        placeholders(catalog[key]),
        placeholders(key),
        `${locale}: ${key}`,
      );
    }
    for (const identity of ["YES", "NO", "Devnet", "Tidebook SOL / USDC"])
      assert.equal(catalog[identity], identity);
    if (locale !== "en")
      for (const key of [
        "Wallet",
        "Buy",
        "Sell",
        "Predictions",
        "Rules & outcome",
        "Appearance",
      ])
        assert.notEqual(catalog[key], key);
  });
}
// Audit actual TSX calls so adding a new label without updating every catalog fails.
test("all literal translation calls have catalog entries", () => {
  const components = new URL("components/", root);
  for (const name of readdirSync(components, { recursive: true }).filter(
    (name) => name.endsWith(".tsx"),
  )) {
    const ast = ts.createSourceFile(
      name,
      readFileSync(new URL(name, components), "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    function visit(node) {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(ast) === "t" &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        assert.ok(
          Object.hasOwn(catalogs.en, node.arguments[0].text),
          `${name}: ${node.arguments[0].text}`,
        );
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
});
function load(name) {
  const exports = {};
  runInNewContext(
    ts.transpileModule(readFileSync(new URL(`i18n/${name}.ts`, root), "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
      },
    }).outputText,
    {
      exports,
      require: (path) =>
        path.endsWith(".json")
          ? catalogs[path.split("/").at(-1).replace(".json", "")]
          : {},
    },
  );
  return exports;
}
const { message, interpolate } = load("catalog");
const { isLocale, isTheme } = load("config");
test("external diagnostics and unknown source text remain verbatim", () => {
  for (const locale of Object.keys(catalogs)) {
    assert.equal(
      message(locale, "RPC 429: provider diagnostic"),
      "RPC 429: provider diagnostic",
    );
    assert.equal(
      message(locale, "Creator question: will YES win?"),
      "Creator question: will YES win?",
    );
  }
});
test("interpolation preserves exact token amounts and never evaluates content", () => {
  assert.equal(
    interpolate(message("fr", "Amount ({value0})"), { value0: "tUSDC" }),
    "Montant (tUSDC)",
  );
  assert.equal(
    interpolate("{amount} {symbol}", {
      amount: "18446744073.709551615",
      symbol: "tSOL",
    }),
    "18446744073.709551615 tSOL",
  );
  assert.equal(
    interpolate("{value0}", { value0: "<script>alert(1)</script>" }),
    "<script>alert(1)</script>",
  );
  assert.equal(interpolate("{missing}", {}), "{missing}");
});
test("cookie preferences accept only supported values", () => {
  for (const value of ["en", "hi", "es", "fr", "pt"])
    assert.equal(isLocale(value), true);
  for (const value of ["system", "light", "dark"])
    assert.equal(isTheme(value), true);
  for (const value of ["../../file", "<script>", "en-US", null, undefined, 5])
    assert.equal(isLocale(value), false);
  for (const value of ["auto", "Light", null, undefined])
    assert.equal(isTheme(value), false);
});

const BN = require("@anchor-lang/core").BN;
const display = {};
runInNewContext(
  ts.transpileModule(
    readFileSync(new URL("lib/prediction-display.ts", root), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS } },
  ).outputText,
  {
    exports: display,
    require: () => ({
      predictionTime: (value) => `${value.toString()} Unix seconds`,
    }),
  },
);
test("deadlines retain UTC and review periods localize without rounding integers", () => {
  const deadline = new BN("1794130200");
  for (const locale of Object.keys(catalogs)) {
    assert.match(display.predictionCloseLabel(deadline, locale), /UTC$/);
    assert.match(display.predictionCloseLabel(deadline, locale), /2026/);
  }
  assert.equal(display.predictionReviewLabel(new BN(3600), "fr"), "1 heure");
  assert.equal(display.predictionReviewLabel(new BN(7200), "es"), "2 horas");
  assert.equal(
    display.predictionReviewLabel(new BN("18446744073709551615"), "en"),
    "18446744073709551615 seconds",
  );
  assert.equal(
    display.predictionCloseLabel(new BN("18446744073709551615"), "hi"),
    "18446744073709551615 Unix seconds",
  );
});
