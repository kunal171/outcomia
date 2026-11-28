"use client";
/** A club's security deposit: its status for everyone, and paying or topping
 * it up for the owner (docs/club-rules-and-disputes.md, section 2). The program
 * enforces every rule; this card only explains and prefills. */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import type { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { useI18n } from "../preferences-provider";
import type { ClubAccount, ClubRulesConfigAccount } from "../../lib/clubs";
import {
  depositAsset,
  depositClubSolInstruction,
  depositClubUsdcInstruction,
  depositShortfall,
  depositStatus,
  depositsConfigured,
  formatSol,
  formatUsd,
  freshSolUsdPrice,
  parseUnits,
  readSolUsdPrice,
  type PythPrice,
} from "../../lib/club-deposits";
import type { useClubTransaction } from "./club-transaction";

type Tx = ReturnType<typeof useClubTransaction>;
type Asset = "usdc" | "sol";
const SOL_DECIMALS = 9;

/** Base units shown in the amount field, in the asset's own decimals. */
const toText = (units: bigint, decimals: number) => {
  const scale = BigInt(10) ** BigInt(decimals);
  const fraction = String(units % scale)
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  return `${units / scale}${fraction ? `.${fraction}` : ""}`;
};

export function ClubDeposit({
  club,
  account,
  rules,
  owner,
  tx,
}: {
  club: PublicKey;
  account: ClubAccount;
  rules: ClubRulesConfigAccount | null;
  owner: boolean;
  tx: Tx;
}) {
  const { t } = useI18n();
  const { connection } = useConnection();
  const held = depositAsset(account);
  const [choice, setChoice] = useState<Asset>("usdc");
  const asset: Asset = held === "none" ? choice : held;
  const [price, setPrice] = useState<PythPrice | null>(null);
  const [amount, setAmount] = useState<string | null>(null);
  // Deposit rules, or null until the super-admin sets them.
  const deposit = depositsConfigured(rules) ? rules : null;
  const kind = account.kind?.public ? "public" : "private";

  // SOL needs a price both to show the club's value and to prefill a payment.
  const needsPrice = deposit !== null && (held === "sol" || asset === "sol");
  useEffect(() => {
    if (!needsPrice || !deposit) return;
    let dead = false;
    const feed = Buffer.from(deposit.solUsdFeedId).toString("hex");
    const load = () =>
      void readSolUsdPrice(connection, feed)
        .then((read) => !dead && setPrice(read?.price ?? null))
        .catch(() => !dead && setPrice(null));
    load();
    const timer = setInterval(load, 30_000);
    return () => {
      dead = true;
      clearInterval(timer);
    };
  }, [connection, needsPrice, deposit]);

  const status = useMemo(
    () => (deposit ? depositStatus(account, deposit, price) : null),
    [account, deposit, price],
  );
  const decimals =
    asset === "usdc" ? (deposit?.depositMintDecimals ?? 6) : SOL_DECIMALS;
  // Prefill what is still missing; SOL adds 1% for price moves before signing.
  const suggested = useMemo(() => {
    if (!deposit || (asset === "sol" && !price)) return null;
    const current = held === asset ? (status?.amount ?? BigInt(0)) : BigInt(0);
    const shortfall = depositShortfall(deposit, kind, asset, current, price);
    if (shortfall === BigInt(0)) return null;
    return asset === "sol" ? (shortfall * BigInt(101) + BigInt(99)) / BigInt(100) : shortfall;
  }, [asset, deposit, held, kind, price, status]);
  const text = amount ?? (suggested ? toText(suggested, decimals) : "");
  const units = parseUnits(text, decimals);

  if (!deposit || !status)
    return (
      <section className="ui-card">
        <div className="club-card-head">
          <h2 className="ui-h3">{t("Security deposit")}</h2>
        </div>
        <p className="club-muted">
          {t(
            "Club deposits are not set up yet, so club markets cannot be created.",
          )}
        </p>
      </section>
    );

  const balance =
    held === "none"
      ? t("Not paid")
      : held === "usdc"
        ? `${toText(status.amount, deposit.depositMintDecimals)} USDC`
        : formatSol(status.amount);

  async function pay(event: FormEvent) {
    event.preventDefault();
    if (!units || units <= BigInt(0) || !deposit) return;
    const rulesNow = deposit;
    await tx.run(async (p, signer) => {
      if (asset === "usdc") {
        const token = getAssociatedTokenAddressSync(rulesNow.depositMint, signer);
        return [
          await depositClubUsdcInstruction(
            p,
            signer,
            club,
            rulesNow.depositMint,
            token,
            units,
          ),
        ];
      }
      const read = await freshSolUsdPrice(connection, rulesNow);
      return [
        await depositClubSolInstruction(p, signer, club, read.address, units),
      ];
    });
    setAmount(null);
  }

  return (
    <section className="ui-card" aria-label={t("Security deposit")}>
      <div className="club-card-head">
        <h2 className="ui-h3">{t("Security deposit")}</h2>
        <span
          className={`ui-badge ${
            status.funded
              ? "ui-badge-yes"
              : status.funded === false
                ? "ui-badge-warn"
                : ""
          }`}
        >
          {status.funded
            ? t("At minimum")
            : status.funded === false
              ? t("Below minimum")
              : t("Checking price…")}
        </span>
      </div>
      <dl className="club-deposit-facts">
        <div>
          <dt>{t("Deposit")}</dt>
          <dd>
            {balance}
            {held === "sol" && status.valueUsd !== null
              ? ` (≈ ${formatUsd(status.valueUsd)})`
              : ""}
          </dd>
        </div>
        <div>
          <dt>{t("Minimum")}</dt>
          <dd>{formatUsd(status.minimumUsd)}</dd>
        </div>
      </dl>
      <p className="club-muted">
        {t(
          "While the deposit is below the minimum, this club cannot create or open markets. Its existing markets keep trading and resolving.",
        )}
      </p>
      {owner && (
        <form className="club-deposit-form" onSubmit={(e) => void pay(e)}>
          {held === "none" && (
            <label className="ui-field">
              <span>{t("Pay in")}</span>
              <select
                className="ui-input"
                value={choice}
                disabled={tx.pending}
                onChange={(e) => {
                  setChoice(e.target.value as Asset);
                  setAmount(null);
                }}
              >
                <option value="usdc">USDC</option>
                <option value="sol">SOL</option>
              </select>
            </label>
          )}
          <label className="ui-field">
            <span>
              {asset === "usdc" ? t("Amount (USDC)") : t("Amount (SOL)")}
            </span>
            <input
              className="ui-input"
              inputMode="decimal"
              value={text}
              disabled={tx.pending}
              aria-invalid={text !== "" && !units}
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
          <p className="club-help">
            {held === "none"
              ? t(
                  "The first deposit fixes the token. SOL must be worth {value0} of the minimum when paid, as a buffer for price drops.",
                  { value0: `${deposit.solBufferBps / 100}%` },
                )
              : t(
                  "Top-ups are added to the deposit. The deposit is refunded to the owner when the club closes.",
                )}
          </p>
          <button
            className="ui-btn ui-btn-primary"
            type="submit"
            disabled={tx.pending || !units || units <= BigInt(0)}
          >
            {held === "none" ? t("Pay deposit") : t("Top up deposit")}
          </button>
        </form>
      )}
    </section>
  );
}
