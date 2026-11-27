/** Pure parts of Canton profile claims: the create command and finding the
 * created claim in an active-contracts response. */
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export type ClaimChallenge = {
  nonce: string;
  operator: string;
  templateId: string;
  network: string;
  purpose: "ClaimSignIn" | "ClaimLink";
  solanaWallet: string | null;
};

/** The create command for a claim; the template enforces its shape too. */
export function claimCommand(challenge: ClaimChallenge, party: string) {
  if (!/^[0-9a-f]{64}$/.test(challenge.nonce))
    throw new Error("Invalid sign-in challenge.");
  return {
    CreateCommand: {
      templateId: challenge.templateId,
      createArguments: {
        operator: challenge.operator,
        party,
        purpose: challenge.purpose,
        nonce: challenge.nonce,
        solanaWallet: challenge.solanaWallet,
      },
    },
  };
}

/** The contract id of this party's active claim carrying `nonce`. */
export function findClaimId(
  response: unknown,
  templateId: string,
  party: string,
  nonce: string,
): string {
  const rows = Array.isArray(response)
    ? response
    : ((response as { items?: unknown[] })?.items ?? []);
  for (const row of rows) {
    const item = record(row);
    const entry = record(item.contractEntry ?? item);
    const active = record(
      entry.JsActiveContract ?? entry.activeContract ?? entry,
    );
    const event = record(active.createdEvent);
    const args = record(event.createArgument);
    if (
      event.templateId === templateId &&
      args.party === party &&
      args.nonce === nonce &&
      typeof event.contractId === "string"
    )
      return event.contractId;
  }
  throw new Error(
    "The wallet confirmed, but the claim is not visible yet. Try again.",
  );
}
