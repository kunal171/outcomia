"use client";
/** A prediction market's dispute: the window, opening a dispute (holders),
 * ruling (eligible protocol admins) and expiry (anyone). Shared by binary,
 * club and multi-outcome market pages (docs/club-rules-and-disputes.md §3).
 * The program enforces every rule; this card explains and builds. */
import { useEffect, useMemo, useState } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { PROGRAM_ID } from "../lib/solana";
import type { PredictionMarketAccount } from "../lib/prediction";
import { AnchorProvider, type BN } from "@anchor-lang/core";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";
import { useI18n } from "./preferences-provider";
import { useProtocolRole } from "./protocol-role-provider";
import { getOutcomiaProgram, getOutcomiaReadProgram, transactionExplorerUrl } from "../lib/outcomia";
import {
  bondUnits,
  canDispute,
  disputeState,
  expireDisputeInstruction,
  openDisputeInstruction,
  readDisputeConfig,
  readMarketDispute,
  ruleDisputeInstruction,
  rulerIssue,
  windowEnd,
  type BinaryRuling,
  type DisputeConfigAccount,
  type MarketDisputeAccount,
  type MarketFamily,
  type MultiRuling,
} from "../lib/disputes";

/** The market fields a dispute depends on, in one shape for both families. */
export interface DisputedMarket {
  status: Record<string, object>;
  proposal: { proposedAt: BN } | null;
  resolutionDelaySeconds: BN;
  creator: PublicKey;
  resolver: PublicKey;
  fallback: { resolver: PublicKey } | null;
  mint: PublicKey;
  /** Overturn choices: binary "yes"/"no", or multi-outcome indexes. */
  outcomes: { value: "yes" | "no" | number; label: string }[];
  /** Label of the proposed outcome, if any. */
  proposedLabel: string | null;
}

const STATE_LABELS: Record<string, string> = {
  upheld: "Dispute upheld: the proposed outcome stands",
  overturned: "Dispute won: an admin chose another outcome",
  invalidated: "Dispute won: an admin ruled the market invalid",
  expired: "No ruling in time: the market is invalid",
};

export function MarketDispute({
  family,
  address,
  market,
  club,
  onChanged,
}: {
  family: MarketFamily;
  address: PublicKey;
  market: DisputedMarket;
  /** The club of a club market, for the ruling eligibility check. */
  club: PublicKey | null;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const { role } = useProtocolRole();
  const reader = useMemo(() => getOutcomiaReadProgram(connection), [connection]);
  const [dispute, setDispute] = useState<MarketDisputeAccount | null>(null);
  const [config, setConfig] = useState<DisputeConfigAccount | null>(null);
  const [decimals, setDecimals] = useState<number | null>(null);
  const [revision, setRevision] = useState(0);
  const [pending, setPending] = useState(false);
  const [issue, setIssue] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [ruling, setRuling] = useState<string>("uphold");
  const [holds, setHolds] = useState(false);
  const now = Math.floor(Date.now() / 1000);

  useEffect(() => {
    let dead = false;
    void Promise.all([
      readMarketDispute(reader, address),
      readDisputeConfig(reader),
      getMint(connection, market.mint).then((m) => m.decimals).catch(() => null),
    ]).then(([d, c, dec]) => {
      if (dead) return;
      setDispute(d);
      setConfig(c);
      setDecimals(dec);
    });
    return () => {
      dead = true;
    };
  }, [reader, connection, address, market.mint, revision, market.status]);

  // Only holders may dispute: read the connected wallet's position.
  useEffect(() => {
    if (!wallet) return setHolds(false);
    let dead = false;
    const seed = family === "binary" ? "prediction_position" : "multi_position";
    const position = PublicKey.findProgramAddressSync(
      [Buffer.from(seed), address.toBuffer(), wallet.publicKey.toBuffer()],
      PROGRAM_ID,
    )[0];
    const accounts = reader.account as unknown as Record<
      string,
      { fetchNullable(k: PublicKey): Promise<Record<string, unknown> | null> }
    >;
    void accounts[family === "binary" ? "predictionPosition" : "multiOutcomePosition"]
      .fetchNullable(position)
      .then((p) => {
        if (dead) return;
        const amounts = p
          ? family === "binary"
            ? [p.yesFree, p.yesLocked, p.noFree, p.noLocked]
            : [...(p.free as unknown[]), ...(p.locked as unknown[])]
          : [];
        setHolds(amounts.some((n) => !!n && (n as { isZero(): boolean }).isZero?.() === false));
      })
      .catch(() => !dead && setHolds(false));
    return () => {
      dead = true;
    };
  }, [wallet, reader, family, address, revision]);

  if (!dispute) return null;
  const state = disputeState(dispute);
  const end = windowEnd(market, dispute);
  const open = canDispute(market.status, market, dispute, now);
  const deadline = dispute.rulingDeadline.toNumber();
  const admin = role === "admin" || role === "super-admin";
  const notEligible =
    wallet && admin
      ? rulerIssue(wallet.publicKey, market.creator, market.resolver, market.fallback)
      : null;
  const when = (seconds: number) => new Date(seconds * 1000).toLocaleString();
  const bond =
    config && decimals !== null
      ? `${(Number(bondUnits(config, decimals)) / 10 ** decimals).toLocaleString()}`
      : null;

  async function send(build: (p: ReturnType<typeof getOutcomiaProgram>, signer: PublicKey) => Promise<TransactionInstruction[]>) {
    if (!wallet || pending) return;
    setPending(true);
    setIssue(null);
    setSignature(null);
    setConfirming(false);
    try {
      const p = getOutcomiaProgram(connection, wallet);
      const tx = new Transaction().add(...(await build(p, wallet.publicKey)));
      setSignature(await (p.provider as AnchorProvider).sendAndConfirm(tx));
      setRevision((v) => v + 1);
      onChanged();
    } catch (cause) {
      setIssue(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }
  /** The associated token account of `owner` for the bond mint, created if missing. */
  const tokenFor = (signer: PublicKey, owner: PublicKey, before: TransactionInstruction[]) => {
    const account = getAssociatedTokenAddressSync(market.mint, owner, true);
    before.push(
      createAssociatedTokenAccountIdempotentInstruction(signer, account, owner, market.mint),
    );
    return account;
  };

  const openDispute = () =>
    void send(async (p, signer) => [
      await openDisputeInstruction(
        p,
        family,
        signer,
        address,
        market.mint,
        getAssociatedTokenAddressSync(market.mint, signer, true),
      ),
    ]);
  const rule = () =>
    void send(async (p, signer) => {
      if (!config) throw new Error("Dispute settings are not set yet.");
      const before: TransactionInstruction[] = [];
      const upheld = ruling === "uphold";
      const recipient = tokenFor(signer, upheld ? config.treasury : dispute.disputer, before);
      const choice =
        ruling === "uphold" || ruling === "invalid"
          ? ruling
          : family === "multi"
            ? Number(ruling)
            : (ruling as BinaryRuling);
      before.push(
        await ruleDisputeInstruction(
          p,
          family,
          signer,
          address,
          choice as BinaryRuling | MultiRuling,
          recipient,
          dispute.disputer,
          club,
        ),
      );
      return before;
    });
  const expire = () =>
    void send(async (p, signer) => {
      const before: TransactionInstruction[] = [];
      const recipient = tokenFor(signer, dispute.disputer, before);
      before.push(await expireDisputeInstruction(p, family, address, recipient, dispute.disputer));
      return before;
    });

  return (
    <section className="ui-card market-dispute" aria-label={t("Outcome dispute")}>
      <div className="club-card-head">
        <h2 className="ui-h3">{t("Outcome dispute")}</h2>
        {state === "open" && <span className="ui-badge ui-badge-warn">{t("Disputed")}</span>}
      </div>

      {state === "none" && end !== null && "proposed" in market.status && (
        <p className="club-help">
          {now < end
            ? t("Holders can dispute the proposed outcome until {value0}. Payouts wait until then.", {
                value0: when(end),
              })
            : t("The dispute window ended on {value0} with no dispute.", { value0: when(end) })}
        </p>
      )}

      {open && holds && wallet && (
        <div className="ui-actions">
          {confirming ? (
            <>
              <button type="button" className="ui-btn ui-btn-no" disabled={pending} onClick={openDispute}>
                {t("Yes, dispute and pay the bond")}
              </button>
              <button type="button" className="ui-btn" onClick={() => setConfirming(false)}>
                {t("Cancel")}
              </button>
            </>
          ) : (
            <button type="button" className="ui-btn" disabled={pending} onClick={() => setConfirming(true)}>
              {bond
                ? t("Dispute this outcome (bond {value0})", { value0: bond })
                : t("Dispute this outcome")}
            </button>
          )}
          <p className="club-help">
            {t(
              "The bond is refunded if an admin overturns the outcome or rules the market invalid, and goes to the treasury if the outcome is upheld. A market can be disputed once.",
            )}
          </p>
        </div>
      )}

      {state === "open" && (
        <>
          <p className="club-help">
            {now < deadline
              ? t("An admin must rule by {value0}; otherwise the market becomes invalid.", {
                  value0: when(deadline),
                })
              : t("Nobody ruled by {value0}. Anyone can now make the market invalid.", {
                  value0: when(deadline),
                })}
          </p>
          {now >= deadline && wallet && (
            <div className="ui-actions">
              <button type="button" className="ui-btn" disabled={pending} onClick={expire}>
                {t("Make the market invalid")}
              </button>
            </div>
          )}
          {now < deadline && admin && wallet && (
            notEligible ? (
              <p className="ui-notice" role="status">{t(notEligible)}</p>
            ) : (
              <div className="market-dispute-rule">
                <label className="ui-field">
                  <span>{t("Ruling")}</span>
                  <select
                    className="ui-input"
                    value={ruling}
                    disabled={pending}
                    onChange={(e) => setRuling(e.target.value)}
                  >
                    <option value="uphold">
                      {market.proposedLabel
                        ? t("Uphold: {value0}", { value0: market.proposedLabel })
                        : t("Uphold the proposal")}
                    </option>
                    {market.outcomes.map((o) => (
                      <option key={String(o.value)} value={String(o.value)}>
                        {t("Overturn to {value0}", { value0: o.label })}
                      </option>
                    ))}
                    <option value="invalid">{t("Rule the market invalid")}</option>
                  </select>
                </label>
                <button type="button" className="ui-btn ui-btn-primary" disabled={pending} onClick={rule}>
                  {t("Submit final ruling")}
                </button>
                {club && (
                  <p className="club-help">
                    {t("Admins of this market's club cannot rule; the program checks this.")}
                  </p>
                )}
              </div>
            )
          )}
        </>
      )}

      {STATE_LABELS[state] && <p className="club-help">{t(STATE_LABELS[state])}</p>}

      {issue && (
        <p className="ui-notice" role="alert">
          {t(issue)}
        </p>
      )}
      {signature && (
        <p className="ui-notice">
          <a href={transactionExplorerUrl(signature)} target="_blank" rel="noreferrer">
            {t("View transaction ↗")}
          </a>
        </p>
      )}
    </section>
  );
}

/** A binary market (public or club) in the dispute card's shape. */
export function binaryDisputedMarket(m: PredictionMarketAccount): DisputedMarket {
  const proposed = m.proposal
    ? "yes" in m.proposal.outcome
      ? "yes"
      : "no" in m.proposal.outcome
        ? "no"
        : "invalid"
    : null;
  return {
    status: m.status,
    proposal: m.proposal,
    resolutionDelaySeconds: m.resolutionDelaySeconds,
    creator: m.authority,
    resolver: m.resolver,
    fallback: m.fallback,
    mint: m.collateralMint,
    outcomes: (["yes", "no"] as const)
      .filter((o) => o !== proposed)
      .map((o) => ({ value: o, label: o.toUpperCase() })),
    proposedLabel: proposed === "invalid" ? "Invalid" : proposed?.toUpperCase() ?? null,
  };
}

/** When a proposal can actually be finalized: after the review delay and the
 * dispute window, never while a dispute is open. Markets proposed before
 * disputes have no record and keep the review delay alone. */
export function useFinalizeGate(
  address: PublicKey | null,
  proposal: { proposedAt: BN } | null | undefined,
  resolutionDelaySeconds: BN | undefined,
  refresh?: unknown,
) {
  const { connection } = useConnection();
  const reader = useMemo(() => getOutcomiaReadProgram(connection), [connection]);
  const [dispute, setDispute] = useState<MarketDisputeAccount | null>(null);
  useEffect(() => {
    if (!address) return;
    let dead = false;
    void readMarketDispute(reader, address).then((d) => !dead && setDispute(d));
    return () => {
      dead = true;
    };
  }, [reader, address, refresh, proposal?.proposedAt.toString()]);
  if (!proposal || !resolutionDelaySeconds) return { at: null, open: false };
  const delayEnd = proposal.proposedAt.toNumber() + resolutionDelaySeconds.toNumber();
  if (!dispute) return { at: delayEnd, open: false };
  return {
    at: windowEnd({ proposal, resolutionDelaySeconds }, dispute) ?? delayEnd,
    open: disputeState(dispute) === "open",
  };
}
