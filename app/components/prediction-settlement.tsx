"use client";
import { useI18n } from "./preferences-provider";

/** Resolution and owner redemption use different authorization paths on chain. */
import { useEffect, useMemo, useState, useRef } from "react";
import { AnchorProvider, BN } from "@anchor-lang/core";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  PREDICTION_RESOLUTION_ENABLED,
  SHARED_BALANCES_ENABLED,
  assetCustody,
  assetAuthorityPda,
  assetBalancePda,
  assetVaultPda,
  sharedAccounts,
  variant,
} from "../lib/shared";
import {
  getTidebookProgram,
  getTidebookReadProgram,
  getTidebookAccounts,
  deriveAdminRecordPda,
  deriveVaultAuthorityPda,
  TOKEN_PROGRAM_ID,
  transactionExplorerUrl,
} from "../lib/tidebook";
import {
  derivePredictionPositionPda,
  predictionStatus,
  type PredictionMarketAccount,
  type PredictionPositionAccount,
} from "../lib/prediction";
import {
  PredictionPositionActions,
  type PositionAmounts,
} from "./prediction/position-actions";
import { PredictionResolutionSummary } from "./prediction/resolution-summary";
import { predictionCloseLabel } from "../lib/prediction-display";
import { useProtocolRole } from "./protocol-role-provider";
interface Props {
  address: PublicKey;
  market: PredictionMarketAccount;
  symbol: string;
  onChanged: () => void;
  view?: "all" | "position" | "resolution" | "manage";
}
export function PredictionSettlement(props: Props) {
  const wallet = useAnchorWallet(),
    { connection } = useConnection();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted || !PREDICTION_RESOLUTION_ENABLED) return null;
  return (
    <Settlement
      key={`${connection.rpcEndpoint}:${wallet?.publicKey ?? "public"}:${props.address}`}
      {...props}
    />
  );
}
function Settlement({
  address,
  market,
  symbol,
  onChanged,
  view = "all",
}: Props) {
  const { t } = useI18n();

  const wallet = useAnchorWallet(),
    { connection } = useConnection(),
    role = useProtocolRole();
  const p = useMemo(() => getTidebookReadProgram(connection), [connection]);
  const [position, setPosition] = useState<PredictionPositionAccount | null>(
      null,
    ),
    [pending, setPending] = useState(false),
    [issue, setIssue] = useState<string | null>(null),
    [signature, setSignature] = useState<string | null>(null),
    [outcome, setOutcome] = useState("yes"),
    [uri, setUri] = useState(""),
    [hash, setHash] = useState<number[] | null>(null),
    [revision, setRevision] = useState(0),
    [positionLoaded, setPositionLoaded] = useState(false);
  useEffect(() => {
    let dead = false;
    if (wallet && (view === "position" || view === "all")) {
      setPositionLoaded(false);
      void getTidebookAccounts(p)
        .predictionPosition.fetchNullable(
          derivePredictionPositionPda(address, wallet.publicKey),
        )
        .then((v) => {
          if (!dead) {
            setPosition(v);
            setPositionLoaded(true);
          }
        })
        .catch((e) => {
          if (!dead) setIssue(String(e));
        });
    }
    return () => {
      dead = true;
    };
  }, [p, wallet, address, revision, market, view]);
  const evidenceRead = useRef(0);
  const [now, setNow] = useState(() => new BN(Math.floor(Date.now() / 1000)));
  useEffect(() => {
    const timer = setInterval(
      () => setNow(new BN(Math.floor(Date.now() / 1000))),
      1000,
    );
    return () => clearInterval(timer);
  }, []);
  const status = predictionStatus(market);
  const resolver =
    "fallback" in market.resolutionPhase
      ? market.fallback?.resolver
      : market.resolver;
  const canPropose =
    wallet &&
    resolver?.equals(wallet.publicKey) &&
    (role.role === "admin" || role.role === "super-admin");
  const earliest = BN.max(
    market.closeTs,
    market.earliestResolutionTs ?? market.closeTs,
  );
  const proposalWindow =
    now.gte(earliest) &&
    ("fallback" in market.resolutionPhase
      ? !!market.fallback &&
        now.gte(market.fallback.availableTs) &&
        (!market.fallback.deadlineTs || now.lt(market.fallback.deadlineTs))
      : !market.fallback || now.lt(market.fallback.availableTs));
  async function act(
    action: string,
    amounts?: PositionAmounts,
  ): Promise<boolean> {
    if (!wallet) return false;
    setPending(true);
    setIssue(null);
    setSignature(null);
    try {
      const signed = getTidebookProgram(connection, wallet),
        tx = new Transaction();
      if (action === "propose") {
        if (!hash) throw new Error("Choose the exact evidence file to hash");
        tx.add(
          await signed.methods
            .proposePrediction(
              variant(outcome),
              uri,
              hash,
              status === "proposed",
            )
            .accountsPartial({
              resolver: wallet.publicKey,
              market: address,
              adminRecord: deriveAdminRecordPda(wallet.publicKey),
            })
            .instruction(),
        );
      } else if (action === "close")
        tx.add(
          await signed.methods
            .closePredictionTrading()
            .accountsPartial({
              resolver: wallet.publicKey,
              market: address,
              adminRecord: deriveAdminRecordPda(wallet.publicKey),
            })
            .instruction(),
        );
      else if (["freeze", "fallback", "finalize", "timeout"].includes(action))
        tx.add(
          await signed.methods
            .advancePrediction(
              (
                { freeze: 0, fallback: 1, finalize: 2, timeout: 3 } as Record<
                  string,
                  number
                >
              )[action],
            )
            .accountsPartial({ market: address })
            .instruction(),
        );
      else {
        if (!SHARED_BALANCES_ENABLED)
          throw new Error("Enable shared custody after deploying the upgrade");
        const c = assetCustody(wallet.publicKey, market.collateralMint);
        if (
          !(await sharedAccounts(signed).assetBalance.fetchNullable(
            c.assetBalance,
          ))
        )
          tx.add(
            await signed.methods
              .initializeAssetBalance()
              .accountsPartial({
                ...c,
                tokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
              })
              .instruction(),
          );
        const pos = derivePredictionPositionPda(address, wallet.publicKey);
        if (!position)
          tx.add(
            await signed.methods
              .initializePredictionPosition()
              .accountsPartial({
                owner: wallet.publicKey,
                market: address,
                position: pos,
                systemProgram: SystemProgram.programId,
              })
              .instruction(),
          );
        const accounts = {
          owner: wallet.publicKey,
          market: address,
          position: pos,
          mint: market.collateralMint,
          assetBalance: assetBalancePda(
            wallet.publicKey,
            market.collateralMint,
          ),
          assetAuthority: assetAuthorityPda(market.collateralMint),
          assetVault: assetVaultPda(market.collateralMint),
          marketAuthority: deriveVaultAuthorityPda(address),
          marketVault: market.collateralVault,
          tokenProgram: TOKEN_PROGRAM_ID,
        };
        tx.add(
          await (
            action === "redeem"
              ? signed.methods.redeemPrediction(
                  amounts?.yes ?? new BN(0),
                  amounts?.no ?? new BN(0),
                )
              : signed.methods.sharedCompleteSet(
                  amounts?.quantity ?? new BN(0),
                  action === "split",
                )
          )
            .accountsPartial(accounts)
            .instruction(),
        );
      }
      setSignature(
        await (signed.provider as AnchorProvider).sendAndConfirm(tx),
      );
      setRevision((v) => v + 1);
      onChanged();
      return true;
    } catch (e) {
      setIssue(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setPending(false);
    }
  }
  const maturity = market.proposal
    ? market.proposal.proposedAt.add(market.resolutionDelaySeconds)
    : null;
  return (
    <section className="admin-card prediction-settlement">
      <h2>
        {view === "position" && status !== "resolved"
          ? t("Your position")
          : view === "manage"
            ? t("Resolve this market")
            : status === "resolved"
              ? t("Final outcome: {value0}", {
                  value0: Object.keys(
                    market.finalOutcome ?? {},
                  )[0]?.toUpperCase(),
                })
              : t("Resolution")}
      </h2>
      {view === "manage" && status !== "resolved" && (
        <p>
          {t("Proposal opens {value0}.", {
            value0: predictionCloseLabel(earliest),
          })}
        </p>
      )}
      {view !== "position" && <PredictionResolutionSummary market={market} />}
      {wallet && (
        <>
          {view !== "position" && (
            <div className="shared-actions">
              {status === "open" &&
                (now.gte(market.closeTs) ||
                  view === "manage" ||
                  view === "all") && (
                  <>
                    {now.gte(market.closeTs) && (
                      <button
                        disabled={pending || now.lt(market.closeTs)}
                        onClick={() => void act("freeze")}
                      >
                        {t("Close trading at cutoff")}
                      </button>
                    )}
                    {(view === "manage" || view === "all") &&
                      wallet.publicKey.equals(market.authority) &&
                      (role.role === "admin" ||
                        role.role === "super-admin") && (
                        <button
                          disabled={pending}
                          onClick={() => void act("close")}
                        >
                          {t("Close trading early")}
                        </button>
                      )}
                  </>
                )}
              {market.fallback &&
                status !== "resolved" &&
                status !== "draft" && (
                  <>
                    <button
                      disabled={
                        pending ||
                        !!market.proposal ||
                        "fallback" in market.resolutionPhase ||
                        !market.fallback ||
                        now.lt(market.fallback.availableTs) ||
                        (!!market.fallback.deadlineTs &&
                          now.gte(market.fallback.deadlineTs))
                      }
                      onClick={() => void act("fallback")}
                    >
                      {t("Activate published fallback")}
                    </button>
                    {market.fallback.deadlineTs && (
                      <button
                        disabled={
                          pending ||
                          !!market.proposal ||
                          !market.fallback?.deadlineTs ||
                          now.lt(market.fallback.deadlineTs)
                        }
                        onClick={() => void act("timeout")}
                      >
                        {t("Finalize expired fallback as Invalid")}
                      </button>
                    )}
                  </>
                )}
              {status === "proposed" && (
                <button
                  disabled={pending || !maturity || now.lt(maturity)}
                  onClick={() => void act("finalize")}
                >
                  {t("Finalize after review delay")}
                </button>
              )}
            </div>
          )}
          {(view === "manage" || view === "all") &&
            canPropose &&
            status !== "resolved" &&
            status !== "draft" && (
              <details>
                <summary>{t("Resolver: propose or correct outcome")}</summary>
                <p>
                  {t(
                    "Requires your active admin record. Upload evidence independently, then enter its permanent reference. A correction restarts the full delay.",
                  )}
                </p>
                <label>
                  {t("Outcome")}
                  <select
                    value={outcome}
                    onChange={(e) => setOutcome(e.target.value)}
                  >
                    <option value="yes">{t("YES")}</option>
                    <option value="no">{t("NO")}</option>
                    <option value="invalid">{t("Invalid")}</option>
                  </select>
                </label>
                <label>
                  {t("Evidence reference")}
                  <input
                    value={uri}
                    onChange={(e) => setUri(e.target.value)}
                    placeholder="ar://…"
                  />
                </label>
                <label>
                  {t("Exact evidence file")}
                  <input
                    type="file"
                    disabled={pending}
                    onChange={(e) => {
                      setHash(null);
                      const file = e.target.files?.[0];
                      const readVersion = ++evidenceRead.current;
                      if (file)
                        void file
                          .arrayBuffer()
                          .then((bytes) =>
                            crypto.subtle.digest("SHA-256", bytes),
                          )
                          .then((d) => {
                            if (readVersion === evidenceRead.current)
                              setHash(Array.from(new Uint8Array(d)));
                          })
                          .catch((e) => setIssue(String(e)));
                    }}
                  />
                </label>
                <button
                  disabled={
                    pending ||
                    !hash ||
                    !uri ||
                    !proposalWindow ||
                    (status === "proposed" && !!maturity && now.gte(maturity))
                  }
                  onClick={() => void act("propose")}
                >
                  {status === "proposed"
                    ? t("Correct proposal")
                    : t("Propose outcome")}
                </button>
              </details>
            )}
          {(view === "position" || view === "all") && (
            <PredictionPositionActions
              market={market}
              status={status}
              position={position}
              loaded={positionLoaded}
              failed={!!issue}
              pending={pending}
              now={now}
              symbol={symbol}
              onAction={act}
            />
          )}
        </>
      )}
      {!wallet && (
        <p>
          {view === "position"
            ? t("Connect your wallet to see your contracts and claims.")
            : t("Connect your wallet to use available resolution actions.")}
        </p>
      )}
      {issue && <p role="alert">{t(issue ?? "")}</p>}
      {signature && (
        <a
          href={transactionExplorerUrl(signature)}
          target="_blank"
          rel="noreferrer"
        >
          {t("View transaction ↗")}
        </a>
      )}
    </section>
  );
}
