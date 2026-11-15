import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { webcrypto } from "node:crypto";
import ts from "typescript";
const require = createRequire(import.meta.url),
  cache = new Map();
export function loadTypeScript(url) {
  const path = url instanceof URL ? fileURLToPath(url) : url;
  if (cache.has(path)) return cache.get(path).exports;
  const mod = { exports: {} };
  cache.set(path, mod);
  const code = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  runInNewContext(code, {
    module: mod,
    exports: mod.exports,
    Buffer,
    TextEncoder,
    TextDecoder,
    crypto: webcrypto,
    URL,
    process: {
      env: {
        NEXT_PUBLIC_OUTCOMIA_PROGRAM_ID:
          "AG4ztZvcZjzFKjoXLzH8M6U3if9CwVFTXH2FHjqg7SdL",
      },
    },
    require: (name) => {
      if (!name.startsWith(".")) return require(name);
      const target = resolve(dirname(path), name);
      if (target.endsWith(".json"))
        return JSON.parse(readFileSync(target, "utf8"));
      return loadTypeScript(existsSync(target) ? target : `${target}.ts`);
    },
  });
  return mod.exports;
}
