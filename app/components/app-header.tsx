"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { NETWORK } from "../lib/solana";
import { useProtocolRole } from "./protocol-role-provider";

const roleLabels = {
  disconnected: null,
  uninitialized: "Setup required",
  "super-admin": "Super admin",
  admin: "Admin",
  disabled: "Admin disabled",
  user: null,
};

function HydrationSafeWalletButton() {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return (
      <button
        className="wallet-adapter-button wallet-adapter-button-trigger"
        type="button"
        disabled
        aria-label="Loading wallet"
      >
        Select Wallet
      </button>
    );
  }

  return <WalletMultiButton />;
}

type NavigationItem = {
  href: string;
  label: string;
  icon: "prediction" | "spot" | "wallet" | "orders" | "admins" | "create";
  active: boolean;
};

function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

function TidebookBrand() {
  return (
    <Link className="brand" href="/" aria-label="Tidebook home">
      <BrandMark />
      <span>Tidebook</span>
    </Link>
  );
}

function NavigationIcon({ name }: { name: NavigationItem["icon"] }) {
  const paths = {
    prediction: "M12 3 21 12 12 21 3 12 12 3Z M8 12h8 M12 8v8",
    spot: "M4 8h15l-4-4 M20 16H5l4 4",
    wallet: "M20 8V5H5a2 2 0 0 0 0 4h15v11H5a2 2 0 0 1-2-2V7 M16 12h5v5h-5z",
    orders: "M8 6h12 M8 12h12 M8 18h12 M3 6h1 M3 12h1 M3 18h1",
    admins:
      "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M17 4a4 4 0 0 1 0 8 M22 21v-2a4 4 0 0 0-3-3.87",
    create: "M12 5v14 M5 12h14",
  };
  return (
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
      <path d={paths[name]} />
    </svg>
  );
}

/** Shared navigation keeps desktop and modal mobile links under the same role checks. */
export function AppHeader() {
  const pathname = usePathname();
  const { role, loading } = useProtocolRole();
  const roleLabel = loading ? "Checking role" : roleLabels[role];
  const isSuperAdmin = !loading && role === "super-admin";
  const canCreateMarket =
    !loading && (role === "super-admin" || role === "admin");
  const canViewOrders = !loading && role !== "disconnected";
  const drawer = useRef<HTMLDialogElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    let saved = document.documentElement.dataset.sidebarCollapsed === "true";
    try {
      const stored = localStorage.getItem("tidebook:sidebar-collapsed");
      if (stored !== null) saved = stored === "true";
    } catch {
      /* Navigation still works when browser storage is unavailable. */
    }
    document.documentElement.dataset.sidebarCollapsed = String(saved);
    setCollapsed(saved);
  }, []);
  function toggleSidebar() {
    const next = !collapsed;
    setCollapsed(next);
    document.documentElement.dataset.sidebarCollapsed = String(next);
    try {
      localStorage.setItem("tidebook:sidebar-collapsed", String(next));
    } catch {
      /* The current page still keeps the selected layout. */
    }
  }

  // A modal opened on a phone must not keep the desktop page inert after resizing.
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 1201px)");
    function onResize() {
      if (desktop.matches) drawer.current?.close();
    }
    desktop.addEventListener("change", onResize);
    return () => desktop.removeEventListener("change", onResize);
  }, []);
  useEffect(() => {
    drawer.current?.close();
  }, [pathname]);

  const items: NavigationItem[] = [
    {
      href: "/predictions",
      label: "Predictions",
      icon: "prediction",
      active:
        pathname.startsWith("/predictions") && pathname !== "/predictions/new",
    },
    {
      href: "/markets",
      label: "Spot markets",
      icon: "spot",
      active:
        pathname === "/markets" ||
        (pathname.startsWith("/markets/") &&
          !pathname.startsWith("/markets/new")),
    },
    {
      href: "/wallet",
      label: "Wallet",
      icon: "wallet",
      active: pathname === "/wallet",
    },
    ...(canViewOrders
      ? [
          {
            href: "/orders",
            label: "Orders",
            icon: "orders" as const,
            active: pathname === "/orders",
          },
        ]
      : []),
    ...(isSuperAdmin
      ? [
          {
            href: "/admin",
            label: "Manage admins",
            icon: "admins" as const,
            active: pathname === "/admin",
          },
        ]
      : []),
    ...(canCreateMarket
      ? [
          {
            href: "/markets/new",
            label: "Create market",
            icon: "create" as const,
            active:
              pathname.startsWith("/markets/new") ||
              pathname === "/predictions/new",
          },
        ]
      : []),
  ];
  function navigation(id?: string) {
    return (
      <nav id={id} className="sidebar-nav" aria-label="Primary navigation">
        {items.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            aria-label={item.label}
            title={item.label}
            aria-current={item.active ? "page" : undefined}
            onClick={() => drawer.current?.close()}
          >
            <NavigationIcon name={item.icon} />
            <span>{item.label}</span>
            <span className="sidebar-link-arrow" aria-hidden="true">
              ↗
            </span>
          </Link>
        ))}
      </nav>
    );
  }
  function footer() {
    return (
      <div className="sidebar-footer">
        <span>
          <span className="network-dot" aria-hidden="true" /> Solana {NETWORK}
        </span>
        <small>Test tokens. Real order books.</small>
      </div>
    );
  }
  return (
    <>
      <aside className="app-sidebar" aria-label="Tidebook sidebar">
        <div className="sidebar-brand-heading">
          <button
            type="button"
            className="sidebar-brand-toggle"
            onClick={toggleSidebar}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!collapsed}
            aria-controls="tidebook-desktop-navigation"
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            <BrandMark />
          </button>
          <Link className="sidebar-brand-name" href="/">
            Tidebook
          </Link>
        </div>
        <span className="sidebar-section-label">Workspace</span>
        {navigation("tidebook-desktop-navigation")}
        {footer()}
      </aside>
      <header className="topbar">
        <div className="mobile-brand-row">
          <button
            type="button"
            className="sidebar-menu-toggle"
            aria-label="Open navigation"
            aria-haspopup="dialog"
            aria-controls="tidebook-navigation-drawer"
            aria-expanded={menuOpen}
            onClick={() => {
              drawer.current?.showModal();
              setMenuOpen(true);
            }}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M4 6h16 M4 12h16 M4 18h16" />
            </svg>
          </button>
          <TidebookBrand />
        </div>
        <div className="topbar-actions">
          {roleLabel && (
            <span className={`role-badge role-${role}`}>{roleLabel}</span>
          )}
          <span className="network-pill">
            <span className="network-dot" />
            {NETWORK}
          </span>
          <HydrationSafeWalletButton />
        </div>
      </header>
      <dialog
        className="sidebar-drawer"
        id="tidebook-navigation-drawer"
        ref={drawer}
        aria-label="Navigation menu"
        onClose={() => setMenuOpen(false)}
        onClick={(event) => {
          if (event.target !== event.currentTarget) return;
          const rect = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < rect.left ||
            event.clientX > rect.right ||
            event.clientY < rect.top ||
            event.clientY > rect.bottom
          )
            event.currentTarget.close();
        }}
      >
        <div className="sidebar-drawer-heading">
          <div className="sidebar-brand-heading">
            <button
              type="button"
              className="sidebar-brand-toggle"
              aria-label="Hide navigation"
              onClick={() => drawer.current?.close()}
            >
              <BrandMark />
            </button>
            <Link
              className="sidebar-brand-name"
              href="/"
              onClick={() => drawer.current?.close()}
            >
              Tidebook
            </Link>
          </div>
          <button
            type="button"
            className="sidebar-close"
            aria-label="Close navigation"
            onClick={() => drawer.current?.close()}
          >
            ×
          </button>
        </div>
        <span className="sidebar-section-label">Workspace</span>
        {navigation()}
        {footer()}
      </dialog>
    </>
  );
}
