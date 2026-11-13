"use client";
import { useCantonWallet } from "../canton-wallet-provider";
import { useCantonTrading } from "./trading-provider";
import { ActionForm, TradingFrame, type Field } from "./trading-ui";
import { obj, text } from "../../lib/canton/model";
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
      s.catalog?.contracts.filter((c) => c.kind === "AssetAdmission") ?? [];
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
      ) : (
        <p>{t("Active administrator required.")}</p>
      )}
    </TradingFrame>
  );
}
