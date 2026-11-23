"use client";
import type { CSSProperties } from "react";
import { NetworkHeader } from "./network-workspace";
import { useNetworkWallet } from "./network-wallet-provider";
import { useI18n } from "./preferences-provider";

/** App entry at /app: connect a wallet, which selects the network workspace.
 * Marketing content lives on the public landing page. */
export function Dashboard() {
  const { t } = useI18n(),
    { error, busy, openPicker } = useNetworkWallet();
  const networks = [
    {
      name: "Solana",
      tag: t("Predictions & spot"),
      body: t(
        "Fast public order books for YES/NO, multi-outcome and spot markets.",
      ),
      wallets: t("Any Solana wallet"),
      tone: "solana" as const,
    },
    {
      name: "Canton",
      tag: t("Predictions"),
      body: t("Private, institutional prediction markets and clubs."),
      wallets: "Console · Loop Wallet",
      tone: "canton" as const,
    },
  ];
  return (
    <div className="entry ui-standalone">
      <div className="lp-aurora" aria-hidden="true">
        <span />
        <span />
      </div>
      <div className="entry-shell">
        <NetworkHeader />
        <main className="entry-main" aria-labelledby="entry-title">
          <p className="ui-eyebrow lp-in">{t("Open Outcomia")}</p>
          <h1
            id="entry-title"
            className="entry-title lp-in"
            style={{ "--d": 1 } as CSSProperties}
          >
            {t("Choose a network")}
          </h1>
          <p className="ui-lead lp-in" style={{ "--d": 2 } as CSSProperties}>
            {t("Connect a wallet. Its network opens your workspace.")}
          </p>
          {error ? (
            <p role="alert" className="ui-notice entry-error">
              {error}
            </p>
          ) : null}
          <div className="entry-networks">
            {networks.map((n, i) => (
              <button
                key={n.name}
                type="button"
                className={`entry-network entry-${n.tone} lp-in`}
                style={{ "--d": 3 + i } as CSSProperties}
                disabled={busy}
                onClick={() => openPicker(n.tone)}
              >
                <span className="entry-network-head">
                  <span className="entry-network-name">{n.name}</span>
                  <span className="ui-badge">{n.tag}</span>
                </span>
                <span className="entry-network-body">{n.body}</span>
                <span className="entry-network-foot">
                  <span>{n.wallets}</span>
                  <span className="entry-network-go" aria-hidden="true">
                    →
                  </span>
                </span>
              </button>
            ))}
          </div>
        </main>
      </div>
    </div>
  );
}
