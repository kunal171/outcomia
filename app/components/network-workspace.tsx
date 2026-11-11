"use client";

import { useEffect, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { OutcomiaBrand } from "./app-header";
import { DisplayPreferences } from "./display-preferences";
import { useI18n } from "./preferences-provider";
import { SolanaWorkspaceProvider } from "./solana-provider";
import { ProtocolRoleProvider } from "./protocol-role-provider";
import {
  SharedWalletButton,
  useNetworkWallet,
} from "./network-wallet-provider";
import { useCantonWallet } from "./canton-wallet-provider";

export function NetworkHeader() {
  const { chain } = useNetworkWallet();
  return (
    <header className="network-header">
      <OutcomiaBrand />
      <div className="network-header-actions">
        {chain && (
          <span className="network-pill">
            {chain === "canton" ? "Canton" : "Solana"}
          </span>
        )}
        <DisplayPreferences />
        <SharedWalletButton />
      </div>
    </header>
  );
}

/** Children that read Solana accounts never mount for a Canton session.
 * This is UI isolation, not authorization: each backend must enforce ownership.
 * A remembered URL cannot select a network or grant access to a workspace.
 */
export function NetworkBoundary({ children }: { children: ReactNode }) {
  const { chain, ready, busy } = useNetworkWallet();
  const pathname = usePathname();
  const router = useRouter();
  const { t } = useI18n();
  const cantonRoute =
    pathname === "/canton/markets" || pathname.startsWith("/canton/");
  const destination = chain === "canton" ? "/canton/markets" : "/predictions";
  const allowed =
    chain === "canton"
      ? cantonRoute
      : chain === "solana" && !cantonRoute && pathname !== "/";
  useEffect(() => {
    if (!ready || busy) return;
    if (chain && !allowed) router.replace(destination);
    else if (!chain && pathname !== "/") router.replace("/");
  }, [chain, ready, busy, allowed, destination, pathname, router]);
  if (pathname === "/" && !chain) return <>{children}</>;
  if (!ready || busy || !allowed)
    return (
      <main className="network-wait" role="status">
        {t("Checking wallet…")}
      </main>
    );
  if (chain === "solana")
    return (
      <SolanaWorkspaceProvider>
        <ProtocolRoleProvider>{children}</ProtocolRoleProvider>
      </SolanaWorkspaceProvider>
    );
  return <>{children}</>;
}

export function CantonWorkspace() {
  const { state } = useCantonWallet();
  const { t } = useI18n();
  if (!state.session) return null;
  return (
    <div className="network-shell">
      <NetworkHeader />
      <main className="canton-workspace">
        <div className="canton-heading">
          <h1>{t("Predictions")}</h1>
          <span className="network-pill">{state.session.networkId}</span>
        </div>
        <section className="canton-session" aria-label={t("Connected wallet")}>
          <span>Console Wallet</span>
          <code>{state.session.partyId}</code>
        </section>
        <section className="canton-empty">
          <span className="canton-empty-symbol" aria-hidden="true">
            ◇
          </span>
          <h2>{t("Market deployment pending")}</h2>
          <p>
            {t(
              "Canton prediction markets will appear here after contract deployment.",
            )}
          </p>
        </section>
      </main>
    </div>
  );
}
