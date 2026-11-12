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
import { walletError } from "../lib/console-wallet";
import { cantonAdapter, type CantonWalletId } from "../lib/canton-adapter";

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
  connect: (wallet?: CantonWalletId) => Promise<void>;
  disconnect: () => Promise<void>;
  requiresDisconnect: boolean;
};
const Context = createContext<WalletContext | null>(null);
const idle: State = { kind: "idle", session: null, error: null };
const restoreKey = "outcomia-canton:wallet";

/** One live wallet session owns the workspace. Generations reject stale async reads.
 * Only a restore hint is saved; every reload rechecks the wallet and its network.
 */
export function CantonWalletProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({
    kind: "checking",
    session: null,
    error: null,
  });
  const [watching, setWatching] = useState<CantonWalletId | null>(null);
  const selected = useRef<CantonWalletId>("console");
  const generation = useRef(0);
  const mounted = useRef(false);
  const pending = useRef(false);
  const requiresDisconnect = useRef(false);
  const saveHint = (value: boolean) => {
    try {
      if (value) sessionStorage.setItem(restoreKey, selected.current);
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
      const session = await (await cantonAdapter(selected.current)).read();
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
    let restore: CantonWalletId | null = null;
    try {
      const saved = sessionStorage.getItem(restoreKey);
      const legacy = sessionStorage.getItem("outcomia-canton:restore-console");
      if (sessionStorage.getItem("outcomia:active-chain") === "canton") {
        if (saved === "loop" || saved === "console") restore = saved;
        else if (legacy === "1") {
          restore = "console";
          sessionStorage.setItem(restoreKey, restore);
        }
      }
      sessionStorage.removeItem("outcomia-canton:restore-console");
    } catch {
      /* No stored connection hint. */
    }
    if (restore) {
      selected.current = restore;
      requiresDisconnect.current = true;
      setWatching(restore);
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
    let unsubscribe: (() => void) | undefined;
    void cantonAdapter(watching)
      .then((adapter) => {
        if (disposed) return;
        unsubscribe = adapter.watch(() => {
          if (disposed || pending.current) return;
          // Clear the old identity before verifying an account or network event.
          void refresh();
        });
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
      unsubscribe?.();
    };
  }, [watching, refresh]);

  async function connect(id: CantonWalletId = "console") {
    if (pending.current) return;
    pending.current = true;
    selected.current = id;
    setWatching(null);
    const ticket = ++generation.current;
    setState({ kind: "connecting", session: null, error: null });
    try {
      // Loop may have issued an authorization ticket before approval fails.
      // Require revocation before another wallet even when verification fails.
      if (id === "loop") requiresDisconnect.current = true;
      const session = await (await cantonAdapter(id)).connect();
      requiresDisconnect.current = true;
      if (generation.current === ticket) {
        saveHint(true);
        publish(ticket, { kind: "connected", session, error: null });
        setWatching(id);
      }
    } catch (cause) {
      saveHint(false);
      publish(ticket, {
        kind: "error",
        session: null,
        error: walletError(cause),
      });
      throw cause;
    } finally {
      pending.current = false;
    }
  }

  async function disconnect() {
    if (pending.current) return;
    pending.current = true;
    const ticket = ++generation.current;
    saveHint(false);
    setWatching(null);
    setState({ kind: "disconnecting", session: null, error: null });
    try {
      await (await cantonAdapter(selected.current)).disconnect();
      requiresDisconnect.current = false;
      publish(ticket, idle);
    } catch {
      publish(ticket, {
        kind: "error",
        session: null,
        error:
          "Disconnected locally. Review this site's access in your Canton wallet.",
      });
      throw new Error(
        "Canton wallet disconnection failed. Review this site's access before switching wallets.",
      );
    } finally {
      pending.current = false;
    }
  }
  return (
    <Context.Provider
      value={{
        state,
        connect,
        disconnect,
        requiresDisconnect: requiresDisconnect.current,
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useCantonWallet() {
  const value = useContext(Context);
  if (!value) throw new Error("CantonWalletProvider is required.");
  return value;
}
