"use client";
import { useMemo, useState, type ReactNode } from "react";
import { WalletModalContext } from "@solana/wallet-adapter-react-ui";

/** Keep adapter buttons compatible with the single, multi-network wallet picker. */
export function LocalizedWalletModalProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [visible, setVisible] = useState(false);
  const value = useMemo(() => ({ visible, setVisible }), [visible]);
  return (
    <WalletModalContext.Provider value={value}>
      {children}
    </WalletModalContext.Provider>
  );
}
