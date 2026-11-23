"use client";
import { useRef, useState } from "react";
import { useI18n } from "./preferences-provider";
import { rulesDocumentUrl } from "../lib/prediction-display";

type RulesDoc = {
  question?: string;
  description?: string;
  resolutionSource?: string;
  resolutionRules?: {
    yesCriteria?: string;
    noCriteria?: string;
    outcomes?: { label?: string; criteria?: string }[];
    invalidCriteria?: string;
    invalidRefund?: string;
    evidenceRequirements?: string;
    conflictingEvidencePolicy?: string;
  };
  closeTimestamp?: number;
  earliestResolutionTimestamp?: number | null;
  primaryResolver?: string;
  resolutionDelaySeconds?: number;
};

type Loaded =
  | { state: "idle" | "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; doc: RulesDoc; verified: boolean };

const hex = (bytes: ArrayLike<number>) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** Reads a market's published rules in place. The document is fetched on
 * open and compared with the on-chain SHA-256, so readers see whether what
 * they read is exactly what the market committed to. */
export function RulesDocumentDialog({
  uri,
  rulesHash,
  label = "Read rules",
}: {
  uri: string;
  rulesHash: ArrayLike<number>;
  label?: string;
}) {
  const { t, locale } = useI18n(),
    dialog = useRef<HTMLDialogElement>(null),
    [loaded, setLoaded] = useState<Loaded>({ state: "idle" }),
    url = rulesDocumentUrl(uri);
  if (!url) return null;

  const open = async () => {
    dialog.current?.showModal();
    if (loaded.state === "ready" || loaded.state === "loading") return;
    setLoaded({ state: "loading" });
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > 128 * 1024)
        throw new Error(t("The rules document is too large to display."));
      const digest = new Uint8Array(
        await crypto.subtle.digest("SHA-256", bytes),
      );
      const doc = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      ) as RulesDoc;
      setLoaded({
        state: "ready",
        doc,
        verified: hex(digest) === hex(rulesHash),
      });
    } catch (cause) {
      setLoaded({
        state: "error",
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  };
  const time = (seconds?: number | null) =>
    typeof seconds === "number"
      ? `${new Date(seconds * 1000).toLocaleString(locale, {
          timeZone: "UTC",
          dateStyle: "medium",
          timeStyle: "short",
        })} UTC`
      : null;

  const doc = loaded.state === "ready" ? loaded.doc : null,
    rules = doc?.resolutionRules;
  const sections: [string, string | null | undefined][] = doc
    ? [
        [t("Resolution source"), doc.resolutionSource],
        ...(rules?.outcomes
          ? []
          : ([
              [t("YES if"), rules?.yesCriteria],
              [t("NO if"), rules?.noCriteria],
            ] as [string, string | undefined][])),
        [t("Invalid if"), rules?.invalidCriteria],
        [t("Invalid refunds"), rules?.invalidRefund],
        [t("Evidence required"), rules?.evidenceRequirements],
        [t("Conflicting evidence"), rules?.conflictingEvidencePolicy],
        [t("Trading closes"), time(doc.closeTimestamp)],
        [t("Earliest resolution"), time(doc.earliestResolutionTimestamp)],
        [
          t("Review period"),
          typeof doc.resolutionDelaySeconds === "number"
            ? t("{minutes} minutes", {
                minutes: Math.round(doc.resolutionDelaySeconds / 60),
              })
            : null,
        ],
        [t("Resolver"), doc.primaryResolver],
      ]
    : [];

  return (
    <>
      <button
        type="button"
        className="text-button rules-dialog-trigger"
        onClick={() => void open()}
      >
        {t(label)}
      </button>
      <dialog
        ref={dialog}
        className="rules-dialog"
        aria-labelledby="rules-dialog-title"
        onClick={(e) => {
          if (e.target === dialog.current) dialog.current?.close();
        }}
      >
        <div className="rules-dialog-head">
          <div>
            <p className="ui-eyebrow">{t("Market rules")}</p>
            <h2 id="rules-dialog-title">
              {doc?.question ?? t("Published rules")}
            </h2>
          </div>
          <button
            type="button"
            className="rules-dialog-close"
            aria-label={t("Close")}
            onClick={() => dialog.current?.close()}
          >
            ×
          </button>
        </div>
        <div className="rules-dialog-body">
          {loaded.state === "loading" && (
            <p role="status">{t("Loading rules…")}</p>
          )}
          {loaded.state === "error" && (
            <p className="ui-notice" role="alert">
              {t("The rules document could not be loaded.")} ({loaded.message})
            </p>
          )}
          {loaded.state === "ready" && (
            <>
              <p
                className={`ui-badge ${loaded.verified ? "ui-badge-yes" : "ui-badge-no"}`}
              >
                {loaded.verified
                  ? t("Matches the on-chain rules hash")
                  : t("Does not match the on-chain rules hash")}
              </p>
              {doc?.description && (
                <p className="rules-dialog-lead">{doc.description}</p>
              )}
              {rules?.outcomes && (
                <ol className="rules-dialog-outcomes">
                  {rules.outcomes.map((o, i) => (
                    <li key={i}>
                      <strong>{o.label}</strong>
                      <span>{o.criteria}</span>
                    </li>
                  ))}
                </ol>
              )}
              <dl className="ui-dl">
                {sections
                  .filter(([, value]) => value)
                  .map(([key, value]) => (
                    <div key={key} className="rules-dialog-row">
                      <dt>{key}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
              </dl>
            </>
          )}
        </div>
        <div className="rules-dialog-foot">
          <a href={url} target="_blank" rel="noreferrer">
            {t("Open original document ↗")}
          </a>
        </div>
      </dialog>
    </>
  );
}
