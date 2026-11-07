"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { localeNames, locales, type Locale, type Theme } from "../i18n/config";
import { useI18n } from "./preferences-provider";

/** One native dialog serves desktop and mobile, including keyboard focus/escape. */
export function DisplayPreferences() {
  const { locale, theme, setLocale, setTheme, t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const path = usePathname();
  useEffect(() => {
    dialog.current?.close();
  }, [path]);
  return (
    <>
      <button
        type="button"
        className="preferences-trigger"
        aria-label={t("Display settings")}
        title={t("Display settings")}
        aria-haspopup="dialog"
        onClick={() => dialog.current?.showModal()}
      >
        <svg
          viewBox="0 0 24 24"
          width="20"
          height="20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="8" />
          <path d="M12 4v16" />
          <path d="M12 4a8 8 0 0 1 0 16Z" fill="currentColor" stroke="none" />
        </svg>
      </button>
      <dialog
        ref={dialog}
        className="preferences-dialog"
        aria-labelledby="preferences-title"
        onClick={(event) => {
          if (event.target === event.currentTarget) {
            const rect = event.currentTarget.getBoundingClientRect();
            if (
              event.clientX < rect.left ||
              event.clientX > rect.right ||
              event.clientY < rect.top ||
              event.clientY > rect.bottom
            )
              event.currentTarget.close();
          }
        }}
      >
        <div className="preferences-heading">
          <h2 id="preferences-title">{t("Display settings")}</h2>
          <button
            type="button"
            aria-label={t("Close settings")}
            onClick={() => dialog.current?.close()}
          >
            ×
          </button>
        </div>
        <label>
          {t("Appearance")}
          <select
            value={theme}
            onChange={(event) => setTheme(event.target.value as Theme)}
          >
            {(["system", "light", "dark"] as const).map((value) => (
              <option key={value} value={value}>
                {t({ system: "System", light: "Light", dark: "Dark" }[value])}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("Language")}
          <select
            value={locale}
            onChange={(event) => setLocale(event.target.value as Locale)}
          >
            {locales.map((value) => (
              <option key={value} value={value} lang={value}>
                {localeNames[value]}
              </option>
            ))}
          </select>
        </label>
      </dialog>
    </>
  );
}
