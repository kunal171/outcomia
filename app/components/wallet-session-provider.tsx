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
import { ReadSourceStatus } from "./read-source-status";
import { useIndexerStream } from "./use-indexer-updates";
import {
  INDEXER_ENABLED,
  IndexerUnavailableError,
} from "../lib/graphql/client";
import {
  callWalletAuth as call,
  type WalletUser as User,
} from "../lib/auth/client";
type Session = {
  user: User | null;
  busy: boolean;
  error: string | null;
  deferred: boolean;
  signIn: () => Promise<void>;
};
const Context = createContext<Session | null>(null);
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
    [deferred, setDeferred] = useState(false),
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
    setDeferred(false);
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
      ) {
        if (cause instanceof IndexerUnavailableError) {
          setDeferred(true);
          setError(
            "Your wallet is connected. You can deposit and trade; profile verification can wait. Finalized on-chain activity will register your wallet when the indexer recovers.",
          );
        } else {
          setError(
            cause instanceof Error ? cause.message : "Wallet sign-in failed",
          );
        }
      }
    } finally {
      if (generation.current === current) setBusy(false);
    }
  }, [address]);
  useEffect(() => {
    setUser(null);
    setDeferred(false);
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
  useEffect(() => {
    if (!INDEXER_ENABLED || !address || !deferred) return;
    const recovery = new AbortController();
    let checking = false;
    const timer = setInterval(() => {
      if (checking) return;
      checking = true;
      void call<User | null>("me", undefined, recovery.signal)
        .then((session) => {
          if (recovery.signal.aborted || live.current !== address) return;
          if (session?.wallet === address) setUser(session);
          setDeferred(false);
          setError(null);
        })
        .catch(() => {
          /* Connected-wallet access remains available during recovery. */
        })
        .finally(() => {
          checking = false;
        });
    }, 15000);
    return () => {
      recovery.abort();
      clearInterval(timer);
    };
  }, [address, deferred]);
  return (
    <Context.Provider
      value={{
        user: user?.wallet === address ? user : null,
        busy,
        error,
        deferred,
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
  // One compact row: status (with the data source under it), an optional
  // Sign in button and, after a failed attempt, a "!" chip whose message
  // opens on click instead of floating over the page.
  return (
    <div className="wallet-session-status">
      <div className="wss-state">
        <span
          className={session.user ? "wss-label wss-signed" : "wss-label"}
          title={
            session.user
              ? "Wallet ownership verified"
              : "Your wallet can deposit and trade without a website session"
          }
        >
          <i aria-hidden="true" />
          {session.user ? "Signed in" : "Wallet connected"}
        </span>
        <ReadSourceStatus />
      </div>
      {!session.user && (
        <button
          type="button"
          className="wss-signin"
          disabled={session.busy}
          onClick={() => void session.signIn()}
        >
          {session.busy
            ? "Signing in…"
            : session.deferred
              ? "Retry sign-in"
              : "Sign in"}
        </button>
      )}
      {session.error && (
        <details className="wss-issue">
          <summary aria-label="Sign-in status" title="Sign-in status">
            !
          </summary>
          <p role={session.deferred ? "status" : "alert"}>{session.error}</p>
        </details>
      )}
    </div>
  );
}
