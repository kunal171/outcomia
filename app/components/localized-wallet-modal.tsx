"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletModalContext } from "@solana/wallet-adapter-react-ui";
import { useI18n } from "./preferences-provider";

/** Uses the adapter's public selection context. The adapter still owns connection,
 * signing and disconnection; this component only localizes the wallet picker.
 */
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
      <WalletPicker visible={visible} onClose={() => setVisible(false)} />
    </WalletModalContext.Provider>
  );
}
function WalletPicker({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const { wallets, select } = useWallet();
  // Injected wallets exist only in the browser. Keep the first client render
  // identical to SSR, then discover them after hydration (even while closed).
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const available = mounted
    ? wallets.filter(
        (wallet) =>
          wallet.readyState === "Installed" || wallet.readyState === "Loadable",
      )
    : [];
  useEffect(() => {
    if (visible) dialog.current?.showModal();
    else dialog.current?.close();
  }, [visible]);
  return (
    <dialog
      ref={dialog}
      className="preferences-dialog wallet-picker"
      aria-labelledby="wallet-picker-title"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          const rect = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < rect.left ||
            event.clientX > rect.right ||
            event.clientY < rect.top ||
            event.clientY > rect.bottom
          )
            onClose();
        }
      }}
    >
      <div className="preferences-heading">
        <h2 id="wallet-picker-title">{t("Connect wallet")}</h2>
        <button
          type="button"
          aria-label={t("Close wallet selector")}
          onClick={onClose}
        >
          ×
        </button>
      </div>
      {available.length ? (
        <ul>
          {available.map(({ adapter }) => (
            <li key={adapter.name}>
              <button
                type="button"
                onClick={() => {
                  select(adapter.name);
                  onClose();
                }}
              >
                <img src={adapter.icon} width="28" height="28" alt="" />
                <span>{adapter.name}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p>{t("Install a compatible Solana wallet to continue.")}</p>
      )}
    </dialog>
  );
}
