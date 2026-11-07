import en from "./messages/en.json";
import hi from "./messages/hi.json";
import es from "./messages/es.json";
import fr from "./messages/fr.json";
import pt from "./messages/pt.json";
import type { Locale } from "./config";

export const catalogs: Record<Locale, Record<string, string>> = {
  en,
  hi,
  es,
  fr,
  pt,
};

/** Unknown provider/chain diagnostics stay verbatim. Never translate user-authored
 * questions, rule documents, symbols, addresses, enum arguments or signed data.
 */
export function message(locale: Locale, source: string): string {
  return catalogs[locale][source] ?? source;
}
export function interpolate(
  template: string,
  values: Record<string, string | number | boolean | null | undefined> = {},
): string {
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (token, key) =>
    values[key] === undefined
      ? token
      : values[key] === null || typeof values[key] === "boolean"
        ? ""
        : String(values[key]),
  );
}
