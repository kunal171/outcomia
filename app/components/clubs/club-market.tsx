"use client";
/** A club market: trading on its club book, positions, exits and resolution.
 * Exits (cancel, merge, redeem) never depend on membership. */
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { BN } from "@anchor-lang/core";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { AppHeader } from "../app-header";
import { useI18n } from "../preferences-provider";
import { SharedMarket } from "../shared-market";
import { PredictionChart } from "../prediction-chart";
import {
  getOutcomiaAccounts,
  getOutcomiaReadProgram,
  parseTokenAmount,
} from "../../lib/outcomia";
import {
  derivePredictionPositionPda,
  predictionStatus,
  predictionTime,
  type PredictionPositionAccount,
} from "../../lib/prediction";
import { correctionOpen } from "../../lib/correction-window";
import { readableAmount } from "../../lib/market-display";
import {
  CLUBS_ENABLED,
  advanceClubPredictionInstruction,
  clubCompleteSetInstruction,
  clubRole,
  clubTrading,
  closeClubTradingInstruction,
  isAdmin,
  membersOnly,
  proposeClubPredictionInstruction,
  readClub,
  redeemClubPredictionInstruction,
  type ClubSnapshot,
} from "../../lib/clubs";
import { ClubFeedback, useClubTransaction } from "./club-transaction";
import {
  MarketDispute,
  binaryDisputedMarket,
  useFinalizeGate,
} from "../market-dispute";

export const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  open: "Open",
  frozen: "Trading closed",
  proposed: "Outcome proposed",
  resolved: "Resolved",
};

export function ClubMarket({
  clubAddress,
  marketAddress,
}: {
  clubAddress: string;
  marketAddress: string;
}) {
  const { t } = useI18n();
  const { connection } = useConnection();
  const program = useMemo(
    () => getOutcomiaReadProgram(connection),
    [connection],
  );
  const club = useMemo(() => new PublicKey(clubAddress), [clubAddress]);
  const market = useMemo(() => new PublicKey(marketAddress), [marketAddress]);
  const [snapshot, setSnapshot] = useState<ClubSnapshot | null>(null),
    [loaded, setLoaded] = useState(false),
    [loadIssue, setLoadIssue] = useState<string | null>(null),
    [revision, setRevision] = useState(0),
    [position, setPosition] = useState<PredictionPositionAccount | null>(null),
    [quantity, setQuantity] = useState(""),
    [outcome, setOutcome] = useState<"yes" | "no" | "invalid">("yes"),
    [evidenceUri, setEvidenceUri] = useState(""),
    [evidenceHash, setEvidenceHash] = useState<number[] | null>(null);
  const evidenceRead = useRef(0);
  const tx = useClubTransaction(() => setRevision((v) => v + 1));
  const wallet = tx.wallet?.publicKey;

  useEffect(() => {
    if (!CLUBS_ENABLED) return;
    let dead = false;
    setLoadIssue(null);
    void (async () => {
      const value = await readClub(program, club);
      const owned = wallet
        ? await getOutcomiaAccounts(program).predictionPosition.fetchNullable(
            derivePredictionPositionPda(market, wallet),
          )
        : null;
      if (dead) return;
      setSnapshot(value);
      setPosition(owned);
      setLoaded(true);
    })().catch((e) => !dead && setLoadIssue(String(e)));
    return () => {
      dead = true;
    };
  }, [program, club, market, wallet, revision]);

  const row = snapshot?.markets.find((m) => m.address.equals(market));
  const gate = useFinalizeGate(
    row ? market : null,
    row?.market.proposal,
    row?.market.resolutionDelaySeconds,
    revision,
  );
  // Stable per snapshot, so the trading view does not refetch on every render.
  const trading = useMemo(
    () => (snapshot && row ? clubTrading(snapshot, row.binding) : null),
    [snapshot, row],
  );
  const me = wallet
    ? snapshot?.members.find((m) => m.wallet.equals(wallet))
    : undefined;
  const admin = !!me && isAdmin(me);
  const manager =
    admin || (!!me && !!row && me.wallet.equals(row.binding.creator));

  if (!CLUBS_ENABLED)
    return (
      <Shell clubAddress={clubAddress}>
        <div className="ui-notice">
          {t("Clubs are not enabled in this app configuration.")}
        </div>
      </Shell>
    );
  if (loadIssue)
    return (
      <Shell clubAddress={clubAddress}>
        <div className="ui-notice" role="alert">
          {t(loadIssue)}
        </div>
      </Shell>
    );
  if (!loaded || !snapshot)
    return (
      <Shell clubAddress={clubAddress}>
        <div className="ui-notice">{t("Loading club market…")}</div>
      </Shell>
    );
  if (!row || !trading)
    return (
      <Shell clubAddress={clubAddress}>
        <div className="ui-notice">
          {t("This market does not belong to this club.")}
        </div>
      </Shell>
    );

  const m = row.market;
  const status = predictionStatus(m);
  const decimals = m.payoutPerContract.toString().length - 1;
  const symbol = row.metadata?.quoteSymbol ?? "";
  const now = Math.floor(Date.now() / 1000);
  const nowBn = new BN(now);
  const tradingOpen = status === "open" && m.closeTs.gtn(now);
  const restricted = membersOnly(row.binding);
  const canEnter = !restricted || !!me;
  const earliest = m.earliestResolutionTs ?? m.closeTs;
  const maturity = m.proposal
    ? m.proposal.proposedAt.add(m.resolutionDelaySeconds)
    : null;
  const schedule = {
    closeTs: m.closeTs,
    earliestResolutionTs: m.earliestResolutionTs,
    resolutionDelaySeconds: m.resolutionDelaySeconds,
    fallbackPhase: false,
    fallbackAvailableTs: null,
  };
  const canPropose =
    admin &&
    (status === "open" || status === "frozen") &&
    nowBn.gte(m.closeTs) &&
    nowBn.gte(earliest);
  const canCorrect =
    admin && status === "proposed" && correctionOpen(schedule, maturity, nowBn);
  const finalOutcome = m.finalOutcome ? Object.keys(m.finalOutcome)[0] : null;

  const positionKey = wallet
    ? derivePredictionPositionPda(market, wallet)
    : null;
  /** Split needs membership in members-only markets; merge never does. */
  function completeSet(split: boolean) {
    if (!positionKey || !trading) return;
    void tx.run(async (p, signer) => [
      await clubCompleteSetInstruction(
        p,
        signer,
        trading,
        market,
        m.collateralMint,
        positionKey,
        parseTokenAmount(quantity, 0, "Quantity"),
        split,
      ),
    ]);
  }

  return (
    <Shell clubAddress={clubAddress}>
      <header className="ui-page-head club-head">
        <div>
          <p className="ui-eyebrow">{snapshot.club.name}</p>
          <h1 className="ui-title">
            {row.metadata?.displayName ?? marketAddress}
          </h1>
          <div className="club-head-meta">
            <span className="ui-badge ui-badge-accent">
              {t(STATUS_LABELS[status] ?? status)}
            </span>
            <span className="ui-badge">
              {restricted ? t("Members only") : t("Public")}
            </span>
            <span>
              {t("Trading close")}: {predictionTime(m.closeTs)}
            </span>
          </div>
        </div>
      </header>
      {restricted && !me && (
        <div className="ui-notice">
          {t(
            "Only club members can trade in this market. You can still cancel your orders, merge pairs and redeem.",
          )}
        </div>
      )}
      {/* Club fills replay into the shared binary history (indexer). */}
      <PredictionChart
        market={marketAddress}
        engine="SHARED_BINARY"
        priceDecimals={decimals}
        outcomes={["YES", "NO"]}
        binary
      />
      <div className="prediction-detail-grid">
        {canEnter && tradingOpen && (
          <SharedMarket
            view="trade"
            market={market}
            tradingOpen={tradingOpen}
            kind="prediction"
            authority={m.authority}
            quoteMint={m.collateralMint}
            quoteDecimals={decimals}
            quoteSymbol={symbol}
            club={trading}
            refreshKey={revision}
            onChanged={() => setRevision((v) => v + 1)}
          />
        )}
        <SharedMarket
          view="orders"
          market={market}
          tradingOpen={tradingOpen}
          kind="prediction"
          authority={m.authority}
          quoteMint={m.collateralMint}
          quoteDecimals={decimals}
          quoteSymbol={symbol}
          club={trading}
          refreshKey={revision}
          onChanged={() => setRevision((v) => v + 1)}
        />

        {wallet && (
          <section className="ui-card club-market-card" id="position">
            <h2 className="ui-h3">{t("Your position")}</h2>
            {position ? (
              <p>
                {t("YES")} {position.yesFree.toString()} · {t("NO")}{" "}
                {position.noFree.toString()}
                {(!position.yesLocked.isZero() ||
                  !position.noLocked.isZero()) &&
                  ` · ${t("in orders")}: ${position.yesLocked.add(position.noLocked).toString()}`}
              </p>
            ) : (
              <p>{t("No position in this market yet.")}</p>
            )}
            {position && positionKey && status !== "resolved" && (
              <div className="club-form">
                <label className="ui-field">
                  <span>{t("Contracts")}</span>
                  <input
                    className="ui-input"
                    value={quantity}
                    inputMode="numeric"
                    disabled={tx.pending}
                    onChange={(e) => setQuantity(e.target.value)}
                  />
                </label>
                <div className="ui-actions">
                  {canEnter && tradingOpen && (
                    <button
                      type="button"
                      className="ui-btn ui-btn-sm"
                      disabled={tx.pending || !quantity}
                      onClick={() => completeSet(true)}
                    >
                      {t("Split {value0} into YES + NO", {
                        value0: symbol,
                      })}
                    </button>
                  )}
                  <button
                    type="button"
                    className="ui-btn ui-btn-sm"
                    disabled={tx.pending || !quantity}
                    onClick={() => completeSet(false)}
                  >
                    {t("Merge YES + NO back to {value0}", { value0: symbol })}
                  </button>
                </div>
                <p>
                  {t(
                    "Splitting uses your shared {value0} balance; merging returns it. Each pair is backed by exactly 1 {value0}.",
                    { value0: symbol },
                  )}
                </p>
              </div>
            )}
            {position &&
              positionKey &&
              status === "resolved" &&
              (!position.yesFree.isZero() || !position.noFree.isZero()) && (
                <button
                  type="button"
                  className="ui-btn ui-btn-primary"
                  disabled={tx.pending}
                  onClick={() =>
                    void tx.run(async (p, signer) => [
                      await redeemClubPredictionInstruction(
                        p,
                        signer,
                        trading,
                        market,
                        m.collateralMint,
                        positionKey,
                        position.yesFree,
                        position.noFree,
                      ),
                    ])
                  }
                >
                  {t("Redeem all contracts")}
                </button>
              )}
          </section>
        )}

        <section className="ui-card club-market-card">
          <h2 className="ui-h3">{t("Resolution")}</h2>
          {finalOutcome && (
            <p>
              {t("Final outcome")}:{" "}
              {t(
                finalOutcome.toUpperCase() === "INVALID"
                  ? "Invalid"
                  : finalOutcome.toUpperCase(),
              )}
            </p>
          )}
          {m.proposal && !finalOutcome && (
            <p>
              {t("Proposed outcome")}:{" "}
              {t(
                "invalid" in m.proposal.outcome
                  ? "Invalid"
                  : "yes" in m.proposal.outcome
                    ? "YES"
                    : "NO",
              )}{" "}
              · {t("Finalizes after")}:{" "}
              {predictionTime(gate.at === null ? maturity : new BN(gate.at))}
            </p>
          )}
          <p>
            {t(
              "Any current club admin may propose or correct the outcome after trading closes. Anyone can finalize once the review delay ends.",
            )}
          </p>
          <div className="ui-actions">
            {manager && status === "open" && (
              <button
                type="button"
                className="ui-btn ui-btn-sm"
                disabled={tx.pending}
                onClick={() =>
                  void tx.run(async (p, signer) => [
                    await closeClubTradingInstruction(p, signer, club, market),
                  ])
                }
              >
                {t("Close trading now")}
              </button>
            )}
            {wallet && status === "open" && m.closeTs.lten(now) && (
              <button
                type="button"
                className="ui-btn ui-btn-sm"
                disabled={tx.pending}
                onClick={() =>
                  void tx.run(async (p) => [
                    await advanceClubPredictionInstruction(p, market, 0),
                  ])
                }
              >
                {t("Freeze at the close time")}
              </button>
            )}
            {wallet &&
              status === "proposed" &&
              gate.at !== null &&
              !gate.open &&
              gate.at <= now && (
                <button
                  type="button"
                  className="ui-btn ui-btn-primary"
                  disabled={tx.pending}
                  onClick={() =>
                    void tx.run(async (p) => [
                      await advanceClubPredictionInstruction(p, market, 2),
                    ])
                  }
                >
                  {t("Finalize outcome")}
                </button>
              )}
          </div>
          {(canPropose || canCorrect) && (
            <div className="club-form">
              <label className="ui-field">
                <span>{t("Outcome")}</span>
                <select
                  className="ui-select"
                  value={outcome}
                  disabled={tx.pending}
                  onChange={(e) =>
                    setOutcome(e.target.value as "yes" | "no" | "invalid")
                  }
                >
                  <option value="yes">{t("YES")}</option>
                  <option value="no">{t("NO")}</option>
                  <option value="invalid">{t("Invalid")}</option>
                </select>
              </label>
              <label className="ui-field">
                <span>{t("Evidence reference")}</span>
                <input
                  className="ui-input"
                  value={evidenceUri}
                  disabled={tx.pending}
                  onChange={(e) => setEvidenceUri(e.target.value)}
                  placeholder="ar://…"
                />
              </label>
              <label className="ui-field">
                <span>{t("Exact evidence file")}</span>
                <input
                  className="ui-input"
                  type="file"
                  disabled={tx.pending}
                  onChange={(e) => {
                    setEvidenceHash(null);
                    const file = e.target.files?.[0];
                    const version = ++evidenceRead.current;
                    if (file)
                      void file
                        .arrayBuffer()
                        .then((bytes) => crypto.subtle.digest("SHA-256", bytes))
                        .then((digest) => {
                          if (version === evidenceRead.current)
                            setEvidenceHash(Array.from(new Uint8Array(digest)));
                        })
                        .catch((cause) => tx.setIssue(String(cause)));
                  }}
                />
              </label>
              <button
                type="button"
                className="ui-btn ui-btn-primary"
                disabled={tx.pending || !evidenceUri || !evidenceHash}
                onClick={() =>
                  void tx.run(async (p, signer) => [
                    await proposeClubPredictionInstruction(
                      p,
                      signer,
                      club,
                      market,
                      outcome,
                      evidenceUri.trim(),
                      evidenceHash!,
                      status === "proposed",
                    ),
                  ])
                }
              >
                {status === "proposed"
                  ? t("Correct proposal")
                  : t("Propose outcome")}
              </button>
            </div>
          )}
        </section>
        <MarketDispute
          family="binary"
          address={market}
          market={binaryDisputedMarket(m)}
          club={club}
          onChanged={() => setRevision((v) => v + 1)}
        />
        <ClubFeedback issue={tx.issue} signature={tx.signature} />
      </div>
      <p className="club-muted club-market-foot">
        {t("Collateral reserve")}: {readableAmount(m.backingReserve, decimals)}{" "}
        {symbol} · {t(clubRoleText(clubRole(snapshot.club, me)))}
      </p>
    </Shell>
  );
}

const clubRoleText = (role: ReturnType<typeof clubRole>) =>
  role === "owner"
    ? "You own this club"
    : role === "admin"
      ? "You are a club admin"
      : role === "member"
        ? "You are a club member"
        : "You are not a club member";

function Shell({
  clubAddress,
  children,
}: {
  clubAddress: string;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div className="app-shell">
      <AppHeader />
      <main className="route-shell prediction-detail-route club-page">
        <Link className="club-back" href={`/clubs/${clubAddress}`}>
          {t("← Club")}
        </Link>
        {children}
      </main>
    </div>
  );
}
