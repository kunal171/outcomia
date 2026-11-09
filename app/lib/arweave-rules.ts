/** Browser uploads use the creator's message signature; no private key or API route. */
import type { PublicKey } from "@solana/web3.js";
import { MAX_RULES_UPLOAD_BYTES } from "./prediction-rules-draft";

export interface ArweaveRulesUpload {
  id: string;
  uri: string;
  content: string;
  owner: string;
  receipt: unknown;
}
export const RULES_GATEWAY = "https://turbo-gateway.com/raw/";

/** Exact-byte comparison includes whitespace and the trailing newline. Gateway
 * availability is not proof of final Arweave block inclusion. Mismatches stop
 * creation; a new upload is never used to hide failed verification.
 */
export async function verifyArweaveRules(
  upload: ArweaveRulesUpload,
): Promise<void> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(upload.id))
    throw new Error("Invalid Arweave upload ID");
  const expected = new TextEncoder().encode(upload.content);
  if (expected.byteLength > MAX_RULES_UPLOAD_BYTES)
    throw new Error("Rules exceed the upload limit");
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(`${RULES_GATEWAY}${upload.id}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(12000),
    });
    if (response.status === 404 && attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      continue;
    }
    if (!response.ok)
      throw new Error(
        `Rules uploaded, but gateway verification failed (${response.status}). Retry to verify the same upload.`,
      );
    if (!response.body) throw new Error("Rules gateway returned no content");
    const reader = response.body.getReader();
    let offset = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (
          offset + value.byteLength > expected.byteLength ||
          value.some((byte, index) => byte !== expected[offset + index])
        )
          throw new Error(
            "Uploaded rules do not match the reviewed JSON. Market creation stopped.",
          );
        offset += value.byteLength;
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    if (offset !== expected.byteLength)
      throw new Error(
        "Uploaded rules are incomplete. Market creation stopped.",
      );
    return;
  }
}

/** Inputs: reviewed JSON and the connected creator's message signer.
 * Returns the accepted upload receipt. It is saved before gateway verification,
 * so a delayed gateway or rejected market transaction can reuse the same item.
 * The SDK is lazy-loaded. No funding/top-up or Solana transaction is allowed.
 * Free allowance is advisory; Turbo makes the final storage-credit decision.
 */
export async function uploadArweaveRules(
  content: string,
  wallet: {
    publicKey: PublicKey;
    signMessage: (message: Uint8Array) => Promise<Uint8Array>;
  },
): Promise<ArweaveRulesUpload> {
  const file = new File([content], "prediction-rules.json", {
    type: "application/json",
  });
  if (file.size > MAX_RULES_UPLOAD_BYTES)
    throw new Error("Rules exceed the 64 KiB upload limit");
  const { TurboFactory } = await import("@ardrive/turbo-sdk/web");
  const turbo = TurboFactory.authenticated({
    token: "solana",
    walletAdapter: {
      publicKey: wallet.publicKey,
      signMessage: wallet.signMessage,
      signTransaction: async () => {
        throw new Error("Storage uploads cannot authorize Solana payments");
      },
    },
  });
  const { bytesRemaining } = await turbo.getFreeStatus();
  if (
    bytesRemaining !== null &&
    (!Number.isSafeInteger(bytesRemaining) || bytesRemaining < 0)
  )
    throw new Error("Turbo returned an invalid upload allowance");
  // Keep the initial workflow within the small-file allowance. This does not
  // reserve quota: an IP/wallet allowance can change before acceptance.
  if (bytesRemaining !== null && bytesRemaining < file.size + 4096)
    throw new Error(
      "Turbo's free upload allowance is unavailable. No top-up or upload was made.",
    );
  const receipt = await turbo.uploadFile({
    file,
    signal: AbortSignal.timeout(60000),
    dataItemOpts: {
      tags: [
        { name: "Content-Type", value: "application/json" },
        { name: "App-Name", value: "Outcomia" },
        { name: "Document-Type", value: "Prediction-Market-Rules" },
        { name: "Schema-Version", value: "1" },
      ],
    },
  });
  if (!/^[A-Za-z0-9_-]{43}$/.test(receipt.id))
    throw new Error("Turbo returned an invalid upload ID");
  return {
    id: receipt.id,
    uri: `ar://${receipt.id}`,
    content,
    owner: wallet.publicKey.toBase58(),
    receipt,
  };
}
