/** Canton sign-in and linking for profiles. The party proves itself by
 * creating an `Outcomia.Profiles:ProfileClaim` with the indexer's one-time
 * nonce through the wallet's CIP-0103 `prepareExecute`; the indexer then reads
 * the claim from the ledger as the operator. No assets move. */
import { executePrepared } from "./cip103.ts";
import { activeContracts, verifyIdentity } from "./transport.ts";
import { cantonProvider } from "../canton-provider.ts";
import type { CantonSession } from "../canton-session.ts";
import { callWalletAuth, type WalletUser } from "../auth/client.ts";
import { claimCommand, findClaimId, type ClaimChallenge } from "./claims.ts";

/** Proves `session.partyId` to the indexer. `signIn` starts a session for the
 * party's profile; `link` adds the party to the signed-in Solana profile. */
export async function proveParty(
  session: CantonSession,
  purpose: "signIn" | "link",
  synchronizerId?: string,
): Promise<WalletUser> {
  const challenge = await callWalletAuth<ClaimChallenge>("canton/challenge", {
    party: session.partyId,
    purpose,
  });
  if (challenge.network !== session.networkId)
    throw new Error(`Connect a Canton wallet on ${challenge.network}.`);
  await verifyIdentity(session);
  const provider = await cantonProvider(session.wallet);
  await executePrepared(provider, {
    commandId: crypto.randomUUID(),
    commands: [claimCommand(challenge, session.partyId)],
    actAs: [session.partyId],
    readAs: [session.partyId],
    ...(synchronizerId ? { synchronizerId } : {}),
    packageIdSelectionPreference: [challenge.templateId.split(":")[0]],
    disclosedContracts: [],
  });
  await verifyIdentity(session);
  const contracts = await activeContracts(session, [
    {
      identifierFilter: {
        TemplateFilter: {
          value: {
            templateId: challenge.templateId,
            includeCreatedEventBlob: false,
          },
        },
      },
    },
  ]);
  const contractId = findClaimId(
    contracts,
    challenge.templateId,
    session.partyId,
    challenge.nonce,
  );
  return callWalletAuth<WalletUser>("canton/verify", {
    party: session.partyId,
    nonce: challenge.nonce,
    contractId,
  });
}

/** Removes a linked party from the signed-in profile. */
export function unlinkParty(party: string) {
  return callWalletAuth<WalletUser>("canton/unlink", { party });
}
