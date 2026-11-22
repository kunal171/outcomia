"use client";
import { useCantonWallet } from "../canton-wallet-provider";
import { useCantonTrading } from "./trading-provider";
import { ActionForm, TradingFrame, type Field } from "./trading-ui";
import { list, obj, text, type Contract } from "../../lib/canton/model";
import { mayCreate } from "../../lib/canton/commands";
import { useI18n } from "../preferences-provider";
export function CantonManage() {
  const s = useCantonTrading(),
    { state: wallet } = useCantonWallet(),
    { t } = useI18n(),
    policy = s.catalog?.contracts.find((c) => c.kind === "Protocol"),
    party = wallet.session?.partyId;
  const admin =
      Array.isArray(policy?.data.admins) && policy.data.admins.includes(party),
    assets =
      s.catalog?.contracts.filter((c) => c.kind === "AssetAdmission") ?? [],
    // Club factories are managed on their club pages.
    factories =
      s.catalog?.contracts.filter(
        (c) =>
          c.kind === "OutcomiaMarketFactory" &&
          obj(c.data.policy).tag !== "ByPolicy",
      ) ?? [];
  const fields: Field[] = [
    { name: "question", label: "Question", type: "textarea" },
    {
      name: "asset",
      label: "Collateral",
      options: assets.map((c) => ({
        value: c.id,
        label: text(obj(c.data.instrument).id),
      })),
    },
    { name: "yesCriteria", label: "YES criteria", type: "textarea" },
    { name: "noCriteria", label: "NO criteria", type: "textarea" },
    { name: "invalidCriteria", label: "Invalid criteria", type: "textarea" },
    {
      name: "evidenceRequirements",
      label: "Evidence required",
      type: "textarea",
    },
    { name: "documentUri", label: "Rules URL", type: "url" },
    { name: "documentSha256", label: "SHA-256" },
    { name: "closeAt", label: "Closes", type: "datetime-local" },
    {
      name: "earliestResolutionAt",
      label: "Earliest resolution",
      type: "datetime-local",
      optional: true,
    },
    { name: "resolver", label: "Fallback resolver", optional: true },
    {
      name: "availableAt",
      label: "Fallback available",
      type: "datetime-local",
      optional: true,
    },
    {
      name: "deadlineAt",
      label: "Fallback deadline",
      type: "datetime-local",
      optional: true,
    },
    {
      name: "resolutionDelaySeconds",
      label: "Review delay (seconds)",
      value: "3600",
    },
    { name: "priceTick", label: "Price increment", value: "0.01" },
    { name: "quantityLot", label: "Contract lot", value: "1" },
  ];
  const at = (v: string) => new Date(v).toISOString();
  return (
    <TradingFrame title="Manage markets">
      {admin && policy ? (
        <>
          <section className="canton-panel">
            <h2>{t("Create market")}</h2>
            <ActionForm
              label="Create draft"
              fields={fields}
              build={(v) => {
                const asset = assets.find((c) => c.id === v.asset);
                if (!asset)
                  throw new Error("Choose an admitted collateral asset.");
                return {
                  action: "create",
                  target: policy.id,
                  values: {
                    terms: {
                      question: v.question,
                      collateral: asset.data.instrument,
                      rules: {
                        yesCriteria: v.yesCriteria,
                        noCriteria: v.noCriteria,
                        invalidCriteria: v.invalidCriteria,
                        evidenceRequirements: v.evidenceRequirements,
                        documentUri: v.documentUri,
                        documentSha256: v.documentSha256,
                      },
                      closeAt: at(v.closeAt),
                      earliestResolutionAt: v.earliestResolutionAt
                        ? at(v.earliestResolutionAt)
                        : null,
                      fallback: v.resolver
                        ? {
                            resolver: v.resolver,
                            availableAt: at(v.availableAt),
                            deadlineAt: v.deadlineAt ? at(v.deadlineAt) : null,
                          }
                        : null,
                      resolutionDelaySeconds: v.resolutionDelaySeconds,
                      priceTick: v.priceTick,
                      quantityLot: v.quantityLot,
                    },
                  },
                };
              }}
            />
          </section>
          {party === s.catalog?.deployment.operator ? (
            <div className="canton-grid">
              <section className="canton-panel">
                <h2>{t("Taker fee")}</h2>
                <ActionForm
                  label="Update fee"
                  fields={[
                    {
                      name: "amount",
                      label: "Basis points",
                      value: text(policy.data.takerFeeBps),
                    },
                  ]}
                  build={(v) => ({
                    action: "setFee",
                    target: policy.id,
                    values: v,
                  })}
                />
              </section>
              <section className="canton-panel">
                <h2>{t("Administrators")}</h2>
                <ActionForm
                  label="Update administrators"
                  fields={[
                    {
                      name: "admins",
                      label: "Wallet parties",
                      type: "textarea",
                      value: (policy.data.admins as string[]).join("\n"),
                    },
                  ]}
                  build={(v) => ({
                    action: "setAdmins",
                    target: policy.id,
                    values: {
                      admins: v.admins.split(/[\s,]+/).filter(Boolean),
                    },
                  })}
                />
              </section>
            </div>
          ) : null}
        </>
      ) : null}
      {factories.length ? (
        factories.map((factory) => (
          <FactoryManage key={factory.id} factory={factory} party={party} />
        ))
      ) : !admin ? (
        <p>{t("Active administrator required.")}</p>
      ) : null}
    </TradingFrame>
  );
}

const policyLabels: Record<string, string> = {
  AdminsOnly: "Factory admins only",
  Allowlist: "Listed creators",
  AnyParty: "Anyone",
};

/** Market creation and invite lists for one factory instance. The ledger
 * enforces the creation policy, collateral and eligibility; these forms only
 * preflight them. */
function FactoryManage({
  factory,
  party,
}: {
  factory: Contract;
  party?: string;
}) {
  const s = useCantonTrading(),
    { t } = useI18n(),
    policy = obj(factory.data.policy),
    ref = obj(factory.data.ref),
    lists = s.owned.filter(
      (c) => c.kind === "InviteListPolicy" && c.data.manager === party,
    );
  return (
    <section className="canton-panel">
      <h2>
        {t("Factory")}: {text(ref.factoryId)}
      </h2>
      <p>
        {t("Who can create")}: {t(policyLabels[text(policy.tag)] ?? "Unknown")}
      </p>
      <FactoryMarketForm
        factory={factory}
        disabled={!party || !mayCreate(factory.data.policy, party)}
        access={[
          { value: "public", label: "Anyone" },
          ...lists.map((c) => ({
            value: c.id,
            label: `${t("Invite list")} ${text(obj(c.data.ref).policyId)}`,
          })),
        ]}
      />
      <h3>{t("Invite lists")}</h3>
      <ActionForm
        label="Create invite list"
        fields={[
          { name: "parties", label: "Wallet parties", type: "textarea" },
        ]}
        disabled={!party || !mayCreate(factory.data.policy, party)}
        build={(v) => ({
          action: "createInviteList",
          target: factory.id,
          values: { parties: v.parties.split(/[\s,]+/).filter(Boolean) },
        })}
      />
      {lists.map((c) => (
        <ActionForm
          key={c.id}
          label="Update invite list"
          fields={[
            {
              name: "parties",
              label: text(obj(c.data.ref).policyId),
              type: "textarea",
              value: list(c.data.parties).map(text).join("\n"),
            },
          ]}
          build={(v) => ({
            action: "setInvites",
            target: c.id,
            values: { parties: v.parties.split(/[\s,]+/).filter(Boolean) },
          })}
        />
      ))}
    </section>
  );
}

/** Market creation through one factory instance. `access` values are
 * "public", "club" (members-only club market) or an invite list's ID. */
export function FactoryMarketForm({
  factory,
  access,
  disabled = false,
}: {
  factory: Contract;
  access: { value: string; label: string }[];
  disabled?: boolean;
}) {
  const assets = list(factory.data.assets).map((a) => obj(obj(a).instrument));
  const at = (v: string) => new Date(v).toISOString();
  return (
    <ActionForm
      label="Create market"
      fields={[
        { name: "question", label: "Question", type: "textarea" },
        {
          name: "asset",
          label: "Collateral",
          options: assets.map((a, i) => ({
            value: String(i),
            label: text(a.id),
          })),
        },
        { name: "yesCriteria", label: "YES criteria", type: "textarea" },
        { name: "noCriteria", label: "NO criteria", type: "textarea" },
        {
          name: "invalidCriteria",
          label: "Invalid criteria",
          type: "textarea",
        },
        {
          name: "evidenceRequirements",
          label: "Evidence required",
          type: "textarea",
        },
        { name: "documentUri", label: "Rules URL", type: "url" },
        { name: "documentSha256", label: "SHA-256" },
        { name: "closeAt", label: "Closes", type: "datetime-local" },
        {
          name: "earliestResolutionAt",
          label: "Earliest resolution",
          type: "datetime-local",
          optional: true,
        },
        {
          name: "resolutionDelaySeconds",
          label: "Review delay (seconds)",
          value: "3600",
        },
        { name: "priceTick", label: "Price increment", value: "0.01" },
        { name: "quantityLot", label: "Contract lot", value: "1" },
        { name: "access", label: "Who can trade", options: access },
      ]}
      disabled={disabled}
      build={(v) => ({
        action: "factoryCreate",
        target: factory.id,
        values: {
          access:
            v.access === "public"
              ? "public"
              : v.access === "club"
                ? "club"
                : "invite",
          policy: v.access,
          terms: {
            question: v.question,
            outcomes: ["YES", "NO"],
            outcomeCriteria: [v.yesCriteria, v.noCriteria],
            invalidCriteria: v.invalidCriteria,
            evidenceRequirements: v.evidenceRequirements,
            rulesUri: v.documentUri,
            rulesHash: v.documentSha256,
            collateral: assets[Number(v.asset)],
            closeAt: at(v.closeAt),
            earliestResolutionAt: v.earliestResolutionAt
              ? at(v.earliestResolutionAt)
              : null,
            resolutionDelaySeconds: v.resolutionDelaySeconds,
            priceTick: v.priceTick,
            quantityLot: v.quantityLot,
          },
        },
      })}
    />
  );
}
