const collections = [
  "instructions",
  "accounts",
  "types",
  "events",
  "errors",
  "constants",
];
export function abi(value) {
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
function preserveDocs(old, next) {
  if (old && JSON.stringify(abi(old)) === JSON.stringify(abi(next))) return old;
  if (Array.isArray(next))
    return next.map((v, i) =>
      preserveDocs(
        v?.name ? old?.find?.((o) => o.name === v.name) : old?.[i],
        v,
      ),
    );
  if (next && typeof next === "object") {
    const result = Object.fromEntries(
      Object.entries(next).map(([k, v]) => [k, preserveDocs(old?.[k], v)]),
    );
    if (!("docs" in next) && old?.docs) result.docs = old.docs;
    return result;
  }
  return next;
}
/** Only top-level catalogs are unordered. Instruction accounts, struct fields,
 * enum variants, seeds and arguments must retain the generated wire order. */
export function mergeIdl(old, next) {
  const result = preserveDocs(old, next);
  for (const key of collections) {
    if (!Array.isArray(next[key])) continue;
    const before = old[key] ?? [],
      after = new Map(next[key].map((v) => [v.name, v]));
    result[key] = [
      ...before
        .filter((v) => after.has(v.name))
        .map((v) => preserveDocs(v, after.get(v.name))),
      ...next[key].filter((v) => !before.some((o) => o.name === v.name)),
    ];
  }
  return result;
}

export function canonicalIdl(value) {
  const normalized = abi(value);
  for (const key of collections)
    if (Array.isArray(normalized[key]))
      normalized[key].sort((a, b) => a.name.localeCompare(b.name));
  return normalized;
}
