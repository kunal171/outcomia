"use client";
import { useEffect, useState } from "react";
import { transactionExplorerUrl } from "../lib/outcomia";
import { useI18n } from "./preferences-provider";

/**
 * A short-lived "Transaction confirmed" toast with an explorer link, shown
 * once per new signature and dismissed after a few seconds (or by hand),
 * instead of a permanent confirmation line on the page.
 */
export function TransactionToast({ signature }: { signature: string | null }) {
  const { t } = useI18n();
  const [shown, setShown] = useState<string | null>(null);
  useEffect(() => {
    // A new submission clears the signature: hide the previous toast at once
    // so it is never mistaken for the confirmation of the next transaction.
    if (!signature) {
      setShown(null);
      return;
    }
    setShown(signature);
    const timer = setTimeout(
      () => setShown((current) => (current === signature ? null : current)),
      7000,
    );
    return () => clearTimeout(timer);
  }, [signature]);
  if (!shown) return null;
  return (
    <div className="tx-toast" role="status" aria-live="polite">
      <span className="tx-toast-icon" aria-hidden="true">
        ✓
      </span>
      <div>
        <strong>{t("Transaction confirmed")}</strong>
        <a
          href={transactionExplorerUrl(shown)}
          target="_blank"
          rel="noreferrer"
        >
          {t("View transaction ↗")}
        </a>
      </div>
      <button
        type="button"
        className="tx-toast-close"
        aria-label={t("Dismiss")}
        onClick={() => setShown(null)}
      >
        ×
      </button>
    </div>
  );
}
