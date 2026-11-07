"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { message, interpolate } from "../i18n/catalog";
import { isLocale, isTheme, type Locale, type Theme } from "../i18n/config";

interface Preferences {
  locale: Locale;
  theme: Theme;
  setLocale: (locale: Locale) => void;
  setTheme: (theme: Theme) => void;
  t: (
    source: string,
    values?: Record<string, string | number | boolean | null | undefined>,
  ) => string;
}
const Context = createContext<Preferences | null>(null);

/** Server cookies seed the first render, so translated text hydrates identically.
 * CSS resolves System mode before paint; preference changes never remount wallets.
 */
export function PreferencesProvider({
  initialLocale,
  initialTheme,
  children,
}: {
  initialLocale: Locale;
  initialTheme: Theme;
  children: ReactNode;
}) {
  const [locale, updateLocale] = useState(initialLocale),
    [theme, updateTheme] = useState(initialTheme);
  const setLocale = useCallback((next: Locale) => {
    if (isLocale(next)) updateLocale(next);
  }, []);
  const setTheme = useCallback((next: Theme) => {
    if (isTheme(next)) updateTheme(next);
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale;
    document.cookie = `tidebook_locale=${locale}; Path=/; Max-Age=31536000; SameSite=Lax`;
  }, [locale]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.cookie = `tidebook_theme=${theme}; Path=/; Max-Age=31536000; SameSite=Lax`;
  }, [theme]);
  const t = useCallback(
    (
      source: string,
      values?: Record<string, string | number | boolean | null | undefined>,
    ) => interpolate(message(locale, source), values),
    [locale],
  );
  const value = useMemo(
    () => ({ locale, theme, setLocale, setTheme, t }),
    [locale, theme, setLocale, setTheme, t],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useI18n(): Preferences {
  const context = useContext(Context);
  if (!context) throw new Error("PreferencesProvider is missing");
  return context;
}
