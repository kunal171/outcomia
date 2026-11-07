import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
const css = readFileSync(new URL("../app/theme.css", import.meta.url), "utf8");
function palette(selector) {
  const start = css.indexOf(selector);
  const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
  return Object.fromEntries(
    [...body.matchAll(/--([\w-]+):\s*(#[\da-f]{6})/gi)].map(([, key, hex]) => [
      key,
      hex,
    ]),
  );
}
function luminance(hex) {
  const rgb = [1, 3, 5]
    .map((index) => parseInt(hex.slice(index, index + 2), 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
function contrast(a, b) {
  const [high, low] = [luminance(a), luminance(b)].sort((a, b) => b - a);
  return (high + 0.05) / (low + 0.05);
}
for (const [name, selector] of [
  ["dark", ":root {"],
  ["light", ':root[data-theme="light"]'],
]) {
  const colors = palette(selector);
  test(`${name}: primary, secondary and action text retain AA contrast`, () => {
    const pairs = [
      ...["background", "panel", "surface-inset"].flatMap((surface) =>
        ["ink", "muted", "accent", "buy", "sell"].map((foreground) => [
          foreground,
          surface,
        ]),
      ),
      ["accent-ink", "accent"],
      ["outcome-ink", "buy"],
      ["outcome-ink", "sell"],
    ];
    for (const [foreground, background] of pairs) {
      assert.ok(
        colors[foreground] && colors[background],
        `Missing ${foreground}/${background}`,
      );
      assert.ok(
        contrast(colors[foreground], colors[background]) >= 4.5,
        `${name} ${foreground}/${background}: ${contrast(colors[foreground], colors[background]).toFixed(2)}`,
      );
    }
  });
}
test("System mode follows the OS without a script or storage read before paint", () => {
  assert.match(css, /@media\s*\(prefers-color-scheme:\s*light\)/);
  assert.match(css, /:root\[data-theme="system"\]/);
});
