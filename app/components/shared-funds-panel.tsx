"use client";
import { useEffect, useState } from "react";
import { BN } from "@anchor-lang/core";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { useI18n } from "./preferences-provider";
import { useSharedFunds } from "./shared-wallet";
import { TestUsdcFaucet } from "./test-usdc-faucet";
import { TransactionToast } from "./transaction-toast";
import { accountExplorerUrl, parseTokenAmount } from "../lib/outcomia";
import { readableAmount } from "../lib/market-display";
import { SHARED_BALANCES_ENABLED } from "../lib/shared";
import type { AssetRow } from "../lib/wallet-overview";

/** Wallet page: pick one token, see where it sits (wallet, free in Outcomia,
 * locked in orders), then move it with a single Deposit/Withdraw form. */
export function SharedFundsPanel({
  assets,
  onChanged,
}: {
  assets: AssetRow[];
  onChanged?: () => void;
}) {
  const { t } = useI18n();
  const wallet = useAnchorWallet(),
    { connection } = useConnection();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const [picked, setPicked] = useState<string | null>(null);
  if (!SHARED_BALANCES_ENABLED || !mounted || !wallet) return null;
  if (assets.length === 0)
    return <p className="funds-empty">{t("No Outcomia-listed tokens yet.")}</p>;
  const row = assets.find((a) => a.mint.toBase58() === picked) ?? assets[0];
  return (
    <section className="shared-funds funds-panel">
      <div className="funds-tokens" role="group" aria-label={t("Token")}>
        {assets.map((a) => (
          <button
            key={a.mint.toBase58()}
            type="button"
            aria-pressed={a === row}
            onClick={() => setPicked(a.mint.toBase58())}
          >
            <strong>{a.symbol}</strong>
            <small>
              {t("{value0} in Outcomia", {
                value0:
                  a.available && a.inOrders
                    ? readableAmount(a.available.add(a.inOrders), a.decimals)
                    : "—",
              })}
            </small>
          </button>
        ))}
      </div>
      <Panel
        key={`${connection.rpcEndpoint}:${wallet.publicKey}:${row.mint}`}
        row={row}
        onChanged={onChanged}
      />
    </section>
  );
}

function Panel({ row, onChanged }: { row: AssetRow; onChanged?: () => void }) {
  const { t } = useI18n();
  const { mint, decimals, symbol } = row;
  const {
    balance,
    loaded,
    pending,
    issue,
    signature,
    amount,
    setAmount,
    act,
    refresh,
  } = useSharedFunds({ mint, decimals, onChanged });
  const [mode, setMode] = useState<"deposit" | "withdraw">("deposit");
  const inWallet = row.wallet ? row.wallet.sub(row.frozen) : null;
  const free = loaded ? (balance?.free ?? new BN(0)) : null;
  const locked = loaded ? (balance?.locked ?? new BN(0)) : null;
  const max = mode === "deposit" ? inWallet : free;
  const show = (value: BN | null) =>
    value ? readableAmount(value, decimals) : "—";

  let parsed: BN | null = null;
  try {
    parsed = parseTokenAmount(amount, decimals, "Amount");
  } catch {
    /* Invalid input keeps the action disabled. */
  }
  const tooMuch = parsed !== null && max !== null && parsed.gt(max);
  const ready =
    loaded &&
    !pending &&
    parsed !== null &&
    parsed.gtn(0) &&
    !tooMuch &&
    (mode === "deposit" || balance !== null);

  return (
    <>
      <div className="funds-balances">
        <article>
          <span className="card-label">{t("In your wallet")}</span>
          <strong>
            {show(inWallet)} <small>{symbol}</small>
          </strong>
          <span>{t("Not in Outcomia yet. Deposit to trade.")}</span>
        </article>
        <article className="funds-free">
          <span className="card-label">{t("Free to withdraw")}</span>
          <strong>
            {show(free)} <small>{symbol}</small>
          </strong>
          <span>{t("In Outcomia, usable in any market.")}</span>
        </article>
        <article>
          <span className="card-label">{t("Locked in open orders")}</span>
          <strong>
            {show(locked)} <small>{symbol}</small>
          </strong>
          <span>{t("Cancel an order to free it.")}</span>
        </article>
      </div>

      <div className="funds-mode" role="group" aria-label={t("Action")}>
        {(["deposit", "withdraw"] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={mode === value}
            disabled={pending}
            onClick={() => {
              setMode(value);
              setAmount("");
            }}
          >
            {value === "deposit"
              ? t("Deposit to Outcomia")
              : t("Withdraw to wallet")}
          </button>
        ))}
      </div>

      {mode === "deposit" && (
        <TestUsdcFaucet mint={mint} onClaimed={onChanged} />
      )}

      <label>
        {mode === "deposit"
          ? t("Amount to deposit ({value0})", { value0: symbol })
          : t("Amount to withdraw ({value0})", { value0: symbol })}
        <span className="funds-amount">
          <input
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            disabled={pending}
          />
          <button
            type="button"
            disabled={pending || !max || max.lten(0)}
            onClick={() =>
              max && setAmount(readableAmount(max, decimals).replace(/,/g, ""))
            }
          >
            {t("Max")}
          </button>
        </span>
      </label>
      {tooMuch && (
        <p className="funds-warning" role="alert">
          {mode === "deposit"
            ? t("Your wallet holds less than this.")
            : t("Only {value0} {value1} is free to withdraw.", {
                value0: show(free),
                value1: symbol,
              })}
        </p>
      )}
      <button
        type="button"
        className="funds-submit"
        disabled={!ready}
        onClick={() => void act(mode === "withdraw")}
      >
        {pending
          ? t("Confirm in wallet…")
          : mode === "deposit"
            ? t("Deposit {value0} {value1}", {
                value0: amount || "0",
                value1: symbol,
              })
            : t("Withdraw {value0} {value1}", {
                value0: amount || "0",
                value1: symbol,
              })}
      </button>
      {issue && <p role="alert">{t(issue)}</p>}
      <p className="funds-meta">
        <a href={accountExplorerUrl(mint)} target="_blank" rel="noreferrer">
          {`${mint.toBase58().slice(0, 6)}…${mint.toBase58().slice(-6)} ↗`}
        </a>
        <button type="button" disabled={pending} onClick={refresh}>
          {t("Refresh")}
        </button>
      </p>
      <TransactionToast signature={signature} />
    </>
  );
}
