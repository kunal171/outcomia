"use client";
import Link from "next/link";
import { useState } from "react";
import { BrandMark } from "../workspace-brand";
import { useI18n } from "../preferences-provider";

/** Password form for the temporary app gate. Posts to /api/unlock, which
 * sets an httpOnly cookie; the password never touches client storage. */
export function UnlockForm({ next, error }: { next: string; error?: string }) {
  const { t } = useI18n(),
    [busy, setBusy] = useState(false);
  return (
    <main className="gate ui-standalone">
      <div className="lp-aurora" aria-hidden="true">
        <span />
        <span />
      </div>
      <form
        className="gate-card ui-card"
        method="post"
        action="/api/unlock"
        onSubmit={() => setBusy(true)}
      >
        <Link className="lp-brand" href="/" aria-label={t("Outcomia home")}>
          <BrandMark />
          <span>Outcomia</span>
        </Link>
        <h1 className="ui-h2">{t("Early access")}</h1>
        <p className="ui-row-meta">
          {t("Enter the access password to open the app.")}
        </p>
        <input type="hidden" name="next" value={next} />
        <label className="ui-field">
          <span>{t("Password")}</span>
          <input
            className="ui-input"
            type="password"
            name="password"
            autoComplete="current-password"
            required
            autoFocus
            maxLength={256}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "gate-error" : undefined}
          />
        </label>
        {error ? (
          <p id="gate-error" className="ui-notice" role="alert">
            {error === "unset"
              ? t("Access is not configured yet.")
              : t("That password is not correct.")}
          </p>
        ) : null}
        <button
          className="ui-btn ui-btn-primary ui-btn-block"
          type="submit"
          disabled={busy}
        >
          {busy ? t("Checking…") : t("Unlock")}
        </button>
        <Link className="gate-back" href="/">
          ← {t("Back to home")}
        </Link>
      </form>
    </main>
  );
}
