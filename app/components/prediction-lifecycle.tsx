"use client";
import { useI18n } from "./preferences-provider";

import { useEffect, useMemo, useState } from "react";
import { AnchorProvider, BN } from "@anchor-lang/core";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction } from "@solana/web3.js";
import {
  PREDICTION_OPENING_ENABLED,
  predictionOpeningIssue,
  predictionStatus,
  type PredictionMarketAccount,
} from "../lib/prediction";
import {
  getOutcomiaAccounts,
  deriveAdminRecordPda,
  getOutcomiaProgram,
  transactionExplorerUrl,
} from "../lib/outcomia";
import { useProtocolRole } from "./protocol-role-provider";

interface Props {
  address: PublicKey;
  market: PredictionMarketAccount;
  onOpened: (market: PredictionMarketAccount) => void;
}

/** Hydration-safe creator controls; both ownership and active admin status are needed. */
export function PredictionLifecycle(props: Props) {
  const wallet = useAnchorWallet();
  const { connection } = useConnection();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted || !wallet || !wallet.publicKey.equals(props.market.authority))
    return null;
  return (
    <ConnectedLifecycle
      key={`${connection.rpcEndpoint}:${props.address.toBase58()}:${wallet.publicKey.toBase58()}`}
      {...props}
      wallet={wallet}
    />
  );
}

function ConnectedLifecycle({
  address,
  market,
  onOpened,
  wallet,
}: Props & {
  wallet: NonNullable<ReturnType<typeof useAnchorWallet>>;
}) {
  const { t } = useI18n();

  const { connection } = useConnection();
  const program = useMemo(
    () => getOutcomiaProgram(connection, wallet),
    [connection, wallet],
  );
  const [pending, setPending] = useState(false);
  const { role, loading: roleLoading, error: roleError } = useProtocolRole();
  const activeAdmin =
    !roleLoading && !roleError && (role === "admin" || role === "super-admin");
  const [error, setError] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const timer = setInterval(
      () => setNow(Math.floor(Date.now() / 1000)),
      1000,
    );
    return () => clearInterval(timer);
  }, []);
  const draft = predictionStatus(market) === "draft";
  const issue = predictionOpeningIssue(
    market,
    wallet.publicKey,
    new BN(now),
    activeAdmin,
  );
  const canOpen =
    PREDICTION_OPENING_ENABLED && !issue && !pending && !signature;

  async function open() {
    if (!canOpen) return;
    setPending(true);
    setError(null);
    try {
      // A displayed draft may have expired or opened elsewhere. Re-read before
      // asking for a signature, then let the instruction check again atomically.
      const accounts = getOutcomiaAccounts(program);
      const latest = await accounts.predictionMarket.fetchNullable(address);
      if (!latest) throw new Error("Prediction market was not found");
      const problem = predictionOpeningIssue(
        latest,
        wallet.publicKey,
        new BN(Math.floor(Date.now() / 1000)),
        activeAdmin,
      );
      if (problem) throw new Error(problem);
      // UI role state can be stale after revocation. Read the canonical record
      // before asking for a signature; the instruction independently checks it.
      const adminRecord = deriveAdminRecordPda(wallet.publicKey);
      const admin = await accounts.adminRecord.fetchNullable(adminRecord);
      if (
        !admin ||
        !admin.authority.equals(wallet.publicKey) ||
        !("active" in admin.status)
      )
        throw new Error(
          "An active administrator role is required to open this draft",
        );
      const ix = await program.methods
        .openPredictionMarket()
        .accounts({ authority: wallet.publicKey, market: address, adminRecord })
        .instruction();
      const confirmed = await (
        program.provider as AnchorProvider
      ).sendAndConfirm(new Transaction().add(ix));
      setSignature(confirmed);
      try {
        const updated = await accounts.predictionMarket.fetchNullable(address);
        if (!updated) throw new Error("Market account unavailable");
        onOpened(updated);
      } catch {
        // A failed post-confirmation read must not turn a confirmed transaction
        // into a reported failure or a fabricated local status.
        setError(
          "Opening confirmed. Refresh market terms to load the updated status.",
        );
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Opening failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="admin-card" aria-busy={pending}>
      <h2>{t("Market authority")}</h2>
      {draft ? (
        <>
          <p>{t("Rules and deadlines are fixed when the draft is created.")}</p>
          {!PREDICTION_OPENING_ENABLED && (
            <p>
              {t(
                "Opening prediction markets is disabled in this app configuration.",
              )}
            </p>
          )}
          {roleLoading ? (
            <p>{t("Checking administrator role…")}</p>
          ) : (
            issue && <p>{t(issue ?? "")}</p>
          )}
          {roleError && <p role="alert">{t(roleError ?? "")}</p>}
          <button
            className="primary-button"
            type="button"
            disabled={!canOpen}
            onClick={() => void open()}
          >
            {pending
              ? t("Opening…")
              : signature
                ? t("Confirmed; refresh market")
                : t("Open market")}
          </button>
        </>
      ) : (
        <p>
          {t("This market is {value0}. Only a draft can be opened.", {
            value0: predictionStatus(market),
          })}
        </p>
      )}
      {error && (
        <p className="access-denied" role="alert">
          {t(error ?? "")}
        </p>
      )}
      {signature && (
        <p className="transaction-message transaction-success">
          {t("Market opening confirmed.")}{" "}
          <a
            href={transactionExplorerUrl(signature)}
            target="_blank"
            rel="noreferrer"
          >
            {t("View transaction ↗")}
          </a>
        </p>
      )}
    </section>
  );
}
