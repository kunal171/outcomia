import type { CantonSession } from "../canton-session";
import type { Command } from "./commands";
import { obj, type Deployment } from "./model.ts";
export type Disclosure = {
  templateId: string;
  contractId: string;
  createdEventBlob: string;
  synchronizerId?: string;
};
export type Submission = {
  commandId: string;
  commands: Command[];
  actAs: string[];
  readAs: string[];
  synchronizerId: string;
  packageIdSelectionPreference: string[];
  disclosedContracts: Disclosure[];
};
export function assertIdentity(
  expected: CantonSession,
  current: CantonSession,
) {
  if (
    current.partyId !== expected.partyId ||
    current.networkId !== expected.networkId ||
    current.wallet !== expected.wallet
  )
    throw new Error("Wallet changed. Reconnect and refresh.");
}
/** Inputs: verified identity, pinned deployment and wallet-owned IO. Errors:
 * identity change, disabled/wrong network, failed or mismatched receipt. Result:
 * confirmed update ID only. Never retries a transaction after a timeout/failure. */
export async function executeWallet(
  session: CantonSession,
  d: Deployment,
  command: Command,
  disclosures: Disclosure[],
  read: () => Promise<CantonSession>,
  send: (request: Submission) => Promise<unknown>,
) {
  if (!d.trading || d.network !== session.networkId)
    throw new Error("Canton trading is not enabled on this network.");
  assertIdentity(session, await read());
  const request = structuredClone({
    commandId: crypto.randomUUID(),
    commands: [command],
    actAs: [session.partyId],
    readAs: [session.partyId],
    synchronizerId: d.synchronizerId,
    packageIdSelectionPreference: [d.packageId],
    disclosedContracts: disclosures,
  });
  const response = await send(request);
  assertIdentity(session, await read());
  const tx = obj(obj(response).tx),
    payload = obj(tx.payload);
  if (
    tx.status !== "executed" ||
    tx.commandId !== request.commandId ||
    typeof payload.updateId !== "string" ||
    !payload.updateId
  )
    throw new Error(
      "Wallet execution is not confirmed. Refresh before retrying.",
    );
  return payload.updateId;
}
