"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useCantonWallet } from "./canton-wallet-provider";
import { useI18n } from "./preferences-provider";
import { walletError } from "../lib/console-wallet";

type Chain = "solana" | "canton";
type Selection = {
  chain: Chain | null;
  ready: boolean;
  busy: boolean;
  error: string | null;
  disconnect: () => Promise<void>;
};
const Context = createContext<Selection | null>(null);
const key = "outcomia:active-chain";

/** Storage remembers intent only. Live wallet state, never the stored label,
 * determines the active chain. Clear intent before any asynchronous switch so
 * old financial pages cannot remain mounted during wallet approval.
 */
export function NetworkWalletProvider({ children }: { children: ReactNode }) {
  const solana = useWallet();
  const canton = useCantonWallet();
  const { visible, setVisible } = useWalletModal();
  const { t } = useI18n();
  const [intent, setIntent] = useState<Chain | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingName, setPendingName] = useState<string | null>(null);
  const operation = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);

  function remember(chain: Chain | null) {
    setIntent(chain);
    try {
      if (chain) sessionStorage.setItem(key, chain);
      else sessionStorage.removeItem(key);
    } catch {
      /* Browser storage is optional; verification is not. */
    }
  }
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(key);
      if (saved === "solana" || saved === "canton") setIntent(saved);
      if (saved === "solana") {
        const name: unknown = JSON.parse(
          localStorage.getItem("walletName") ?? "null",
        );
        if (typeof name === "string") setPendingName(name);
        else remember(null);
      }
    } catch {
      /* Start disconnected. */
    }
    setReady(true);
  }, []);

  // Adapter selection updates React state asynchronously. Connect only once
  // the provider exposes the chosen adapter, including when restoring a hint.
  useEffect(() => {
    if (!ready || !pendingName || intent !== "solana" || operation.current)
      return;
    if (pendingName && solana.wallet?.adapter.name !== pendingName) {
      const target = solana.wallets.find(
        ({ adapter }) => adapter.name === pendingName,
      );
      if (target) solana.select(target.adapter.name);
      else {
        remember(null);
        setPendingName(null);
        setError("The selected Solana wallet is unavailable.");
      }
      return;
    }
    if (!solana.wallet) return;
    if (solana.connected || solana.connecting) return;
    operation.current = true;
    setBusy(true);
    setPendingName(null);
    void solana
      .connect()
      .catch((cause) => {
        remember(null);
        setError(walletError(cause));
      })
      .finally(() => {
        operation.current = false;
        setBusy(false);
      });
  }, [
    ready,
    intent,
    pendingName,
    solana.wallet,
    solana.connected,
    solana.connecting,
    solana.connect,
    solana.select,
    solana.wallets,
    busy,
  ]);

  useEffect(() => {
    if (visible) dialog.current?.showModal();
    else dialog.current?.close();
  }, [visible]);

  async function disconnect() {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    setError(null);
    remember(null);
    setPendingName(null);
    try {
      if (solana.connected) await solana.disconnect();
      solana.select(null);
      if (canton.requiresDisconnect) await canton.disconnect();
    } catch (cause) {
      setError(walletError(cause));
    } finally {
      operation.current = false;
      setBusy(false);
    }
  }

  async function choose(chain: Chain, name?: string) {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    setError(null);
    remember(null);
    setPendingName(null);
    try {
      // Revocation completes before attempting the other wallet. If it fails,
      // stay locally disconnected and show the diagnostic instead of proceeding.
      if (solana.connected) await solana.disconnect();
      if (chain === "canton") solana.select(null);
      if (canton.requiresDisconnect) await canton.disconnect();
      if (chain === "canton") {
        remember("canton");
        // Loop mounts its approval dialog outside this picker. Release the
        // native modal first so its QR code and wallet links remain interactive.
        setVisible(false);
        dialog.current?.close();
        await canton.connect(name === "loop" ? "loop" : "console");
      } else {
        const target = solana.wallets.find(
          ({ adapter }) => adapter.name === name,
        );
        if (!target)
          throw new Error("The selected Solana wallet is unavailable.");
        remember("solana");
        setPendingName(target.adapter.name);
      }
      setVisible(false);
    } catch (cause) {
      remember(null);
      setError(walletError(cause));
    } finally {
      operation.current = false;
      setBusy(false);
    }
  }
  const cantonBusy = ["connecting", "checking", "disconnecting"].includes(
    canton.state.kind,
  );
  const locked =
    busy ||
    !!pendingName ||
    cantonBusy ||
    solana.connecting ||
    solana.disconnecting;
  const chain =
    !locked && intent === "canton" && canton.state.session
      ? "canton"
      : !locked && intent === "solana" && solana.connected && solana.publicKey
        ? "solana"
        : null;
  const diagnostic = error ?? (intent !== "solana" ? canton.state.error : null);
  const available = ready
    ? solana.wallets.filter(
        ({ readyState }) =>
          readyState === "Installed" || readyState === "Loadable",
      )
    : [];

  return (
    <Context.Provider
      value={{ chain, ready, busy: locked, error: diagnostic, disconnect }}
    >
      {children}
      <dialog
        ref={dialog}
        className="preferences-dialog wallet-picker"
        aria-labelledby="network-wallet-title"
        onClose={() => setVisible(false)}
      >
        <div className="preferences-heading">
          <h2 id="network-wallet-title">{t("Connect wallet")}</h2>
          <button
            type="button"
            aria-label={t("Close wallet selector")}
            onClick={() => setVisible(false)}
          >
            ×
          </button>
        </div>
        <ul>
          <li>
            <button
              type="button"
              disabled={locked}
              onClick={() => void choose("canton", "loop")}
            >
              <span className="chain-wallet-icon" aria-hidden="true">
                L
              </span>
              <span>
                Loop Wallet <small>Canton</small>
              </span>
            </button>
          </li>
          <li>
            <button
              type="button"
              disabled={locked}
              onClick={() => void choose("canton")}
            >
              <span className="chain-wallet-icon" aria-hidden="true">
                C
              </span>
              <span>
                Console Wallet <small>Canton</small>
              </span>
            </button>
          </li>
          {available.map(({ adapter }) => (
            <li key={adapter.name}>
              <button
                type="button"
                disabled={locked}
                onClick={() => void choose("solana", adapter.name)}
              >
                <img src={adapter.icon} width="28" height="28" alt="" />
                <span>
                  {adapter.name}
                  <small>Solana</small>
                </span>
              </button>
            </li>
          ))}
        </ul>
        {!available.length && (
          <p>{t("Install a compatible Solana wallet to continue.")}</p>
        )}
        <a href="https://looptech.io/" target="_blank" rel="noreferrer">
          Loop Wallet ↗
        </a>
        <a href="https://consolewallet.io/" target="_blank" rel="noreferrer">
          {t("Get Console Wallet")} ↗
        </a>
        {locked && <p role="status">{t("Checking wallet…")}</p>}
        {diagnostic && <p role="alert">{diagnostic}</p>}
      </dialog>
    </Context.Provider>
  );
}

export function useNetworkWallet() {
  const value = useContext(Context);
  if (!value) throw new Error("NetworkWalletProvider is required.");
  return value;
}

/** One picker for landing, Canton and existing Solana pages. */
export function SharedWalletButton() {
  const { chain, busy, disconnect } = useNetworkWallet();
  const { setVisible } = useWalletModal();
  const { t } = useI18n();
  return (
    <div className="network-wallet-actions">
      <button
        className="wallet-adapter-button wallet-adapter-button-trigger"
        type="button"
        disabled={busy}
        onClick={() => setVisible(true)}
      >
        {busy
          ? t("Checking wallet…")
          : chain
            ? t("Change wallet")
            : t("Connect wallet")}
      </button>
      {chain && (
        <button
          className="network-disconnect"
          type="button"
          onClick={() => void disconnect()}
        >
          {t("Disconnect")}
        </button>
      )}
    </div>
  );
}
