"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { CantonSession } from "../lib/canton-session";
import { loadWallet, readSession, walletError } from "../lib/console-wallet";

type State =
  | {
      kind: "idle" | "connecting" | "checking" | "disconnecting";
      session: null;
      error: null;
    }
  | { kind: "connected"; session: CantonSession; error: null }
  | { kind: "error"; session: null; error: string };
type WalletContext = {
  state: State;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
};
const Context = createContext<WalletContext | null>(null);
const idle: State = { kind: "idle", session: null, error: null };
const restoreKey = "outcomia-canton:restore-console";

/** One live wallet session owns the workspace. Generations reject stale async reads.
 * Only a restore hint is saved; every reload rechecks the wallet and its network.
 */
export function CantonWalletProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({
    kind: "checking",
    session: null,
    error: null,
  });
  const [watching, setWatching] = useState(false);
  const generation = useRef(0);
  const mounted = useRef(false);
  const pending = useRef(false);
  const saveHint = (value: boolean) => {
    try {
      if (value) sessionStorage.setItem(restoreKey, "1");
      else sessionStorage.removeItem(restoreKey);
    } catch {
      /* A session remains usable when browser storage is unavailable. */
    }
  };
  const publish = useCallback((ticket: number, next: State) => {
    if (mounted.current && generation.current === ticket) setState(next);
  }, []);

  const refresh = useCallback(async () => {
    const ticket = ++generation.current;
    setState({ kind: "checking", session: null, error: null });
    try {
      const wallet = await loadWallet();
      const session = await readSession(wallet);
      publish(ticket, { kind: "connected", session, error: null });
    } catch (cause) {
      if (generation.current !== ticket) return;
      saveHint(false);
      publish(ticket, {
        kind: "error",
        session: null,
        error: walletError(cause),
      });
    }
  }, [publish]);

  useEffect(() => {
    mounted.current = true;
    let restore = false;
    try {
      restore =
        sessionStorage.getItem(restoreKey) === "1" &&
        sessionStorage.getItem("outcomia:active-chain") === "canton";
    } catch {
      /* No stored connection hint. */
    }
    if (restore) {
      setWatching(true);
      void refresh();
    } else setState(idle);
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, [refresh]);

  useEffect(() => {
    if (!watching) return;
    let disposed = false;
    let unsubscribe: Array<() => void> = [];
    void loadWallet()
      .then((wallet) => {
        if (disposed) return;
        const clear = () => {
          generation.current++;
          saveHint(false);
          setState(idle);
        };
        unsubscribe = [
          wallet.onAccountsChanged(
            { id: "outcomia-canton-account" },
            (account) => {
              if (disposed || pending.current) return;
              // Invalidate the old party immediately, before querying its replacement.
              if (!account) clear();
              else void refresh();
            },
          ),
          wallet.onConnectionStatusChanged(
            { id: "outcomia-canton-status" },
            (status) => {
              if (disposed || pending.current) return;
              if (
                !status?.connection.isConnected ||
                status.connection.isNetworkConnected === false
              )
                clear();
              else void refresh();
            },
          ),
        ];
      })
      .catch((cause) => {
        if (!disposed) {
          generation.current++;
          saveHint(false);
          setState({ kind: "error", session: null, error: walletError(cause) });
        }
      });
    return () => {
      disposed = true;
      unsubscribe.forEach((remove) => remove());
    };
  }, [watching, refresh]);

  async function connect() {
    if (pending.current) return;
    pending.current = true;
    const ticket = ++generation.current;
    setState({ kind: "connecting", session: null, error: null });
    try {
      const wallet = await loadWallet();
      const availability = await wallet.checkExtensionAvailability();
      if (availability.status !== "installed")
        throw new Error(
          "Install Console Wallet to continue, then reload this page.",
        );
      if (availability.isExtensionCapableByVersion === false)
        throw new Error("Update Console Wallet before connecting.");
      const response = await wallet.connect({
        name: "Outcomia",
        target: "local",
      });
      if (!response.isConnected)
        throw new Error("The wallet connection was not approved.");
      const session = await readSession(wallet);
      if (generation.current === ticket) {
        saveHint(true);
        publish(ticket, { kind: "connected", session, error: null });
        setWatching(true);
      }
    } catch (cause) {
      saveHint(false);
      publish(ticket, {
        kind: "error",
        session: null,
        error: walletError(cause),
      });
    } finally {
      pending.current = false;
    }
  }

  async function disconnect() {
    if (pending.current) return;
    pending.current = true;
    const ticket = ++generation.current;
    saveHint(false);
    setWatching(false);
    setState({ kind: "disconnecting", session: null, error: null });
    try {
      await (await loadWallet()).disconnect();
      publish(ticket, idle);
    } catch {
      publish(ticket, {
        kind: "error",
        session: null,
        error:
          "Disconnected locally. Review this site's access in Console Wallet.",
      });
      throw new Error(
        "Console Wallet disconnection failed. Review this site's access before switching wallets.",
      );
    } finally {
      pending.current = false;
    }
  }
  return (
    <Context.Provider value={{ state, connect, disconnect }}>
      {children}
    </Context.Provider>
  );
}
export function useCantonWallet() {
  const value = useContext(Context);
  if (!value) throw new Error("CantonWalletProvider is required.");
  return value;
}
