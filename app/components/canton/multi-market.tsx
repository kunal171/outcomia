"use client";
/** Multi-outcome Canton market (2–8 named outcomes): complete sets, admin
 * resolution and redemption. The per-outcome order book arrives with MO2
 * (outcomia-canton docs/multi-outcome-markets.md). */
import Link from "next/link";
import { useI18n } from "../preferences-provider";
import { useCantonWallet } from "../canton-wallet-provider";
import { useCantonTrading } from "./trading-provider";
import {
  ActionButton,
  ActionForm,
  TradingFrame,
  issuingFactory,
} from "./trading-ui";
import {
  finalRecord,
  list,
  marketKey,
  multiResult,
  obj,
  sameMarket,
  text,
  type Contract,
} from "../../lib/canton/model";
import { lotTotals, multiClaim } from "../../lib/canton/multi";

export function MultiMarketDetail({ current }: { current: Contract }) {
  const s = useCantonTrading(),
    { state: wallet } = useCantonWallet(),
    { t } = useI18n();
  const data = finalRecord(current),
    terms = obj(data.terms),
    key = marketKey(data),
    outcomes = list(terms.outcomes).map(text),
    criteria = list(terms.outcomeCriteria).map(text),
    contracts = s.catalog?.contracts.filter((c) => sameMarket(c, key)) ?? [],
    reserve = contracts.find((c) => c.kind === "MultiReserve"),
    settled = contracts.find((c) => c.kind === "MultiSettledReserve"),
    party = wallet.session?.partyId,
    operator = party === s.catalog?.deployment.operator,
    factory = issuingFactory(s.catalog?.contracts ?? [], data),
    factoryAdmin =
      !!party &&
      !!factory &&
      Array.isArray(factory.data.admins) &&
      factory.data.admins.includes(party);
  const result =
    current.kind === "MultiMarket" ? null : multiResult(data.result);
  const lots = s.owned.filter(
    (c) =>
      c.kind === "MultiLot" && c.data.owner === party && sameMarket(c, key),
  );
  const totals = lotTotals(lots, outcomes.length);
  const held = totals.some((c) => c > BigInt(0));
  const open =
    current.kind === "MultiMarket" &&
    data.status === "Open" &&
    Date.now() < Date.parse(text(terms.closeAt));
  const resolvable =
    current.kind === "MultiMarket" &&
    Date.now() >= Date.parse(text(terms.earliestResolutionAt ?? terms.closeAt));
  const status =
    current.kind === "MultiFinal"
      ? "Finalized"
      : current.kind === "MultiProposal"
        ? "Review period"
        : String(data.status);
  return (
    <TradingFrame
      title={text(terms.question)}
      tools={<Link href="/canton/markets">{t("All markets")}</Link>}
    >
      <div className="canton-market-meta">
        <span>{t(status)}</span>
        <span>{text(obj(terms.collateral).id)}</span>
        <span>
          {t("{value0} outcomes", { value0: String(outcomes.length) })}
        </span>
        {result ? (
          <strong>
            {result.winner === null ? t("Invalid") : outcomes[result.winner]}
          </strong>
        ) : null}
      </div>

      <section className="canton-panel">
        <h2>{t("Outcomes")}</h2>
        <table>
          <thead>
            <tr>
              {["Outcome", "Wins when", "You hold"].map((k) => (
                <th key={k}>{t(k)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {outcomes.map((label, i) => (
              <tr
                key={label}
                aria-current={result?.winner === i ? "true" : undefined}
              >
                <td>
                  <strong>{label}</strong>
                  {result?.winner === i ? ` · ${t("Winner")}` : ""}
                </td>
                <td>{criteria[i]}</td>
                <td className="ui-num">{totals[i].toString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="club-help">
          {t(
            "One complete set costs 1 {value0} and holds one contract of every outcome. The winning contract pays 1; if the market is invalid, every contract pays an equal share.",
            { value0: text(obj(terms.collateral).id) },
          )}
        </p>
      </section>

      {reserve && open ? (
        <section className="canton-panel">
          <h2>{t("Complete sets")}</h2>
          <ActionForm
            label="Mint complete sets"
            fields={[
              {
                name: "quantity",
                label: "Sets",
                value: text(terms.quantityLot),
              },
            ]}
            build={(v) => ({
              action: "multiSplit",
              target: reserve.id,
              values: v,
            })}
          />
        </section>
      ) : null}
      {reserve && held ? (
        <section className="canton-panel">
          <ActionForm
            label="Return complete sets"
            fields={[
              {
                name: "quantity",
                label: "Sets",
                value: totals
                  .reduce((m, c) => (c < m ? c : m), totals[0])
                  .toString(),
              },
            ]}
            build={(v) => ({
              action: "multiMerge",
              target: reserve.id,
              values: v,
            })}
          />
        </section>
      ) : null}
      {settled && held && result ? (
        <section className="canton-panel">
          <h2>{t("Claim")}</h2>
          <p className="ui-num">
            {t("You receive {value0}", {
              value0: `${multiClaim(totals, result.winner)} ${text(obj(terms.collateral).id)}`,
            })}
          </p>
          <ActionButton
            label="Redeem"
            intent={{ action: "multiRedeem", target: settled.id }}
          />
        </section>
      ) : null}

      {factoryAdmin && current.kind === "MultiMarket" ? (
        <section className="canton-panel">
          <h2>{t("Manage")}</h2>
          {data.status === "Open" ? (
            <ActionForm
              label="Close market"
              fields={[{ name: "reason", label: "Reason" }]}
              build={(v) => ({
                action: "multiClose",
                target: current.id,
                values: v,
              })}
            />
          ) : null}
          {resolvable ? (
            <MultiResolutionForm
              action="multiPropose"
              target={current.id}
              outcomes={outcomes}
            />
          ) : (
            <p>{t("Resolution opens at the earliest resolution time.")}</p>
          )}
        </section>
      ) : null}
      {current.kind === "MultiProposal" ? (
        <section className="canton-panel">
          <p>
            {t("Review ends")}: {text(data.finalizableAt)}
          </p>
          {factoryAdmin && Date.now() < Date.parse(text(data.finalizableAt)) ? (
            <MultiResolutionForm
              action="multiCorrect"
              target={current.id}
              outcomes={outcomes}
            />
          ) : null}
          {operator && Date.now() >= Date.parse(text(data.finalizableAt)) ? (
            <ActionButton
              label="Finalize result"
              intent={{ action: "multiFinalize", target: current.id }}
            />
          ) : null}
        </section>
      ) : null}
      {operator && current.kind === "MultiFinal" && reserve ? (
        <ActionButton
          label="Prepare claims"
          intent={{ action: "multiBind", target: reserve.id }}
        />
      ) : null}

      <section className="canton-panel">
        <h2>{t("Rules")}</h2>
        <dl>
          <dt>{t("Invalid criteria")}</dt>
          <dd>{text(terms.invalidCriteria)}</dd>
          <dt>{t("Evidence required")}</dt>
          <dd>{text(terms.evidenceRequirements)}</dd>
          <dt>{t("Rules URL")}</dt>
          <dd>{text(terms.documentUri)}</dd>
          <dt>{t("SHA-256")}</dt>
          <dd className="ui-num">{text(terms.documentSha256)}</dd>
          <dt>{t("Closes")}</dt>
          <dd>{text(terms.closeAt)}</dd>
          <dt>{t("Review delay (seconds)")}</dt>
          <dd>{text(terms.resolutionDelaySeconds)}</dd>
          <dt>{t("Contract lot")}</dt>
          <dd>{text(terms.quantityLot)}</dd>
        </dl>
        <p className="club-help">
          {t("Trading individual outcomes on an order book is coming next.")}
        </p>
      </section>
    </TradingFrame>
  );
}

function MultiResolutionForm({
  action,
  target,
  outcomes,
}: {
  action: "multiPropose" | "multiCorrect";
  target: string;
  outcomes: string[];
}) {
  return (
    <ActionForm
      label={action === "multiCorrect" ? "Correct result" : "Propose result"}
      fields={[
        {
          name: "result",
          label: "Outcome",
          options: [
            ...outcomes.map((label, i) => ({ value: String(i), label })),
            { value: "invalid", label: "Invalid" },
          ],
        },
        { name: "summary", label: "Evidence", type: "textarea" },
        { name: "documentUri", label: "Evidence URL", type: "url" },
        { name: "documentSha256", label: "SHA-256" },
      ]}
      build={(v) => ({
        action,
        target,
        values: {
          result: v.result,
          evidence: {
            summary: v.summary,
            documentUri: v.documentUri,
            documentSha256: v.documentSha256,
          },
        },
      })}
    />
  );
}
