"use client";
import Link from "next/link";
import { useId, useState, type ReactNode } from "react";
import { useI18n } from "../preferences-provider";
import { useCantonWallet } from "../canton-wallet-provider";
import { useCantonTrading } from "./trading-provider";
import { CantonDeploymentNotice, CantonPageHeading } from "./workspace";
import {
  amount,
  integer,
  marketKey,
  obj,
  orderQuote,
  raw,
  resolverEligible,
  sameMarket,
  text,
  type Contract,
  type RecordValue,
} from "../../lib/canton/model";
import type { Intent } from "../../lib/canton/commands";
import { walletError } from "../../lib/console-wallet";

export function TradingFrame({
  title,
  children,
  tools,
}: {
  title: string;
  children: ReactNode;
  tools?: ReactNode;
}) {
  const s = useCantonTrading(),
    { t } = useI18n();
  return (
    <>
      <CantonPageHeading title={title}>
        <div className="canton-toolbar">
          {tools}
          <button
            type="button"
            className="canton-refresh"
            onClick={() => void s.refresh()}
            disabled={s.loading || s.busy}
          >
            {t("Refresh")}
          </button>
        </div>
      </CantonPageHeading>
      {s.error ? (
        <p className="canton-message" role="alert">
          {s.error}
        </p>
      ) : null}
      {s.result ? (
        <p className="canton-message" role="status">
          {t("Transaction confirmed")}: <code>{s.result}</code>
        </p>
      ) : null}
      {s.syncing ? (
        <p className="canton-message" role="status">
          {t("Transaction confirmed. Refresh to synchronize the ledger view.")}
        </p>
      ) : null}
      {s.loading ? (
        <p role="status">{t("Loading")}</p>
      ) : !s.catalog ? (
        s.error ? null : (
          <CantonDeploymentNotice />
        )
      ) : (
        <>
          {!s.catalog.deployment.trading ? (
            <p className="canton-message">
              {t("Transactions disabled until deployment verification.")}
            </p>
          ) : null}
          {children}
        </>
      )}
    </>
  );
}
export function ActionButton({
  label,
  intent,
}: {
  label: string;
  intent: Intent;
}) {
  const s = useCantonTrading(),
    { t } = useI18n();
  return (
    <button
      className="canton-action"
      type="button"
      disabled={
        s.busy || s.loading || s.syncing || !s.catalog?.deployment.trading
      }
      onClick={() => void s.execute(intent).catch(() => {})}
    >
      {t(label)}
    </button>
  );
}
export type Field = {
  name: string;
  label: string;
  type?: string;
  value?: string;
  optional?: boolean;
  options?: { value: string; label: string }[];
};
export function ActionForm({
  label,
  fields,
  build,
}: {
  label: string;
  fields: Field[];
  build: (values: Record<string, string>) => Intent;
}) {
  const s = useCantonTrading(),
    { t } = useI18n(),
    id = useId(),
    [error, setError] = useState("");
  return (
    <form
      className="canton-form"
      onSubmit={async (e) => {
        e.preventDefault();
        const values = Object.fromEntries(
          new FormData(e.currentTarget),
        ) as Record<string, string>;
        setError("");
        try {
          await s.execute(build(values));
        } catch (e) {
          setError(walletError(e));
        }
      }}
    >
      <fieldset
        disabled={
          s.busy || s.loading || s.syncing || !s.catalog?.deployment.trading
        }
      >
        {fields.map((f) => (
          <label key={f.name} htmlFor={`${id}-${f.name}`}>
            {t(f.label)}
            {f.options ? (
              <select
                id={`${id}-${f.name}`}
                name={f.name}
                defaultValue={f.value}
                required={!f.optional}
              >
                {f.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {t(o.label)}
                  </option>
                ))}
              </select>
            ) : f.type === "textarea" ? (
              <textarea
                id={`${id}-${f.name}`}
                name={f.name}
                defaultValue={f.value}
                required={!f.optional}
                rows={3}
              />
            ) : (
              <input
                id={`${id}-${f.name}`}
                name={f.name}
                type={f.type ?? "text"}
                defaultValue={f.value}
                required={!f.optional}
                autoComplete="off"
              />
            )}
          </label>
        ))}
        <button className="canton-action" type="submit">
          {t(s.busy ? "Awaiting wallet approval" : label)}
        </button>
      </fieldset>
      {error ? <p role="alert">{error}</p> : null}
    </form>
  );
}
export function marketRecord(c: Contract): RecordValue {
  return c.kind === "FinalResolution" ? obj(c.data.proposal) : c.data;
}
export function marketRecords(contracts: Contract[]) {
  const result = new Map<string, Contract>();
  for (const kind of ["BinaryMarket", "ResolutionProposal", "FinalResolution"])
    for (const c of contracts.filter((c) => c.kind === kind))
      result.set(marketKey(marketRecord(c)), c);
  return [...result.values()];
}
export function marketLabel(contracts: Contract[], key: string) {
  const market = marketRecords(contracts).find(
    (c) => marketKey(marketRecord(c)) === key,
  );
  return market ? text(obj(marketRecord(market).terms).question) : "Market";
}
export function marketLink(c: Contract) {
  return `/canton/markets/${text(obj(marketRecord(c).key ?? marketRecord(c)).marketId)}`;
}
export function MarketList() {
  const s = useCantonTrading(),
    { state: wallet } = useCantonWallet(),
    { t } = useI18n();
  const admin = s.catalog?.contracts.find((c) => c.kind === "Protocol")?.data
    .admins;
  const canManage =
    Array.isArray(admin) && admin.includes(wallet.session?.partyId);
  return (
    <TradingFrame
      title="Predictions"
      tools={
        canManage ? (
          <Link href="/canton/manage">{t("Manage markets")}</Link>
        ) : null
      }
    >
      <div className="canton-market-list">
        {marketRecords(s.catalog?.contracts ?? []).map((c) => {
          const data = marketRecord(c),
            terms = obj(data.terms);
          return (
            <Link className="canton-market-row" href={marketLink(c)} key={c.id}>
              <h2>{text(terms.question)}</h2>
              <span>
                {t(
                  c.kind === "FinalResolution"
                    ? "Finalized"
                    : c.kind === "ResolutionProposal"
                      ? "Review period"
                      : String(data.status),
                )}{" "}
                · {text(obj(terms.collateral).id)}
              </span>
            </Link>
          );
        })}
        {s.catalog && !marketRecords(s.catalog.contracts).length ? (
          <p>{t("No markets yet.")}</p>
        ) : null}
      </div>
    </TradingFrame>
  );
}
export function OrdersList() {
  const s = useCantonTrading(),
    { state: wallet } = useCantonWallet(),
    { t } = useI18n();
  const orders = s.owned.filter(
    (c) => c.kind === "LimitOrder" && c.data.owner === wallet.session?.partyId,
  );
  return (
    <TradingFrame title="Orders">
      <div className="canton-table-wrap">
        <table>
          <thead>
            <tr>
              {[
                "Market",
                "Outcome",
                "Side",
                "Price",
                "Remaining",
                "Actions",
              ].map((label) => (
                <th key={label}>{t(label)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {orders.map((c) => (
              <tr key={c.id}>
                <td>
                  <Link
                    href={`/canton/markets/${text(obj(c.data.key).marketId)}`}
                  >
                    {marketLabel(s.catalog?.contracts ?? [], marketKey(c.data))}
                  </Link>
                </td>
                <td>{t(String(c.data.outcome))}</td>
                <td>{t(c.data.side === "Buy" ? "Buy" : "Sell")}</td>
                <td>{text(c.data.price)}</td>
                <td>{text(c.data.quantity)}</td>
                <td>
                  <ActionButton
                    label="Cancel"
                    intent={{ action: "cancel", target: c.id }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!orders.length ? <p>{t("No open orders.")}</p> : null}
      </div>
    </TradingFrame>
  );
}
export function PositionsList() {
  const s = useCantonTrading(),
    { state: wallet } = useCantonWallet(),
    { t } = useI18n();
  const groups = new Map<string, Contract[]>();
  for (const c of s.owned.filter(
    (c) => c.kind === "PositionLot" && c.data.owner === wallet.session?.partyId,
  )) {
    const key = marketKey(c.data);
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  return (
    <TradingFrame title="Positions">
      <div className="canton-market-list">
        {[...groups].map(([key, lots]) => {
          const settled = s.catalog?.contracts.find(
              (c) => c.kind === "SettledReserve" && sameMarket(c, key),
            ),
            yes = lots.reduce((v, c) => v + integer(c.data.yes), BigInt(0)),
            no = lots.reduce((v, c) => v + integer(c.data.no), BigInt(0));
          return (
            <section className="canton-panel" key={key}>
              <Link
                href={`/canton/markets/${text(obj(lots[0].data.key).marketId)}`}
              >
                {marketLabel(s.catalog?.contracts ?? [], key)}
              </Link>
              <p>
                YES {yes.toString()} · NO {no.toString()}
              </p>
              {settled ? (
                <>
                  <p>
                    {t("Next claim")}: {claimValue(settled, lots.slice(0, 16))}{" "}
                    {text(obj(obj(settled.data.terms).collateral).id)}
                  </p>
                  <ActionButton
                    label={
                      claimValue(settled, lots.slice(0, 16)) === "0"
                        ? "Clear positions"
                        : "Claim"
                    }
                    intent={{ action: "redeem", target: settled.id }}
                  />
                </>
              ) : (
                <span>{t("Awaiting final settlement")}</span>
              )}
            </section>
          );
        })}
        {!groups.size ? <p>{t("No positions yet.")}</p> : null}
      </div>
    </TradingFrame>
  );
}
function claimValue(reserve: Contract, lots: Contract[]) {
  const yes = lots.reduce((v, c) => v + integer(c.data.yes), BigInt(0)),
    no = lots.reduce((v, c) => v + integer(c.data.no), BigInt(0));
  const units = BigInt("10000000000");
  return amount(
    reserve.data.outcome === "YesWins"
      ? yes * units
      : reserve.data.outcome === "NoWins"
        ? no * units
        : ((yes + no) * units) / BigInt(2),
  );
}
export function Balances() {
  const s = useCantonTrading(),
    { state: wallet } = useCantonWallet(),
    { t } = useI18n();
  const balances = s.owned.filter(
    (c) =>
      c.kind === "AssetBalance" && c.data.owner === wallet.session?.partyId,
  );
  return (
    <TradingFrame title="Trading balances">
      <div className="canton-grid">
        {s.catalog?.contracts
          .filter((c) => c.kind === "AssetAdmission")
          .map((asset) => {
            const instrument = obj(asset.data.instrument),
              balance = balances.find(
                (c) =>
                  obj(c.data.instrument).admin === instrument.admin &&
                  obj(c.data.instrument).id === instrument.id,
              );
            return (
              <section className="canton-panel" key={asset.id}>
                <h2>{text(instrument.id)}</h2>
                {balance ? (
                  <>
                    <p>
                      {t("Available")}:{" "}
                      <strong>{text(balance.data.available)}</strong>
                    </p>
                    <ActionForm
                      label="Deposit"
                      fields={[{ name: "amount", label: "Amount" }]}
                      build={(v) => ({
                        action: "deposit",
                        target: balance.id,
                        values: v,
                      })}
                    />
                    <ActionForm
                      label="Withdraw"
                      fields={[{ name: "amount", label: "Amount" }]}
                      build={(v) => ({
                        action: "withdraw",
                        target: balance.id,
                        values: v,
                      })}
                    />
                  </>
                ) : (
                  <ActionButton
                    label="Initialize balance"
                    intent={{ action: "enroll", target: asset.id }}
                  />
                )}
              </section>
            );
          })}
      </div>
    </TradingFrame>
  );
}
export function MarketDetail({ marketId }: { marketId: string }) {
  const s = useCantonTrading(),
    { state: wallet } = useCantonWallet(),
    { t, locale } = useI18n(),
    [tab, setTab] = useState("Trade");
  const current = marketRecords(s.catalog?.contracts ?? []).find(
    (c) =>
      text(obj(marketRecord(c).key ?? marketRecord(c)).marketId) === marketId,
  );
  if (!current)
    return (
      <TradingFrame title="Market">
        <p>{t("Market unavailable. Refresh and try again.")}</p>
      </TradingFrame>
    );
  const data = marketRecord(current),
    terms = obj(data.terms),
    key = marketKey(data),
    contracts = s.catalog?.contracts.filter((c) => sameMarket(c, key)) ?? [],
    book = contracts.find((c) => c.kind === "OrderBook"),
    reserve = contracts.find((c) => c.kind === "MarketReserve"),
    settled = contracts.find((c) => c.kind === "SettledReserve");
  const policy = s.catalog?.contracts.find((c) => c.kind === "Protocol"),
    party = wallet.session?.partyId,
    admins = policy?.data.admins;
  const admin = Array.isArray(admins) && admins.includes(party),
    operator = party === s.catalog?.deployment.operator;
  const manage =
    operator ||
    (admin &&
      (data.creator === party ||
        (terms.fallback && obj(terms.fallback).resolver === party)));
  const lots = s.owned.filter(
    (c) =>
      c.kind === "PositionLot" && c.data.owner === party && sameMarket(c, key),
  );
  return (
    <TradingFrame
      title={text(terms.question)}
      tools={<Link href="/canton/markets">{t("All markets")}</Link>}
    >
      <div className="canton-market-meta">
        <span>
          {t(
            current.kind === "FinalResolution"
              ? "Finalized"
              : current.kind === "ResolutionProposal"
                ? "Review period"
                : String(data.status),
          )}
        </span>
        <span>{text(obj(terms.collateral).id)}</span>
        {current.kind !== "BinaryMarket" ? (
          <strong>{t(String(data.outcome))}</strong>
        ) : null}
      </div>
      <nav className="canton-tabs" aria-label={t("Market sections")}>
        {["Trade", "Positions", "Rules", ...(manage ? ["Manage"] : [])].map(
          (label) => (
            <button
              key={label}
              type="button"
              aria-pressed={tab === label}
              onClick={() => setTab(label)}
            >
              {t(label)}
            </button>
          ),
        )}
      </nav>
      {tab === "Trade" ? (
        <div className="canton-grid">
          <section className="canton-panel">
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
                {s.catalog?.quotes
                  .filter((q) => q.market === key)
                  .sort((a, b) =>
                    raw(a.price) === raw(b.price)
                      ? 0
                      : raw(a.price) > raw(b.price)
                        ? -1
                        : 1,
                  )
                  .map((q) => (
                    <tr key={q.orderId}>
                      <td>{t(q.outcome)}</td>
                      <td>{t(q.side === "Buy" ? "Buy" : "Sell")}</td>
                      <td>{q.price}</td>
                      <td>{q.quantity}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
            {!s.catalog?.quotes.some((q) => q.market === key) ? (
              <p>{t("No open orders.")}</p>
            ) : null}
          </section>
          {book &&
          current.kind === "BinaryMarket" &&
          data.status === "Open" &&
          Date.parse(text(terms.closeAt)) > Date.now() ? (
            <OrderEntry
              book={book}
              terms={terms}
              rate={String(policy?.data.takerFeeBps)}
            />
          ) : (
            <p>{t("Trading closed")}</p>
          )}
        </div>
      ) : null}
      {tab === "Positions" ? (
        <section className="canton-panel">
          <p>
            YES{" "}
            {lots
              .reduce((v, c) => v + integer(c.data.yes), BigInt(0))
              .toString()}{" "}
            · NO{" "}
            {lots
              .reduce((v, c) => v + integer(c.data.no), BigInt(0))
              .toString()}
          </p>
          {settled && lots.length ? (
            <>
              <p>
                {t("Next claim")}: {claimValue(settled, lots.slice(0, 16))}{" "}
                {text(obj(terms.collateral).id)}
              </p>
              <ActionButton
                label={
                  claimValue(settled, lots.slice(0, 16)) === "0"
                    ? "Clear positions"
                    : "Claim"
                }
                intent={{ action: "redeem", target: settled.id }}
              />
            </>
          ) : null}
          {reserve ? (
            <div className="canton-grid">
              {current.kind === "BinaryMarket" &&
              data.status === "Open" &&
              Date.parse(text(terms.closeAt)) > Date.now() ? (
                <ActionForm
                  label="Create pairs"
                  fields={[
                    {
                      name: "quantity",
                      label: "Contracts",
                      value: String(terms.quantityLot),
                    },
                  ]}
                  build={(v) => ({
                    action: "split",
                    target: reserve.id,
                    values: v,
                  })}
                />
              ) : null}
              <ActionForm
                label="Merge pairs"
                fields={[
                  {
                    name: "quantity",
                    label: "Contracts",
                    value: String(terms.quantityLot),
                  },
                ]}
                build={(v) => ({
                  action: "merge",
                  target: reserve.id,
                  values: v,
                })}
              />
            </div>
          ) : null}
          <Link href="/canton/wallet">{t("Deposit / withdraw")}</Link>
        </section>
      ) : null}
      {tab === "Rules" ? (
        <section className="canton-panel">
          <dl>
            {[
              ...Object.entries(obj(terms.rules)),
              ["closeAt", terms.closeAt],
              ["earliestResolutionAt", terms.earliestResolutionAt],
              ["fallback", terms.fallback],
              ["resolutionDelaySeconds", terms.resolutionDelaySeconds],
            ].map(([label, value]) => (
              <div key={String(label)}>
                <dt>{t(ruleLabels[String(label)] ?? String(label))}</dt>
                <dd>
                  {value === null
                    ? "—"
                    : typeof value === "object"
                      ? `${text(obj(value).resolver)} · ${new Date(text(obj(value).availableAt)).toLocaleString(locale, { timeZone: "UTC" }) + " UTC"}${obj(value).deadlineAt ? ` – ${new Date(text(obj(value).deadlineAt)).toLocaleString(locale, { timeZone: "UTC" }) + " UTC"}` : ""}`
                      : ["closeAt", "earliestResolutionAt"].includes(
                            String(label),
                          )
                        ? new Date(String(value)).toLocaleString(locale, {
                            timeZone: "UTC",
                          }) + " UTC"
                        : String(value)}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}
      {tab === "Manage" && manage ? (
        <div className="canton-grid">
          {current.kind === "BinaryMarket" &&
          data.creator === party &&
          admin ? (
            <section className="canton-panel">
              {data.status === "Draft" ? (
                <>
                  {!reserve ? (
                    <ActionButton
                      label="Initialize reserve"
                      intent={{ action: "reserve", target: current.id }}
                    />
                  ) : !book ? (
                    <ActionButton
                      label="Initialize order book"
                      intent={{ action: "book", target: current.id }}
                    />
                  ) : (
                    <ActionButton
                      label="Open market"
                      intent={{ action: "open", target: current.id }}
                    />
                  )}
                  <ActionButton
                    label="Cancel draft"
                    intent={{ action: "cancelDraft", target: current.id }}
                  />
                </>
              ) : (
                <>
                  {data.status === "Open" ? (
                    <ActionForm
                      label="Close market"
                      fields={[{ name: "reason", label: "Reason" }]}
                      build={(v) => ({
                        action: "close",
                        target: current.id,
                        values: v,
                      })}
                    />
                  ) : null}
                  {party && resolverEligible(data, party) ? (
                    <ResolutionForm action="propose" target={current.id} />
                  ) : null}
                </>
              )}
            </section>
          ) : null}
          {current.kind === "ResolutionProposal" ? (
            <section className="canton-panel">
              <p>
                {t("Review ends")}: {text(data.finalizableAt)}
              </p>
              {admin &&
              party &&
              resolverEligible(data, party) &&
              Date.now() < Date.parse(text(data.finalizableAt)) ? (
                <ResolutionForm action="correct" target={current.id} />
              ) : null}
              {operator &&
              Date.now() >= Date.parse(text(data.finalizableAt)) ? (
                <ActionButton
                  label="Finalize result"
                  intent={{ action: "finalize", target: current.id }}
                />
              ) : null}
            </section>
          ) : null}
          {current.kind === "BinaryMarket" &&
          data.creator !== party &&
          admin &&
          party &&
          resolverEligible(data, party) ? (
            <section className="canton-panel">
              <ResolutionForm action="fallbackPropose" target={current.id} />
            </section>
          ) : null}
          {operator && current.kind === "FinalResolution" && reserve ? (
            <ActionButton
              label="Prepare claims"
              intent={{ action: "bind", target: reserve.id }}
            />
          ) : null}
          {operator && book ? (
            <section className="canton-panel">
              <ActionForm
                label="Match next"
                fields={[
                  {
                    name: "outcome",
                    label: "Outcome",
                    options: [
                      { value: "Yes", label: "YES" },
                      { value: "No", label: "NO" },
                    ],
                  },
                ]}
                build={(v) => ({ action: "match", target: book.id, values: v })}
              />
              <p>
                {t("Earned fees")}: {text(obj(book.data.fees).amount)}
              </p>
              <ActionForm
                label="Withdraw fees"
                fields={[{ name: "amount", label: "Amount" }]}
                build={(v) => ({
                  action: "withdrawFees",
                  target: book.id,
                  values: v,
                })}
              />
            </section>
          ) : null}
        </div>
      ) : null}
    </TradingFrame>
  );
}
function OrderEntry({
  book,
  terms,
  rate,
}: {
  book: Contract;
  terms: RecordValue;
  rate: string;
}) {
  const s = useCantonTrading(),
    { t } = useI18n(),
    id = useId(),
    [price, setPrice] = useState(""),
    [quantity, setQuantity] = useState(""),
    [side, setSide] = useState("buy"),
    [outcome, setOutcome] = useState("Yes");
  let quote: ReturnType<typeof orderQuote> | null = null;
  try {
    quote = orderQuote(
      price,
      quantity,
      text(terms.priceTick),
      text(terms.quantityLot),
      rate,
      text(book.data.assetDecimals),
    );
  } catch {}
  return (
    <form
      className="canton-panel canton-form"
      onSubmit={(e) => {
        e.preventDefault();
        void s
          .execute({
            action: side === "buy" ? "buy" : "sell",
            target: book.id,
            values: { price, quantity, outcome },
          })
          .then(() => {
            setPrice("");
            setQuantity("");
          })
          .catch(() => {});
      }}
    >
      <h2>{t("Limit order")}</h2>
      <fieldset
        disabled={s.busy || s.syncing || !s.catalog?.deployment.trading}
      >
        <label htmlFor={`${id}-side`}>
          {t("Side")}
          <select
            id={`${id}-side`}
            value={side}
            onChange={(e) => setSide(e.target.value)}
          >
            <option value="buy">{t("Buy")}</option>
            <option value="sell">{t("Sell")}</option>
          </select>
        </label>
        <label htmlFor={`${id}-outcome`}>
          {t("Outcome")}
          <select
            id={`${id}-outcome`}
            value={outcome}
            onChange={(e) => setOutcome(e.target.value)}
          >
            <option value="Yes">YES</option>
            <option value="No">NO</option>
          </select>
        </label>
        <label htmlFor={`${id}-price`}>
          {t("Price")}
          <input
            id={`${id}-price`}
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            inputMode="decimal"
            placeholder="0.60"
            required
          />
        </label>
        <label htmlFor={`${id}-quantity`}>
          {t("Contracts")}
          <input
            id={`${id}-quantity`}
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            inputMode="numeric"
            placeholder={text(terms.quantityLot)}
            required
          />
        </label>
        {quote ? (
          <p className="canton-order-summary">
            {t(side === "buy" ? "Maximum debit" : "Order value")}:{" "}
            <strong>{side === "buy" ? quote.debit : quote.gross}</strong>{" "}
            {text(obj(terms.collateral).id)} · {t("Fee budget")}: {quote.fee}
          </p>
        ) : null}
        <button className="canton-action" disabled={!quote} type="submit">
          {t(side === "buy" ? "Buy" : "Sell")} {outcome.toUpperCase()}
        </button>
      </fieldset>
    </form>
  );
}
function ResolutionForm({
  action,
  target,
}: {
  action: "propose" | "fallbackPropose" | "correct";
  target: string;
}) {
  return (
    <ActionForm
      label={action === "correct" ? "Correct result" : "Propose result"}
      fields={[
        {
          name: "outcome",
          label: "Outcome",
          options: [
            { value: "YesWins", label: "YES" },
            { value: "NoWins", label: "NO" },
            { value: "Invalid", label: "Invalid" },
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
          outcome: v.outcome,
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
const ruleLabels: Record<string, string> = {
  yesCriteria: "YES criteria",
  noCriteria: "NO criteria",
  invalidCriteria: "Invalid criteria",
  evidenceRequirements: "Evidence required",
  documentUri: "Rules URL",
  documentSha256: "SHA-256",
  closeAt: "Closes",
  earliestResolutionAt: "Earliest resolution",
  fallback: "Fallback resolver",
  resolutionDelaySeconds: "Review delay (seconds)",
};
