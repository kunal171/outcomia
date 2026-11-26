import { executeWallet, assertIdentity } from "./wallet-flow.ts";
import { selectInputs } from "./holdings.ts";
import { executePrepared, ledgerApi } from "./cip103.ts";
import type { CantonSession } from "../canton-session";
import type { Command } from "./commands";
import {
  decodeContracts,
  obj,
  templateId,
  templates,
  type Deployment,
} from "./model.ts";
import { cantonProvider, readCantonSession } from "../canton-provider";

/** Token Standard holdings, read as interface views. */
const HOLDING_INTERFACE =
  "#splice-api-token-holding-v2:Splice.Api.Token.HoldingV2:Holding";

/** Reverify before AND after every wallet await. Identity swaps never attach old
 * private reads or transaction success to the newly connected wallet. SDK-owned
 * credentials never cross this adapter. No operator/vault readAs is requested. */
export async function verifyIdentity(session: CantonSession) {
  assertIdentity(session, await readCantonSession(session.wallet));
}

/**
 * The party's active contracts matching `filters`, at the current ledger end,
 * through the wallet's CIP-0103 `ledgerApi` (authenticated as that party).
 * Identity is checked before and after the reads.
 */
export async function activeContracts(
  session: CantonSession,
  filters: Record<string, unknown>[],
) {
  await verifyIdentity(session);
  const provider = await cantonProvider(session.wallet);
  const end = obj(await ledgerApi(provider, "/v2/state/ledger-end"));
  if (!/^\d+$/.test(String(end.offset)))
    throw new Error("Invalid wallet ledger offset.");
  const response = await ledgerApi(provider, "/v2/state/active-contracts", {
    eventFormat: {
      filtersByParty: { [session.partyId]: { cumulative: filters } },
      verbose: true,
    },
    activeAtOffset: end.offset,
  });
  await verifyIdentity(session);
  return response;
}

/** The wallet party's unlocked and locked Token Standard holdings. */
export function holdingContracts(session: CantonSession) {
  return activeContracts(session, [
    {
      identifierFilter: {
        InterfaceFilter: {
          value: {
            interfaceId: HOLDING_INTERFACE,
            includeInterfaceView: true,
            includeCreatedEventBlob: true,
          },
        },
      },
    },
  ]);
}

export async function readContracts(session: CantonSession, d: Deployment) {
  const ids = (Object.keys(templates) as (keyof typeof templates)[]).map((k) =>
    templateId(d, k),
  );
  const response = await activeContracts(
    session,
    ids.map((id) => ({
      identifierFilter: {
        TemplateFilter: {
          value: { templateId: id, includeCreatedEventBlob: true },
        },
      },
    })),
  );
  const decoded = decodeContracts(response, d);
  const privateContracts = decoded.filter((c) =>
    ["AssetBalance", "PositionLot", "MultiLot", "LimitOrder"].includes(c.kind),
  );
  return session.partyId === d.operator
    ? privateContracts
    : privateContracts.filter((c) => c.data.owner === session.partyId);
}

/** Submits through CIP-0103 `prepareExecute` and waits for the matching
 * `txChanged: executed` event. */
export async function submit(
  session: CantonSession,
  d: Deployment,
  command: Command,
  disclosedContracts: {
    templateId: string;
    contractId: string;
    createdEventBlob: string;
    synchronizerId?: string;
  }[],
) {
  return executeWallet(
    session,
    d,
    command,
    disclosedContracts,
    () => readCantonSession(session.wallet),
    async (request) => ({
      tx: await executePrepared(await cantonProvider(session.wallet), request),
    }),
  );
}

/** Select only authenticated-wallet, unlocked Token Standard holdings. */
export async function depositInputs(
  session: CantonSession,
  d: Deployment,
  instrument: Record<string, unknown>,
  requested: string,
) {
  return selectInputs(
    await holdingContracts(session),
    session.partyId,
    instrument,
    requested,
  );
}
