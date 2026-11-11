"use client";

import { useRef, useState } from "react";
import { useI18n } from "../preferences-provider";
import {
  formatCantonAmount,
  previewCantonOrder,
} from "../../lib/canton-display";

/** An explicitly local calculator, separate from future wallet submission.
 * Native dialog provides focus trapping, Escape and return-to-trigger behavior.
 */
export function CantonGuide() {
  const { t, locale } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [outcome, setOutcome] = useState<"YES" | "NO">("YES");
  const [price, setPrice] = useState("");
  const [quantity, setQuantity] = useState("");
  const total = previewCantonOrder(price, quantity);
  const invalid = price !== "" && quantity !== "" && total === null;
  return (
    <>
      <button
        type="button"
        className="canton-help-trigger"
        onClick={() => dialog.current?.showModal()}
      >
        <span aria-hidden="true">?</span>
        {t("How it works")}
      </button>
      <dialog
        className="preferences-dialog canton-guide"
        ref={dialog}
        aria-labelledby="canton-guide-title"
      >
        <div className="preferences-heading">
          <h2 id="canton-guide-title">{t("Order preview")}</h2>
          <button
            type="button"
            aria-label={t("Close")}
            onClick={() => dialog.current?.close()}
          >
            ×
          </button>
        </div>
        <p className="canton-preview-notice">
          {t("Local calculation only. No transaction is sent.")}
        </p>
        <div className="canton-guide-fields">
          <label>
            {t("Side")}
            <select
              aria-label={t("Side")}
              value={side}
              onChange={(event) =>
                setSide(event.target.value as "buy" | "sell")
              }
            >
              <option value="buy">{t("Buy")}</option>
              <option value="sell">{t("Sell")}</option>
            </select>
          </label>
          <label>
            {t("Outcome")}
            <select
              aria-label={t("Outcome")}
              value={outcome}
              onChange={(event) =>
                setOutcome(event.target.value as "YES" | "NO")
              }
            >
              <option value="YES">YES</option>
              <option value="NO">NO</option>
            </select>
          </label>
          <label>
            {t("Price per contract")}
            <input
              inputMode="decimal"
              value={price}
              placeholder="0.40"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setPrice(event.target.value)}
            />
          </label>
          <label>
            {t("Contracts")}
            <input
              inputMode="numeric"
              value={quantity}
              placeholder="3"
              autoComplete="off"
              onChange={(event) => setQuantity(event.target.value)}
            />
          </label>
        </div>
        <div
          className="canton-preview-result"
          aria-live="polite"
          aria-atomic="true"
        >
          <span>
            {t(side === "buy" ? "Collateral reserved" : "Contracts reserved")}
          </span>
          <strong>
            {total === null
              ? "—"
              : side === "buy"
                ? t("{amount} collateral", {
                    amount: formatCantonAmount(total, locale),
                  })
                : `${formatCantonAmount(quantity, locale)} ${outcome}`}
          </strong>
        </div>
        {invalid && (
          <p className="canton-inline-error" role="alert">
            {t(
              "Enter a price between 0 and 1 and a positive whole quantity. Use a decimal point, with up to 10 decimal places.",
            )}
          </p>
        )}
        <details className="canton-rules-summary">
          <summary>{t("Complete sets & cancellation")}</summary>
          <p>
            {t(
              "1 collateral creates 1 YES + 1 NO. Merge both to recover 1 collateral.",
            )}
          </p>
          <p>
            {t(
              "Cancellation releases reserved funds or contracts, even after trading closes.",
            )}
          </p>
          <p>
            {t(
              "This preview excludes fees, market increments and available balances. Matching and redemption are not available yet.",
            )}
          </p>
        </details>
      </dialog>
    </>
  );
}
