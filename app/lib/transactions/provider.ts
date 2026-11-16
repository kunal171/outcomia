import { AnchorProvider, utils } from "@anchor-lang/core";
import {
  VersionedTransaction,
  SendTransactionError,
  type Connection,
} from "@solana/web3.js";
import { INDEXER_ENABLED } from "../graphql/client";
import {
  rememberBroadcast,
  forgetRejectedBroadcast,
  sendWithIndexedReceipt,
} from "../graphql/receipts";

type Wallet = ConstructorParameters<typeof AnchorProvider>[1];

/** Keep Anchor's signing/confirmation flow, while tracking the actual broadcast. */
export function createGuardedProvider(connection: Connection, wallet: Wallet) {
  const options = { commitment: "confirmed", preflightCommitment: "confirmed" } as const;
  if (!INDEXER_ENABLED) return new AnchorProvider(connection, wallet, options);
  const heights = new Map<string, number>();
  let attempt: { signature: string; result: Promise<string> } | undefined;
  const tracked = new Proxy(connection, {
    get(target, property) {
      if (property === "getLatestBlockhash")
        return async (...args: Parameters<Connection["getLatestBlockhash"]>) => {
          const blockhash = await target.getLatestBlockhash(...args);
          heights.set(blockhash.blockhash, blockhash.lastValidBlockHeight);
          return blockhash;
        };
      if (property === "sendRawTransaction")
        return (...args: Parameters<Connection["sendRawTransaction"]>) => {
          const transaction = VersionedTransaction.deserialize(Uint8Array.from(args[0]));
          if (!transaction.signatures[0]?.some((byte) => byte !== 0))
            throw new Error("Wallet did not sign the transaction");
          const signature = utils.bytes.bs58.encode(transaction.signatures[0]);
          if (attempt) {
            if (attempt.signature !== signature)
              throw new Error("A different transaction is already being sent");
            return attempt.result;
          }
          rememberBroadcast(
            wallet.publicKey,
            signature,
            heights.get(transaction.message.recentBlockhash),
          );
          const result = target.sendRawTransaction(...args).then((returned) => {
            if (returned !== signature)
              throw new Error("RPC returned a different transaction signature");
            return returned;
          }).catch((error: unknown) => {
            if (error instanceof SendTransactionError && error.message.startsWith("Simulation failed.")) {
              forgetRejectedBroadcast(wallet.publicKey, signature);
              throw error;
            }
            // Avoid Anchor retrying an ambiguous TimeoutError as a new write.
            throw new Error("Transaction broadcast reply was unavailable", { cause: error });
          });
          attempt = { signature, result };
          return result;
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" && property !== "constructor" ? value.bind(target) : value;
    },
  });
  const provider = new AnchorProvider(tracked, wallet, options);
  const send = provider.sendAndConfirm.bind(provider);
  provider.sendAndConfirm = (transaction, signers, opts) =>
    sendWithIndexedReceipt(wallet.publicKey, async () => {
      attempt = undefined;
      if (opts?.blockhash)
        heights.set(opts.blockhash.blockhash, opts.blockhash.lastValidBlockHeight);
      if (
        "recentBlockhash" in transaction &&
        transaction.recentBlockhash &&
        transaction.lastValidBlockHeight !== undefined
      ) {
        heights.set(transaction.recentBlockhash, transaction.lastValidBlockHeight);
      }
      try {
        return await send(transaction, signers, opts);
      } finally {
        attempt = undefined;
      }
    }, connection);
  // Keep the same receipt protection if a caller uses Anchor's batch API.
  provider.sendAll = async (transactions, opts) => {
    const signatures = [];
    for (const transaction of transactions)
      signatures.push(await provider.sendAndConfirm(
        transaction.tx,
        transaction.signers,
        opts,
      ));
    return signatures;
  };
  return provider;
}
