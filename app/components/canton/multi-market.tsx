"use client";
/** Multi-outcome Canton market (2–8 named outcomes): per-outcome order books,
 * complete sets, admin resolution and redemption
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
import { lotTotals, multiClaim, outcomeQuotes } from "../../lib/canton/multi";
import { accessPolicy, excludedBy } from "../../lib/canton/commands";

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
    book = contracts.find((c) => c.kind === "MultiBook"),
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
  const quotes = (s.catalog?.quotes ?? []).filter((q) => q.market === key);
  const fills = (s.catalog?.fills ?? []).filter((f) => f.market === key);
  const prices = outcomeQuotes(outcomes.length, quotes, fills);
  const mine = s.owned.filter(
    (c) =>
      c.kind === "MultiOrder" && c.data.owner === party && sameMarket(c, key),
  );
  // Resting orders whose owners lost access cannot fill; the operator clears them.
  const departed = (() => {
    if (!operator || !book) return [];
    try {
      const access = accessPolicy(
        [...(s.catalog?.contracts ?? []), ...s.owned],
        current,
      );
      if (!access) return [];
      const open = new Set(
        list(book.data.orders).map((r) => text(obj(r).order)),
      );
      return s.owned.filter(
        (c) =>
          c.kind === "MultiOrder" &&
          open.has(c.id) &&
          excludedBy(access, text(c.data.owner)),
      );
    } catch {
      return [];
    }
  })();
  const outcomeOptions = outcomes.map((label, i) => ({
    value: String(i),
    label,
  }));
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
              {["Outcome", "Wins when", "Bid", "Ask", "Last", "You hold"].map(
                (k) => (
                  <th key={k}>{t(k)}</th>
                ),
              )}
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
                <td className="ui-num">
                  {prices[i].bid ?? "–"}
                  {prices[i].impliedBid ? (
                    <small title={t("Through a full set")}>
                      {" "}
                      ({t("set")} {prices[i].impliedBid})
                    </small>
                  ) : null}
                </td>
                <td className="ui-num">
                  {prices[i].ask ?? "–"}
                  {prices[i].impliedAsk ? (
                    <small title={t("Through a full set")}>
                      {" "}
                      ({t("set")} {prices[i].impliedAsk})
                    </small>
                  ) : null}
                </td>
                <td className="ui-num">{prices[i].last ?? "–"}</td>
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

      {book ? (
        <section className="canton-book">
          <h2>{t("Order book")}</h2>
          <table>
            <thead>
              <tr>
                {["Outcome", "Side", "Price", "Quantity"].map((k) => (
                  <th key={k}>{t(k)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...quotes]
                .sort(
                  (a, b) =>
                    Number(a.outcome) - Number(b.outcome) ||
                    a.side.localeCompare(b.side) ||
                    Number(b.price) - Number(a.price),
                )
                .map((q) => (
                  <tr key={q.orderId}>
                    <td>{outcomes[Number(q.outcome)] ?? q.outcome}</td>
                    <td>{t(q.side)}</td>
                    <td className="ui-num">{q.price}</td>
                    <td className="ui-num">{q.quantity}</td>
                  </tr>
                ))}
            </tbody>
          </table>
          {!quotes.length ? <p>{t("No open orders.")}</p> : null}
        </section>
      ) : null}
      {book && open ? (
        <section className="canton-panel">
          <h2>{t("Trade")}</h2>
          <ActionForm
            label="Place order"
            fields={[
              { name: "outcome", label: "Outcome", options: outcomeOptions },
              {
                name: "side",
                label: "Side",
                options: [
                  { value: "multiBuy", label: "Buy" },
                  { value: "multiSell", label: "Sell" },
                ],
              },
              { name: "price", label: "Price", value: text(terms.priceTick) },
              {
                name: "quantity",
                label: "Quantity",
                value: text(terms.quantityLot),
              },
            ]}
            build={(v) => ({
              action: v.side === "multiSell" ? "multiSell" : "multiBuy",
              target: book.id,
              values: {
                outcome: v.outcome,
                price: v.price,
                quantity: v.quantity,
              },
            })}
          />
        </section>
      ) : null}
      {mine.length ? (
        <section className="canton-panel">
          <h2>{t("Your orders")}</h2>
          <ul>
            {mine.map((o) => (
              <li key={o.id}>
                <span className="ui-num">
                  {t(text(o.data.side))}{" "}
                  {outcomes[Number(o.data.outcome)] ?? text(o.data.outcome)}{" "}
                  {text(o.data.quantity)} @ {text(o.data.price)}
                </span>
                <ActionButton
                  label="Cancel"
                  intent={{ action: "multiCancel", target: o.id }}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {operator && book ? (
        <section className="canton-panel">
          {open ? (
            <ActionForm
              label="Match next"
              fields={[
                { name: "outcome", label: "Outcome", options: outcomeOptions },
              ]}
              build={(v) => ({
                action: "multiMatch",
                target: book.id,
                values: v,
              })}
            />
          ) : null}
          {open && reserve ? (
            <ActionForm
              label="Match full set"
              fields={[
                {
                  name: "side",
                  label: "Side",
                  options: [
                    { value: "Buy", label: "Bids of every outcome: mint sets" },
                    {
                      value: "Sell",
                      label: "Asks of every outcome: merge sets",
                    },
                  ],
                },
              ]}
              build={(v) => ({
                action: "multiMatchFullSet",
                target: book.id,
                values: v,
              })}
            />
          ) : null}
          {departed.length ? (
            <div className="canton-departed">
              <h3>{t("Orders from departed members")}</h3>
              <ul>
                {departed.map((o) => (
                  <li key={o.id}>
                    <span className="ui-num">
                      {t(text(o.data.side))} {outcomes[Number(o.data.outcome)]}{" "}
                      {text(o.data.quantity)} @ {text(o.data.price)}
                    </span>
                    <ActionButton
                      label="Clear order"
                      intent={{ action: "multiClearDeparted", target: o.id }}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <p>
            {t("Earned fees")}: {text(obj(book.data.fees).amount)}
          </p>
          <ActionForm
            label="Withdraw fees"
            fields={[{ name: "amount", label: "Amount" }]}
            build={(v) => ({
              action: "multiWithdrawFees",
              target: book.id,
              values: v,
            })}
          />
        </section>
      ) : null}
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

      {fills.length ? (
        <section className="canton-panel">
          <h2>{t("Recent activity")}</h2>
          <table>
            <thead>
              <tr>
                {["Time", "Trade", "Price", "Quantity"].map((k) => (
                  <th key={k}>{t(k)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {fills.slice(0, 20).map((f, i) => (
                <tr key={`${f.executedAt}-${i}`}>
                  <td>{new Date(f.executedAt).toLocaleString()}</td>
                  <td>
                    {f.kind === "trade"
                      ? (outcomes[Number(f.outcome)] ?? f.outcome)
                      : t(
                          f.side === "Sell"
                            ? "Full sets merged"
                            : "Full sets minted",
                        )}
                  </td>
                  <td className="ui-num">{f.price ?? "–"}</td>
                  <td className="ui-num">{f.quantity}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
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
