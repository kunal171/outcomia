/**
 * CIP-0103 (Canton dApp Standard) client side. Every Canton wallet is used
 * through this EIP-1193-style provider: `request({ method, params })` plus
 * `on`/`removeListener` for `txChanged`, `accountsChanged` and
 * `statusChanged`. Wallet SDKs are adapted to it at their own boundary
 * (see `lib/console-wallet.ts`); nothing here imports an SDK.
 *
 * Spec: https://github.com/canton-foundation/cips/blob/main/cip-0103/cip-0103.md
 */

export type Cip103Listener = (payload: unknown) => void;

/** The Provider API from CIP-0103 (an exact replica of EIP-1193's). */
export interface Cip103Provider {
  request<T = unknown>(args: { method: string; params?: unknown }): Promise<T>;
  on(event: string, listener: Cip103Listener): unknown;
  removeListener(event: string, listener: Cip103Listener): unknown;
}

export type TxChangedExecuted = {
  status: "executed";
  commandId: string;
  payload: { updateId: string; completionOffset: number };
};

/** EIP-1193/1474 error shape required by CIP-0103. */
export class Cip103Error extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "Cip103Error";
    this.code = code;
    this.data = data;
  }
}

/** User-facing text for every error code CIP-0103 lists. */
const MESSAGES: Record<number, string> = {
  4001: "You rejected the request in your wallet.",
  4100: "Your wallet has not authorized this app or account. Reconnect and approve access.",
  4200: "Your wallet does not support this request.",
  4900: "Your wallet is disconnected. Reconnect and try again.",
  4901: "Your wallet is not connected to this Canton network. Switch networks and reconnect.",
  [-32700]: "The wallet could not read this request.",
  [-32600]: "The wallet could not read this request.",
  [-32601]: "Your wallet does not support this request.",
  [-32602]: "The wallet rejected this request's parameters.",
  [-32603]: "The wallet hit an internal error. Try again.",
  [-32000]: "The wallet rejected this request's inputs.",
  [-32001]:
    "The wallet could not find a required contract. Refresh and try again.",
  [-32002]: "This wallet resource is unavailable. Try again shortly.",
  [-32003]: "The transaction was rejected.",
  [-32004]: "Your wallet does not support this request.",
  [-32005]: "The wallet's request limit was exceeded. Wait and try again.",
};

/** Message for a provider error that carries a standard code, else null.
 * A rejected transaction keeps the wallet's reason, which names the failure.
 * Example: { code: 4001 } → "You rejected the request in your wallet." */
export function cip103Message(cause: unknown): string | null {
  if (!cause || typeof cause !== "object" || !("code" in cause)) return null;
  const code = Number(cause.code),
    text = MESSAGES[code];
  if (!text) return null;
  const detail =
    "message" in cause && typeof cause.message === "string"
      ? cause.message.trim()
      : "";
  return code === -32003 && detail && detail !== text
    ? `${text} ${detail}`
    : text;
}

/** Proxied JSON Ledger API call (`ledgerApi`), authenticated by the wallet as
 * the connected party. Methods are lowercase per the spec. */
export function ledgerApi(
  provider: Cip103Provider,
  resource: string,
  body?: Record<string, unknown>,
) {
  return provider.request<unknown>({
    method: "ledgerApi",
    params: {
      requestMethod: body ? "post" : "get",
      resource,
      ...(body ? { body } : {}),
    },
  });
}

/**
 * Submits with `prepareExecute` and follows its `txChanged` events. Resolves
 * only on `executed` for this command ID; rejects on `failed`, a provider
 * error or the timeout. The listener is attached before the request, so a
 * fast wallet cannot emit the result unseen. Never retries: after a timeout
 * the transaction may still execute, so the caller must refresh first.
 */
export function executePrepared(
  provider: Cip103Provider,
  request: { commandId: string } & Record<string, unknown>,
  timeoutMs = 180_000,
): Promise<TxChangedExecuted> {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (settle: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      provider.removeListener("txChanged", listener);
      settle();
    };
    const listener: Cip103Listener = (payload) => {
      const event = (payload ?? {}) as Record<string, unknown>;
      if (event.commandId !== request.commandId) return;
      if (event.status === "executed") {
        const result = (event.payload ?? {}) as Record<string, unknown>;
        if (typeof result.updateId !== "string" || !result.updateId)
          return finish(() =>
            reject(
              new Error(
                "Wallet execution is not confirmed. Refresh before retrying.",
              ),
            ),
          );
        finish(() => resolve(event as unknown as TxChangedExecuted));
      } else if (event.status === "failed")
        finish(() =>
          reject(
            new Cip103Error(
              -32003,
              "The wallet reports this transaction failed. Refresh before retrying.",
            ),
          ),
        );
    };
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(
            new Error(
              "No confirmation from the wallet yet. Refresh before retrying; the transaction may still execute.",
            ),
          ),
        ),
      timeoutMs,
    );
    provider.on("txChanged", listener);
    provider
      .request({ method: "prepareExecute", params: request })
      .catch((cause: unknown) => finish(() => reject(cause)));
  });
}
