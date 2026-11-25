"use client";
import { APP_HOME } from "../lib/routes";

import { useEffect, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { OutcomiaBrand } from "./workspace-brand";
import { DisplayPreferences } from "./display-preferences";
import { useI18n } from "./preferences-provider";
import { SolanaWorkspaceProvider } from "./solana-provider";
import { WalletSessionProvider } from "./wallet-session-provider";
import { ProtocolRoleProvider } from "./protocol-role-provider";
import {
  SharedWalletButton,
  useNetworkWallet,
} from "./network-wallet-provider";

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
/** Routes rendered without a wallet: the landing page, the password gate and
 * the design reference. */
const PUBLIC_ROUTES = new Set(["/", "/design"]);
export { APP_HOME };

export function NetworkBoundary({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (PUBLIC_ROUTES.has(pathname)) return <>{children}</>;
  return <WalletBoundary>{children}</WalletBoundary>;
}

function WalletBoundary({ children }: { children: ReactNode }) {
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
      : chain === "solana" && !cantonRoute && pathname !== APP_HOME;
  useEffect(() => {
    if (!ready || busy) return;
    if (chain && !allowed) router.replace(destination);
    else if (!chain && pathname !== APP_HOME) router.replace(APP_HOME);
  }, [chain, ready, busy, allowed, destination, pathname, router]);
  if (pathname === APP_HOME && !chain) return <>{children}</>;
  if (!ready || busy || !allowed)
    return (
      <main className="network-wait" role="status">
        {t("Checking wallet…")}
      </main>
    );
  if (chain === "solana")
    return (
      <SolanaWorkspaceProvider>
        <WalletSessionProvider>
          <ProtocolRoleProvider>{children}</ProtocolRoleProvider>
        </WalletSessionProvider>
      </SolanaWorkspaceProvider>
    );
  return <>{children}</>;
}
