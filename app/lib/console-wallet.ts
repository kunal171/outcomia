import { configuredNetwork, verifySession } from "./canton-session.ts";
import { walletNetworks } from "./canton-display.ts";
import {
  Cip103Error,
  cip103Message,
  type Cip103Listener,
  type Cip103Provider,
} from "./canton/cip103.ts";

// Import only in the browser. The SDK owns approval, transport and signing.
export const loadWallet = async () =>
  (await import("@console-wallet/dapp-sdk")).consoleWallet;
export const expectedNetwork = configuredNetwork(
  process.env.NEXT_PUBLIC_CANTON_NETWORK_ID,
);

type ConsoleWallet = Awaited<ReturnType<typeof loadWallet>>;
type Unsubscribe = () => void;

/**
 * CIP-0103 provider over Console Wallet's SDK. Console exposes the standard
 * methods as plain functions and the standard events as `on…Changed`
 * subscriptions; this adapter gives them the standard `request`/`on` shape so
 * the app talks to every wallet the same way. Console's `ledgerApi` needs an
 * access token: the adapter obtains it per call through `ledgerAuth` and drops
 * it immediately, so no token leaves this function or reaches React state.
 */
export function consoleProvider(
  wallet: ConsoleWallet,
  network: Parameters<ConsoleWallet["ledgerApi"]>[0]["network"],
): Cip103Provider {
  const handlers: Record<string, (params: unknown) => Promise<unknown>> = {
    connect: async () => {
      const availability = await wallet.checkExtensionAvailability();
      if (availability.status !== "installed")
        throw new Cip103Error(
          4900,
          "Install Console Wallet to continue, then reload this page.",
        );
      if (availability.isExtensionCapableByVersion === false)
        throw new Cip103Error(4900, "Update Console Wallet before connecting.");
      return wallet.connect({ name: "Outcomia", target: "local" });
    },
    disconnect: async () => {
      await wallet.disconnect();
      return null;
    },
    isConnected: () => wallet.isConnected(),
    status: () => wallet.status(),
    getActiveNetwork: () => wallet.getActiveNetwork(),
    getPrimaryAccount: () => wallet.getPrimaryAccount(),
    listAccounts: () => wallet.getAccounts(),
    signMessage: (params) =>
      wallet.signMessage(params as Parameters<ConsoleWallet["signMessage"]>[0]),
    prepareExecute: async (params) => {
      await wallet.prepareExecute(
        params as Parameters<ConsoleWallet["prepareExecute"]>[0],
      );
      return null;
    },
    ledgerApi: async (params) => {
      const request = (params ?? {}) as {
        requestMethod?: string;
        resource?: string;
        body?: unknown;
      };
      if (typeof request.resource !== "string" || !request.requestMethod)
        throw new Cip103Error(-32602, "Invalid ledgerApi request.");
      const account = await wallet.getPrimaryAccount();
      if (!account) throw new Cip103Error(4100, "Select a primary party.");
      const auth = await wallet.ledgerAuth({
        publicKey: account.publicKey,
        partyId: account.partyId,
        network,
      });
      const result = await wallet.ledgerApi({
        accessToken: auth.accessToken,
        network,
        resource: request.resource,
        requestMethod: request.requestMethod.toUpperCase() as "GET" | "POST",
        ...(request.body !== undefined
          ? { body: JSON.stringify(request.body) }
          : {}),
      });
      return JSON.parse(result.response) as unknown;
    },
  };
  const subscribe: Record<
    string,
    (id: string, listener: Cip103Listener) => Unsubscribe
  > = {
    txChanged: (id, listener) => wallet.onTxStatusChanged({ id }, listener),
    accountsChanged: (id, listener) =>
      wallet.onAccountsChanged({ id }, listener),
    statusChanged: (id, listener) =>
      wallet.onConnectionStatusChanged({ id }, listener),
  };
  const active = new Map<string, Map<Cip103Listener, Unsubscribe>>();
  let next = 0;
  const provider: Cip103Provider = {
    async request<T>({ method, params }: { method: string; params?: unknown }) {
      const handler = handlers[method];
      if (!handler)
        throw new Cip103Error(
          4200,
          `Console Wallet does not support ${method}.`,
        );
      return (await handler(params)) as T;
    },
    on(event, listener) {
      const add = subscribe[event];
      if (!add) return provider;
      const listeners = active.get(event) ?? new Map();
      if (!listeners.has(listener))
        // Console replaces a subscriber with the same id, so ids are unique.
        listeners.set(listener, add(`outcomia-${event}-${++next}`, listener));
      active.set(event, listeners);
      return provider;
    },
    removeListener(event, listener) {
      const listeners = active.get(event);
      listeners?.get(listener)?.();
      listeners?.delete(listener);
      return provider;
    },
  };
  return provider;
}

let provider: Promise<Cip103Provider> | undefined;
/** The app-wide Console provider, created once in the browser. */
export function loadConsoleProvider() {
  provider ??= import("@console-wallet/dapp-sdk").then((sdk) =>
    consoleProvider(
      sdk.consoleWallet,
      sdk.CANTON_NETWORK_VARIANTS[walletNetworks[expectedNetwork]],
    ),
  );
  return provider;
}

/** Live identity through the standard methods; a remembered party is never a session. */
export async function readSession() {
  const wallet = await loadConsoleProvider();
  const status = await wallet.request<Parameters<typeof verifySession>[0]>({
    method: "status",
  });
  const [account, network] = await Promise.all([
    wallet.request<Parameters<typeof verifySession>[1]>({
      method: "getPrimaryAccount",
    }),
    wallet.request<Parameters<typeof verifySession>[2]>({
      method: "getActiveNetwork",
    }),
  ]);
  return verifySession(status, account, network, expectedNetwork);
}

/** Standard CIP-0103 error codes get clear text; other wallet diagnostics stay
 * readable without rendering arbitrary objects. */
export function walletError(cause: unknown): string {
  const standard = cip103Message(cause);
  if (standard) return standard;
  if (cause instanceof Error) return cause.message;
  if (
    typeof cause === "object" &&
    cause &&
    "message" in cause &&
    typeof cause.message === "string"
  )
    return cause.message;
  return "Wallet connection failed. Check your wallet and try again.";
}
