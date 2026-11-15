// Preserve existing documentation and entry order while syncing the generated ABI.
import { readFileSync, writeFileSync } from "node:fs";
const source = new URL("../../target/idl/outcomia.json", import.meta.url);
const target = new URL("../idl/outcomia.json", import.meta.url);
function abi(value) {
  if (Array.isArray(value)) return value.map(abi);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .filter((k) => k !== "docs")
        .sort()
        .map((k) => [k, abi(value[k])]),
    );
  return value;
}
function merge(old, next, top = false) {
  if (old && JSON.stringify(abi(old)) === JSON.stringify(abi(next))) return old;
  if (Array.isArray(next)) {
    if (
      top &&
      next.every(
        (v) => v && typeof v === "object" && typeof v.name === "string",
      ) &&
      Array.isArray(old)
    ) {
      const byName = new Map(next.map((v) => [v.name, v]));
      return [
        ...old
          .filter((v) => byName.has(v.name))
          .map((v) => merge(v, byName.get(v.name))),
        ...next.filter((v) => !old.some((o) => o.name === v.name)),
      ];
    }
    return next;
  }
  if (next && typeof next === "object") {
    const out = {};
    for (const key of new Set([
      ...Object.keys(old ?? {}),
      ...Object.keys(next),
    ])) {
      if (key === "docs" && !(key in next) && old?.docs) out.docs = old.docs;
      else if (key in next)
        out[key] = merge(
          old?.[key],
          next[key],
          [
            "instructions",
            "accounts",
            "types",
            "events",
            "errors",
            "constants",
          ].includes(key),
        );
    }
    return out;
  }
  return next;
}
writeFileSync(
  target,
  JSON.stringify(
    merge(JSON.parse(readFileSync(target)), JSON.parse(readFileSync(source))),
    null,
    2,
  ) + "\n",
);
