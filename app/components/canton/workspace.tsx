"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { useCantonWallet } from "../canton-wallet-provider";
import { SharedWalletButton } from "../network-wallet-provider";
import { DisplayPreferences } from "../display-preferences";
import { useI18n } from "../preferences-provider";
import { BrandMark, OutcomiaBrand } from "../workspace-brand";

const destinations = [
  {
    href: "/canton/markets",
    label: "Predictions",
    icon: "M12 3 21 12 12 21 3 12Z M8 12h8 M12 8v8",
  },
  {
    href: "/canton/positions",
    label: "Positions",
    icon: "m3 8 9-5 9 5-9 5-9-5Z M3 12l9 5 9-5 M3 16l9 5 9-5",
  },
  {
    href: "/canton/orders",
    label: "Orders",
    icon: "M8 6h12 M8 12h12 M8 18h12 M3 6h1 M3 12h1 M3 18h1",
  },
  {
    href: "/canton/wallet",
    label: "Wallet",
    icon: "M20 8V5H5a2 2 0 0 0 0 4h15v11H5a2 2 0 0 1-2-2V7 M16 12h5v5h-5Z",
  },
] as const;

/** One persistent Canton layout; it never mounts Solana role/account providers.
 * Key financial children to the verified identity so changing parties resets forms.
 */
export function CantonWorkspace({ children }: { children: ReactNode }) {
  const { state } = useCantonWallet();
  const pathname = usePathname();
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(false);
  if (!state.session) return null;
  const session = state.session;
  const identity = `${session.networkId}:${session.partyId}`;
  const navigation = (
    <nav className="canton-nav" aria-label={t("Primary navigation")}>
      {destinations.map(({ href, label, icon }) => (
        <Link
          key={href}
          href={href}
          title={t(label)}
          aria-label={t(label)}
          aria-current={pathname === href ? "page" : undefined}
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d={icon} />
          </svg>
          <span>{t(label)}</span>
        </Link>
      ))}
    </nav>
  );
  return (
    <div className="canton-shell" data-collapsed={collapsed}>
      <aside className="canton-sidebar" aria-label={t("Outcomia sidebar")}>
        <div className="canton-brand-row">
          <button
            type="button"
            className="canton-brand-toggle"
            aria-label={t(collapsed ? "Expand sidebar" : "Collapse sidebar")}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((value) => !value)}
          >
            <BrandMark />
          </button>
          <Link href="/" className="canton-brand-name">
            Outcomia
          </Link>
        </div>
        {navigation}
        <div className="canton-sidebar-footer">
          <span className="network-dot" aria-hidden="true" /> Canton
        </div>
      </aside>
      <div className="canton-content">
        <header className="canton-topbar">
          <div className="canton-mobile-brand">
            <OutcomiaBrand />
          </div>
          <div className="canton-header-context">
            <span className="network-pill">
              Canton · {session.networkId.split(":")[1]}
            </span>
            <Link
              className="canton-party-link"
              href="/canton/wallet"
              title={session.partyId}
              aria-label={`${t("Connected wallet")}: ${session.partyId}`}
            >
              {session.partyId.length > 24
                ? `${session.partyId.slice(0, 10)}…${session.partyId.slice(-6)}`
                : session.partyId}
            </Link>
          </div>
          <div className="network-header-actions">
            <DisplayPreferences />
            <SharedWalletButton />
          </div>
        </header>
        <div className="canton-mobile-nav">{navigation}</div>
        <main className="canton-main" key={identity}>
          {children}
        </main>
      </div>
    </div>
  );
}

export function CantonPageHeading({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div className="canton-page-heading">
      <h1>{t(title)}</h1>
      {children}
    </div>
  );
}

/** Unavailable ledger reads must not be presented as zero balances/empty accounts. */
export function CantonDeploymentNotice() {
  const { t } = useI18n();
  return (
    <div className="canton-deployment-note">
      <span aria-hidden="true">◷</span>
      <div>
        <strong>{t("Market deployment pending")}</strong>
        <p>{t("Canton funding and trading are not available yet.")}</p>
      </div>
    </div>
  );
}

export function CantonUnavailable({
  title,
  description,
  icon,
}: {
  title: string;
  description: string;
  icon: "market" | "position" | "order";
}) {
  const { t } = useI18n();
  const paths = {
    market: "M4 17 9 12l4 3 7-9 M15 6h5v5",
    position: "m3 8 9-5 9 5-9 5-9-5Z M3 12l9 5 9-5 M3 16l9 5 9-5",
    order: "M8 6h12 M8 12h12 M8 18h12 M3 6h1 M3 12h1 M3 18h1",
  };
  return (
    <section className="canton-unavailable">
      <div className="canton-state-icon" aria-hidden="true">
        <svg
          width="30"
          height="30"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d={paths[icon]} />
        </svg>
      </div>
      <h2>{t(title)}</h2>
      <p>{t(description)}</p>
    </section>
  );
}
