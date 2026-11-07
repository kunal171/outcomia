export const locales = ["en", "hi", "es", "fr", "pt"] as const;
export type Locale = (typeof locales)[number];
export type Theme = "system" | "light" | "dark";
export const localeNames: Record<Locale, string> = {
  en: "English",
  hi: "हिन्दी",
  es: "Español",
  fr: "Français",
  pt: "Português",
};
export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && locales.includes(value as Locale);
}
export function isTheme(value: unknown): value is Theme {
  return value === "system" || value === "light" || value === "dark";
}
