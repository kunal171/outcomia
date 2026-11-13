"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useCantonWallet } from "../canton-wallet-provider";
import { buildPlan, type Intent } from "../../lib/canton/commands";
import {
  cid,
  disclosure,
  list,
  obj,
  text,
  type Catalog,
  type Contract,
} from "../../lib/canton/model";
import {
  depositInputs,
  readContracts,
  submit,
  verifyIdentity,
} from "../../lib/canton/transport";
import { walletError } from "../../lib/console-wallet";

type State = {
  loading: boolean;
  catalog: Catalog | null;
  owned: Contract[];
  error: string;
  busy: boolean;
  syncing: boolean;
  result: string;
};
const initial: State = {
  loading: true,
  catalog: null,
  owned: [],
  error: "",
  busy: false,
  syncing: false,
  result: "",
};
const Context = createContext<
  | (State & {
      refresh: () => Promise<unknown>;
      execute: (intent: Intent) => Promise<void>;
    })
  | null
>(null);
export function CantonTradingProvider({ children }: { children: ReactNode }) {
  const { state: wallet } = useCantonWallet(),
    session = wallet.session;
  const [state, setState] = useState<State>(initial),
    generation = useRef(0),
    submitting = useRef(false),
    mounted = useRef(true),
    consumed = useRef<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    setState((s) => ({ ...s, loading: true, error: "", owned: [] }));
    if (!session) return;
    try {
      const response = await fetch("/api/canton/catalog", {
        cache: "no-store",
      });
      if (!response.ok)
        throw new Error("Canton markets are temporarily unavailable.");
      const value = obj(await response.json());
      if (value.configured === false) {
        if (generation.current === current)
          setState((s) => ({ ...s, loading: false, catalog: null }));
        return;
      }
      const catalog = value as unknown as Catalog;
      if (catalog.deployment.network !== session.networkId)
        throw new Error("Deployment and wallet networks do not match.");
      const owned = await readContracts(session, catalog.deployment);
      if (generation.current === current && mounted.current) {
        const syncing =
          !!consumed.current &&
          [...catalog.contracts, ...owned].some(
            (c) => c.id === consumed.current,
          );
        if (!syncing) consumed.current = null;
        setState((s) => ({ ...s, loading: false, catalog, owned, syncing }));
      }
    } catch (e) {
      if (generation.current === current)
        setState((s) => ({
          ...s,
          loading: false,
          catalog: null,
          owned: [],
          error: walletError(e),
        }));
    }
  }, [session]);
  useEffect(() => {
    void refresh();
    return () => {
      ++generation.current;
    };
  }, [refresh]);
  const execute = useCallback(
    async (intent: Intent) => {
      if (
        !session ||
        !state.catalog ||
        !state.catalog.deployment.trading ||
        state.syncing ||
        state.loading
      )
        throw new Error("Canton transactions are not configured.");
      if (submitting.current)
        throw new Error("Another wallet approval is pending.");
      submitting.current = true;
      setState((s) => ({ ...s, busy: true, error: "", result: "" }));
      try {
        await verifyIdentity(session);
        const plan = buildPlan(
          session.partyId,
          state.catalog,
          state.owned,
          intent,
        );
        const all = new Map(
          [...state.catalog.contracts, ...state.owned].map((c) => [c.id, c]),
        );
        const disclosed = plan.dependencies.flatMap((id) => {
          const c = all.get(id);
          return c?.blob ? [disclosure(c)] : [];
        });
        if (intent.action === "deposit") {
          const selected = await depositInputs(
            session,
            state.catalog.deployment,
            obj(plan.instrument),
            text(intent.values?.amount),
          );
          plan.command.ExerciseCommand.choiceArgument.inputs = selected.inputs;
          disclosed.push(...selected.disclosedContracts);
        }
        if (plan.context) {
          const response = await fetch("/api/canton/context", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              party: session.partyId,
              action: intent.action,
              instrument: plan.instrument,
              contractIds: plan.dependencies,
              command: plan.command,
            }),
          });
          if (!response.ok)
            throw new Error("Current registry context is unavailable.");
          const context = obj(await response.json());
          if (
            context.party !== session.partyId ||
            context.network !== session.networkId
          )
            throw new Error("Registry context identity mismatch.");
          plan.command.ExerciseCommand.choiceArgument.extraArgs = obj(
            context.extraArgs,
          );

          disclosed.push(
            ...list(context.disclosedContracts).map((value) => {
              const c = obj(value);
              return {
                templateId: text(c.templateId),
                contractId: cid(c.contractId),
                createdEventBlob: text(c.createdEventBlob),
                ...(typeof c.synchronizerId === "string"
                  ? { synchronizerId: c.synchronizerId }
                  : {}),
              };
            }),
          );
        }
        const result = await submit(
          session,
          state.catalog.deployment,
          plan.command,
          [...new Map(disclosed.map((c) => [c.contractId, c])).values()],
        );
        if (mounted.current) {
          consumed.current = plan.command.ExerciseCommand.contractId;
          setState((s) => ({ ...s, result, syncing: true }));
          await refresh();
        }
      } catch (e) {
        if (mounted.current) setState((s) => ({ ...s, error: walletError(e) }));
        throw e;
      } finally {
        submitting.current = false;
        if (mounted.current) setState((s) => ({ ...s, busy: false }));
      }
    },
    [
      session,
      state.catalog,
      state.owned,
      state.syncing,
      state.loading,
      refresh,
    ],
  );
  return (
    <Context.Provider value={{ ...state, refresh, execute }}>
      {children}
    </Context.Provider>
  );
}
export function useCantonTrading() {
  const value = useContext(Context);
  if (!value) throw new Error("Canton trading provider missing.");
  return value;
}
