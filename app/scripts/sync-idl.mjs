// Preserve documentation and top-level entry order while syncing the generated ABI.
import { readFileSync, writeFileSync } from "node:fs";
import { mergeIdl, canonicalIdl } from "./support/idl-sync.mjs";
const source = new URL("../../target/idl/outcomia.json", import.meta.url);
const target = new URL("../idl/outcomia.json", import.meta.url);
const old = JSON.parse(readFileSync(target)),
  generated = JSON.parse(readFileSync(source));
if (process.argv.includes("--check")) {
  if (
    JSON.stringify(canonicalIdl(old)) !==
    JSON.stringify(canonicalIdl(generated))
  )
    throw new Error(
      "App IDL differs from the generated program ABI. Rebuild and run npm run idl:sync.",
    );
  console.log("App IDL matches the generated program ABI.");
} else
  writeFileSync(
    target,
    JSON.stringify(mergeIdl(old, generated), null, 2) + "\n",
  );
