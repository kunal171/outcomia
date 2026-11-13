import { cid, list, obj, raw, sameInstrument, text } from "./model.ts";
export function selectInputs(
  response: unknown,
  party: string,
  instrument: Record<string, unknown>,
  requested: string,
) {
  const rows = Array.isArray(response) ? response : list(obj(response).items),
    found: {
      id: string;
      amount: bigint;
      disclosure: {
        templateId: string;
        contractId: string;
        createdEventBlob: string;
      };
    }[] = [];
  for (const row of rows) {
    const entry = obj(obj(row).contractEntry ?? row),
      active = obj(entry.JsActiveContract ?? entry.activeContract ?? entry),
      e = obj(active.createdEvent);
    const views = list(e.interfaceViews);
    for (const item of views) {
      const v = obj(item);
      if (
        !String(v.interfaceId).endsWith(":Splice.Api.Token.HoldingV2:Holding")
      )
        continue;
      const data = obj(v.viewValue),
        account = obj(data.account);
      if (
        account.owner !== party ||
        account.provider !== null ||
        account.id !== "" ||
        data.lock !== null ||
        !sameInstrument(data.instrumentId, instrument)
      )
        continue;
      const value = raw(data.amount);
      if (value > BigInt(0))
        found.push({
          id: cid(e.contractId),
          amount: value,
          disclosure: {
            templateId: text(e.templateId),
            contractId: cid(e.contractId),
            createdEventBlob: text(e.createdEventBlob),
          },
        });
    }
  }
  found.sort((a, b) =>
    a.amount === b.amount ? 0 : a.amount > b.amount ? -1 : 1,
  );
  const selected: typeof found = [],
    seen = new Set<string>();
  let total = BigInt(0);
  for (const value of found) {
    if (seen.has(value.id)) throw new Error("Duplicate wallet holding.");
    seen.add(value.id);
    if (total >= raw(requested)) break;
    if (selected.length === 15) break;
    selected.push(value);
    total += value.amount;
  }
  if (!selected.length || total < raw(requested))
    throw new Error("Insufficient unlocked collateral in wallet.");
  return {
    inputs: selected.map((v) => v.id),
    disclosedContracts: selected.map((v) => v.disclosure),
  };
}
