"use client";
import { useState, type ReactNode } from "react";
import { SHARED_BALANCES_ENABLED } from "../lib/shared";
/** Mount legacy readers only when requested, keeping their liquidity and RPC traffic separate. */
export function LegacyRecovery({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  if (!SHARED_BALANCES_ENABLED) return <>{children}</>;
  return (
    <details
      className="admin-card legacy-recovery"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{title}</summary>
      <p>
        Older deposits and orders use separate custody. Open this section to
        cancel or recover them. Move free cash from the Wallet page.
      </p>
      {open && children}
    </details>
  );
}
