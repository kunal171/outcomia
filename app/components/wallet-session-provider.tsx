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
import { useWallet } from "@solana/wallet-adapter-react";
import { useIndexerStream } from "./use-indexer-updates";
import { INDEXER_ENABLED } from "../lib/graphql/client";
type User = { id: string; wallet: string };
type Session = {
  user: User | null;
  busy: boolean;
  error: string | null;
  signIn: () => Promise<void>;
};
const Context = createContext<Session | null>(null);
async function call<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api/indexer/auth/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
    cache: "no-store",
    signal,
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error ?? "Wallet sign-in is unavailable");
  }
  return response.status === 204 ? (undefined as T) : response.json();
}
/** A wallet connection permits reads/trades; the login signature owns a profile. */
export function WalletSessionProvider({ children }: { children: ReactNode }) {
  const { publicKey, signMessage } = useWallet();
  const address = publicKey?.toBase58() ?? "";
  useIndexerStream(address);
  const live = useRef(address);
  live.current = address;
  const previous = useRef(address),
    generation = useRef(0),
    controller = useRef<AbortController | null>(null);
  const logout = useRef<Promise<unknown>>(Promise.resolve());
  const signer = useRef(signMessage);
  signer.current = signMessage;
  const [user, setUser] = useState<User | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const signIn = useCallback(async () => {
    if (!INDEXER_ENABLED || !address) return;
    const current = ++generation.current;
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    const assertCurrent = () => {
      if (
        request.signal.aborted ||
        live.current !== address ||
        generation.current !== current
      )
        throw new Error("Wallet changed during sign-in");
    };
    setBusy(true);
    setError(null);
    try {
      await logout.current;
      assertCurrent();
      const session = await call<User | null>("me", undefined, request.signal);
      assertCurrent();
      if (session?.wallet === address) {
        setUser(session);
        return;
      }
      if (session) {
        await call("logout", {}, request.signal);
        assertCurrent();
      }
      if (!signer.current)
        throw new Error(
          "This wallet does not support message signing. Indexed public data remains available.",
        );
      const challenge = await call<{ nonce: string; message: string }>(
        "challenge",
        { wallet: address },
        request.signal,
      );
      assertCurrent();
      const signature = await signer.current(
        new TextEncoder().encode(challenge.message),
      );
      assertCurrent();
      const encoded = btoa(String.fromCharCode(...signature));
      const signed = await call<User>(
        "verify",
        { wallet: address, nonce: challenge.nonce, signature: encoded },
        request.signal,
      );
      assertCurrent();
      if (signed.wallet !== address)
        throw new Error("Signed-in wallet mismatch");
      setUser(signed);
      window.dispatchEvent(new CustomEvent("outcomia:indexed-update"));
    } catch (cause) {
      if (
        !request.signal.aborted &&
        live.current === address &&
        generation.current === current
      )
        setError(
          cause instanceof Error ? cause.message : "Wallet sign-in failed",
        );
    } finally {
      if (generation.current === current) setBusy(false);
    }
  }, [address]);
  useEffect(() => {
    setUser(null);
    setError(null);
    setBusy(false);
    if (!INDEXER_ENABLED) return;
    if (previous.current && previous.current !== address)
      logout.current = call("logout", {}).catch(() => {});
    previous.current = address;
    // Defer the attempt so Strict Mode's discarded effect never opens a wallet prompt.
    const timer = address
      ? setTimeout(() => {
          void signIn();
        }, 0)
      : null;
    return () => {
      if (timer) clearTimeout(timer);
      generation.current++;
      controller.current?.abort();
    };
  }, [address, signIn]);
  return (
    <Context.Provider
      value={{
        user: user?.wallet === address ? user : null,
        busy,
        error,
        signIn,
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function WalletSessionStatus() {
  const session = useContext(Context);
  if (!INDEXER_ENABLED || !session) return null;
  return (
    <div className="wallet-session-status">
      {session.user ? (
        <span title="Wallet ownership verified">Signed in</span>
      ) : (
        <button
          className="admin-action-button"
          disabled={session.busy}
          onClick={() => void session.signIn()}
        >
          {session.busy ? "Signing in…" : "Sign in"}
        </button>
      )}
      <small
        className="indexed-commitment"
        title="Book and balance updates await finalization. Charts show finalized executions."
      >
        Confirmed live data
      </small>
      {session.error && (
        <details>
          <summary>Sign-in status</summary>
          <p role="alert">{session.error}</p>
        </details>
      )}
    </div>
  );
}
