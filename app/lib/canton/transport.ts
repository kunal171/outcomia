import { executeWallet, assertIdentity } from "./wallet-flow.ts";
import { selectInputs } from "./holdings.ts";
import type { CantonSession } from "../canton-session";
import type { Command } from "./commands";
import {
  decodeContracts,
  list,
  obj,
  templateId,
  templates,
  text,
  type Deployment,
} from "./model.ts";
import { walletNetworks } from "../canton-display";
import { loadLoopWallet, readLoopSession } from "../loop-wallet";
import { loadWallet, readSession } from "../console-wallet";

/** Reverify before AND after every wallet await. Identity swaps never attach old
 * private reads or transaction success to the newly connected wallet. SDK-owned
 * credentials never cross this adapter. No operator/vault readAs is requested. */
export async function verifyIdentity(session: CantonSession) {
  const current =
    session.wallet === "loop"
      ? await readLoopSession()
      : await readSession(await loadWallet());
  assertIdentity(session, current);
}
export async function readContracts(session: CantonSession, d: Deployment) {
  await verifyIdentity(session);
  let response: unknown;
  const ids = (Object.keys(templates) as (keyof typeof templates)[]).map((k) =>
    templateId(d, k),
  );
  if (session.wallet === "loop") {
    const { provider } = await loadLoopWallet();
    const end = obj(
      await provider.request({
        method: "ledgerApi",
        params: { requestMethod: "get", resource: "/v2/state/ledger-end" },
      }),
    );
    if (!/^\d+$/.test(String(end.offset)))
      throw new Error("Invalid wallet ledger offset.");
    response = await provider.request({
      method: "ledgerApi",
      params: {
        requestMethod: "post",
        resource: "/v2/state/active-contracts",
        body: {
          eventFormat: {
            filtersByParty: {
              [session.partyId]: {
                cumulative: ids.map((id) => ({
                  identifierFilter: {
                    TemplateFilter: {
                      value: { templateId: id, includeCreatedEventBlob: true },
                    },
                  },
                })),
              },
            },
            verbose: true,
          },
          activeAtOffset: end.offset,
        },
      },
    });
  } else {
    const sdk = await import("@console-wallet/dapp-sdk");
    response = await (
      await loadWallet()
    ).getContracts({
      parties: [session.partyId],
      templateIds: ids,
      network: sdk.CANTON_NETWORK_VARIANTS[walletNetworks[session.networkId]],
    });
  }
  await verifyIdentity(session);
  const decoded = decodeContracts(response, d);
  const privateContracts = decoded.filter((c) =>
    ["AssetBalance", "PositionLot", "LimitOrder"].includes(c.kind),
  );
  return session.partyId === d.operator
    ? privateContracts
    : privateContracts.filter((c) => c.data.owner === session.partyId);
}
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
    () =>
      session.wallet === "loop"
        ? readLoopSession()
        : loadWallet().then(readSession),
    async (request) =>
      session.wallet === "loop"
        ? (await loadLoopWallet()).provider.request({
            method: "prepareExecuteAndWait",
            params: request,
          })
        : (await loadWallet()).prepareExecuteAndWait(request),
  );
}

/** Select only authenticated-wallet, unlocked Token Standard holdings. Console's
 * ledger-auth token is used transiently inside this call, never cached, logged,
 * returned to React or forwarded to the application server. */
export async function depositInputs(
  session: CantonSession,
  d: Deployment,
  instrument: Record<string, unknown>,
  requested: string,
) {
  await verifyIdentity(session);
  let request: (
    resource: string,
    body?: Record<string, unknown>,
  ) => Promise<unknown>;
  if (session.wallet === "loop") {
    const { provider } = await loadLoopWallet();
    request = (resource, body) =>
      provider.request({
        method: "ledgerApi",
        params: {
          requestMethod: body ? "post" : "get",
          resource,
          ...(body ? { body } : {}),
        },
      });
  } else {
    const sdk = await import("@console-wallet/dapp-sdk"),
      wallet = await loadWallet(),
      account = await wallet.getPrimaryAccount();
    if (!account || account.partyId !== session.partyId)
      throw new Error("Wallet changed. Refresh.");
    const network =
      sdk.CANTON_NETWORK_VARIANTS[walletNetworks[session.networkId]];
    const auth = await wallet.ledgerAuth({
      publicKey: account.publicKey,
      partyId: session.partyId,
      network,
    });
    await verifyIdentity(session);
    request = async (resource, body) => {
      const result = await wallet.ledgerApi({
        accessToken: auth.accessToken,
        network,
        resource,
        requestMethod: body ? "POST" : "GET",
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return JSON.parse(result.response) as unknown;
    };
  }
  const end = obj(await request("/v2/state/ledger-end"));
  if (!/^\d+$/.test(String(end.offset)))
    throw new Error("Invalid wallet ledger offset.");
  const response = await request("/v2/state/active-contracts", {
    eventFormat: {
      filtersByParty: {
        [session.partyId]: {
          cumulative: [
            {
              identifierFilter: {
                InterfaceFilter: {
                  value: {
                    interfaceId:
                      "#splice-api-token-holding-v2:Splice.Api.Token.HoldingV2:Holding",
                    includeInterfaceView: true,
                    includeCreatedEventBlob: true,
                  },
                },
              },
            },
          ],
        },
      },
      verbose: true,
    },
    activeAtOffset: end.offset,
  });
  await verifyIdentity(session);
  return selectInputs(response, session.partyId, instrument, requested);
}
