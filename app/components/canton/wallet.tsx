"use client";

import { useEffect, useState } from "react";
import { useCantonWallet } from "../canton-wallet-provider";
import { useI18n } from "../preferences-provider";
import type { CantonSession } from "../../lib/canton-session";
import {
  formatCantonAmount,
  type CantonWalletAsset,
} from "../../lib/canton-display";
import { readCantonWalletAssets } from "../../lib/canton-wallet";
import { walletError } from "../../lib/console-wallet";
import { CantonPageHeading, CantonDeploymentNotice } from "./workspace";

type BalanceState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; assets: CantonWalletAsset[] };

export function CantonWallet() {
  const { state } = useCantonWallet();
  if (!state.session) return null;
  return (
    <CantonWalletView
      key={`${state.session.networkId}:${state.session.partyId}`}
      session={state.session}
    />
  );
}

/** No persisted balances or automatic polling. Identity changes unmount this
 * reader; cleanup discards late wallet responses and each refresh clears old data.
 */
function CantonWalletView({ session }: { session: CantonSession }) {
  const { t, locale } = useI18n();
  const [state, setState] = useState<BalanceState>({ kind: "loading" });
  const [revision, setRevision] = useState(0);
  const [hideEmpty, setHideEmpty] = useState(true);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  useEffect(() => {
    let active = true;
    setState({ kind: "loading" });
    void readCantonWalletAssets(session).then(
      (assets) => {
        if (active) setState({ kind: "ready", assets });
      },
      (cause: unknown) => {
        if (active) setState({ kind: "error", message: walletError(cause) });
      },
    );
    return () => {
      active = false;
    };
  }, [session.partyId, session.networkId, revision]);
  const assets =
    state.kind === "ready"
      ? state.assets.filter((asset) => !hideEmpty || asset.amount !== "0")
      : [];
  async function copyParty() {
    try {
      await navigator.clipboard.writeText(session.partyId);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }
  return (
    <>
      <CantonPageHeading title="Wallet">
        <button
          className="canton-secondary-button"
          type="button"
          disabled={state.kind === "loading"}
          onClick={() => setRevision((value) => value + 1)}
        >
          {t(state.kind === "loading" ? "Loading…" : "Refresh")}
        </button>
      </CantonPageHeading>
      <section
        className="canton-wallet-identity"
        aria-label={t("Connected wallet")}
      >
        <div>
          <span>Console Wallet</span>
          <code>{session.partyId}</code>
        </div>
        <button
          type="button"
          className="canton-secondary-button"
          onClick={() => void copyParty()}
        >
          {t(copyState === "copied" ? "Copied" : "Copy party ID")}
        </button>
        {copyState === "failed" && (
          <p role="status">{t("Could not copy. Select the party ID above.")}</p>
        )}
      </section>
      <section
        className="canton-wallet-assets"
        aria-labelledby="canton-assets-heading"
        aria-busy={state.kind === "loading"}
      >
        <div className="canton-section-heading">
          <h2 id="canton-assets-heading">{t("Wallet assets")}</h2>
          <label className="canton-hide-empty">
            <input
              type="checkbox"
              checked={hideEmpty}
              onChange={(event) => setHideEmpty(event.target.checked)}
            />
            {t("Hide empty assets")}
          </label>
        </div>
        {state.kind === "loading" ? (
          <p className="canton-wallet-status" role="status">
            {t("Reading balances from Console Wallet…")}
          </p>
        ) : state.kind === "error" ? (
          <div className="canton-wallet-error" role="alert">
            <strong>{t("Balances unavailable")}</strong>
            <p>{t(state.message)}</p>
          </div>
        ) : assets.length === 0 ? (
          <p className="canton-wallet-status">
            {t(
              hideEmpty && state.assets.length > 0
                ? "No non-zero assets. Turn off the filter to see all assets."
                : "Console Wallet returned no assets for this network.",
            )}
          </p>
        ) : (
          <div className="canton-table-scroll">
            <table className="canton-asset-table">
              <thead>
                <tr>
                  <th scope="col">{t("Asset")}</th>
                  <th scope="col">{t("In wallet")}</th>
                </tr>
              </thead>
              <tbody>
                {assets.map((asset) => (
                  <tr key={asset.id}>
                    <td>
                      <div className="canton-asset-name">
                        <span className="canton-token-mark" aria-hidden="true">
                          {asset.symbol.slice(0, 2)}
                        </span>
                        <div>
                          <strong>{asset.symbol}</strong>
                          <span>{asset.name}</span>
                          <details>
                            <summary>{t("Token ID")}</summary>
                            <code>{asset.id}</code>
                          </details>
                        </div>
                      </div>
                    </td>
                    <td data-label={t("In wallet")}>
                      {formatCantonAmount(asset.amount, locale)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section
        className="canton-funding-unavailable"
        aria-labelledby="canton-funding-heading"
      >
        <h2 id="canton-funding-heading">{t("Outcomia balance")}</h2>
        <CantonDeploymentNotice />
      </section>
    </>
  );
}
