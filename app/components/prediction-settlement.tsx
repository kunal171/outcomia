"use client";
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
  predictionTime,
  type PredictionMarketAccount,
  type PredictionPositionAccount,
} from "../lib/prediction";
import { readableAmount } from "../lib/market-display";
import { useProtocolRole } from "./protocol-role-provider";
interface Props {
  address: PublicKey;
  market: PredictionMarketAccount;
  symbol: string;
  onChanged: () => void;
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
function Settlement({ address, market, symbol, onChanged }: Props) {
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
    [quantity, setQuantity] = useState(""),
    [yes, setYes] = useState(""),
    [no, setNo] = useState(""),
    [outcome, setOutcome] = useState("yes"),
    [uri, setUri] = useState(""),
    [hash, setHash] = useState<number[] | null>(null),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    let dead = false;
    if (wallet)
      void getTidebookAccounts(p)
        .predictionPosition.fetchNullable(
          derivePredictionPositionPda(address, wallet.publicKey),
        )
        .then((v) => {
          if (!dead) setPosition(v);
        })
        .catch((e) => {
          if (!dead) setIssue(String(e));
        });
    return () => {
      dead = true;
    };
  }, [p, wallet, address, revision]);
  const evidenceRead = useRef(0);
  const [now, setNow] = useState(() => new BN(Math.floor(Date.now() / 1000)));
  useEffect(() => {
    const timer = setInterval(
      () => setNow(new BN(Math.floor(Date.now() / 1000))),
      1000,
    );
    return () => clearInterval(timer);
  }, []);
  const status = predictionStatus(market),
    decimals = market.payoutPerContract.toString().length - 1;
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
  const whole = (s: string) => {
    if (!/^\d+$/.test(s)) throw new Error("Use whole contract quantities");
    const n = new BN(s);
    if (n.bitLength() > 64) throw new Error("Quantity exceeds u64");
    return n;
  };
  let canRedeem = false,
    positivePairs = false,
    canMerge = false;
  try {
    const y = whole(yes || "0"),
      n = whole(no || "0");
    canRedeem =
      !!position &&
      (y.gtn(0) || n.gtn(0)) &&
      y.lte(position.yesFree) &&
      n.lte(position.noFree);
    const pairs = whole(quantity || "0");
    positivePairs = pairs.gtn(0);
    canMerge =
      positivePairs &&
      !!position &&
      pairs.lte(position.yesFree) &&
      pairs.lte(position.noFree);
  } catch {
    /* Invalid or overflowing input is never actionable. */
  }
  async function act(action: string) {
    if (!wallet) return;
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
                  whole(yes || "0"),
                  whole(no || "0"),
                )
              : signed.methods.sharedCompleteSet(
                  whole(quantity),
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
      setYes("");
      setNo("");
      setQuantity("");
      onChanged();
    } catch (e) {
      setIssue(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  }
  const maturity = market.proposal
    ? market.proposal.proposedAt.add(market.resolutionDelaySeconds)
    : null;
  return (
    <section className="admin-card prediction-settlement">
      <span className="eyebrow">Resolution & payouts</span>
      <h2>
        {status === "resolved"
          ? `Final outcome: ${Object.keys(market.finalOutcome ?? {})[0]?.toUpperCase()}`
          : "Published resolution process"}
      </h2>
      <p>
        One winning contract pays{" "}
        {readableAmount(market.payoutPerContract, decimals)} {symbol}. Invalid
        pays half to each outcome. Final payouts go to your shared wallet.
      </p>
      <p>
        Trading cutoff: {predictionTime(market.closeTs)} · Earliest proposal:{" "}
        {predictionTime(market.earliestResolutionTs ?? market.closeTs)}
      </p>
      {market.proposal && (
        <p>
          Proposed:{" "}
          <strong>
            {Object.keys(market.proposal.outcome)[0].toUpperCase()}
          </strong>{" "}
          · Finalizable after {predictionTime(maturity!)} · Evidence:{" "}
          <span className="shared-address">{market.proposal.evidenceUri}</span>{" "}
          · SHA-256:{" "}
          <code className="shared-address">
            {Buffer.from(market.proposal.evidenceHash).toString("hex")}
          </code>
        </p>
      )}
      {wallet && (
        <>
          <div className="shared-actions">
            {status === "open" && (
              <>
                <button
                  disabled={pending || now.lt(market.closeTs)}
                  onClick={() => void act("freeze")}
                >
                  Freeze at cutoff
                </button>
                {wallet.publicKey.equals(market.authority) &&
                  (role.role === "admin" || role.role === "super-admin") && (
                    <button
                      disabled={pending}
                      onClick={() => void act("close")}
                    >
                      Close trading early
                    </button>
                  )}
              </>
            )}
            {market.fallback && status !== "resolved" && (
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
                  Activate published fallback
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
                    Finalize expired fallback as Invalid
                  </button>
                )}
              </>
            )}
            {status === "proposed" && (
              <button
                disabled={pending || !maturity || now.lt(maturity)}
                onClick={() => void act("finalize")}
              >
                Finalize after review delay
              </button>
            )}
          </div>
          {canPropose && status !== "resolved" && (
            <details>
              <summary>Resolver: propose or correct outcome</summary>
              <p>
                Requires your active admin record. Upload evidence
                independently, then enter its permanent reference. A correction
                restarts the full delay.
              </p>
              <label>
                Outcome
                <select
                  value={outcome}
                  onChange={(e) => setOutcome(e.target.value)}
                >
                  <option value="yes">YES</option>
                  <option value="no">NO</option>
                  <option value="invalid">Invalid</option>
                </select>
              </label>
              <label>
                Evidence reference
                <input
                  value={uri}
                  onChange={(e) => setUri(e.target.value)}
                  placeholder="ar://…"
                />
              </label>
              <label>
                Exact evidence file
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
                        .then((bytes) => crypto.subtle.digest("SHA-256", bytes))
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
                {status === "proposed" ? "Correct proposal" : "Propose outcome"}
              </button>
            </details>
          )}
          {position && (
            <p>
              Your free contracts: {position.yesFree.toString()} YES ·{" "}
              {position.noFree.toString()} NO. Locked contracts must be canceled
              before redemption.
            </p>
          )}
          {SHARED_BALANCES_ENABLED && status !== "resolved" && (
            <>
              <label>
                Complete pairs
                <input
                  inputMode="numeric"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                />
              </label>
              <div className="shared-actions">
                <button
                  disabled={
                    pending ||
                    status !== "open" ||
                    now.gte(market.closeTs) ||
                    !positivePairs
                  }
                  onClick={() => void act("split")}
                >
                  Create YES + NO pairs
                </button>
                <button
                  disabled={pending || !canMerge}
                  onClick={() => void act("merge")}
                >
                  Merge free pairs
                </button>
              </div>
            </>
          )}
          {SHARED_BALANCES_ENABLED && status === "resolved" && (
            <>
              <label>
                YES contracts to redeem
                <input
                  inputMode="numeric"
                  value={yes}
                  onChange={(e) => setYes(e.target.value)}
                />
              </label>
              <label>
                NO contracts to redeem
                <input
                  inputMode="numeric"
                  value={no}
                  onChange={(e) => setNo(e.target.value)}
                />
              </label>
              <button
                disabled={pending || !canRedeem}
                onClick={() => void act("redeem")}
              >
                Redeem selected free contracts
              </button>
            </>
          )}
        </>
      )}
      {!wallet && <p>Connect your wallet to finalize or claim.</p>}
      {issue && <p role="alert">{issue}</p>}
      {signature && (
        <a
          href={transactionExplorerUrl(signature)}
          target="_blank"
          rel="noreferrer"
        >
          View transaction ↗
        </a>
      )}
    </section>
  );
}
