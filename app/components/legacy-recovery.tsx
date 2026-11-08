"use client";
import { useI18n } from "./preferences-provider";

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
  const { t } = useI18n();

  const [open, setOpen] = useState(false);
  if (!SHARED_BALANCES_ENABLED) return <>{children}</>;
  return (
    <details
      className="admin-card legacy-recovery"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{title}</summary>
      <p>{t("Recover older deposits and orders here.")}</p>
      {open && children}
    </details>
  );
}
