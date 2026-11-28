"use client";
import { useI18n } from "./preferences-provider";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { AnchorProvider, BN } from "@anchor-lang/core";
import {
  useAnchorWallet,
  useConnection,
  useWallet,
} from "@solana/wallet-adapter-react";
import { getMint } from "@solana/spl-token";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { AppHeader } from "./app-header";
import { useProtocolRole } from "./protocol-role-provider";
import { PredictionRulesEditor } from "./prediction-rules-editor";
import {
  initialPredictionRulesDraft,
  serializePredictionRulesDraft,
} from "../lib/prediction-rules-draft";
import {
  uploadArweaveRules,
  verifyArweaveRules,
  RULES_GATEWAY,
  type ArweaveRulesUpload,
} from "../lib/arweave-rules";
import {
  derivePredictionMarketPda,
  derivePredictionBookPda,
  parsePredictionRules,
  PREDICTION_DRAFTS_ENABLED,
  validatePredictionCreatorResolver,
} from "../lib/prediction";
import {
  deriveAdminRecordPda,
  deriveMarketFeesPda,
  deriveMarketMetadataPda,
  deriveVaultAuthorityPda,
  deriveVaultPda,
  getOutcomiaProgram,
  getOutcomiaReadProgram,
  getOutcomiaAccounts,
  parseTokenAmount,
  TOKEN_PROGRAM_ID,
  transactionExplorerUrl,
} from "../lib/outcomia";
import {
  canCreateClubMarket,
  clubAccounts,
  clubMarketHref,
  createClubMarketInstructions,
  readClub,
  readClubRules,
} from "../lib/clubs";
import { clubMarketPriceAccount } from "../lib/club-deposits";

/** Public markets need an active protocol admin. With `club`, any member the
 * club's policy allows creates a club market instead; club admins resolve it. */
export function CreatePredictionMarket({ club }: { club?: string } = {}) {
  const { t } = useI18n();
  const clubKey = useMemo(() => (club ? new PublicKey(club) : null), [club]);

  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const { signMessage } = useWallet();
  const creator = wallet?.publicKey.toBase58() ?? "";
  const currentCreator = useRef(creator);
  currentCreator.current = creator;
  const {
    role,
    loading: roleLoading,
    error: protocolRoleError,
  } = useProtocolRole();
  const [clubAccess, setClubAccess] = useState<{
    name: string;
    allowed: boolean;
  } | null>(null);
  const [publicAccess, setPublicAccess] = useState(false);
  // Why the club cannot create markets right now (deposit), if anything.
  const [depositIssue, setDepositIssue] = useState<string | null>(null);
  useEffect(() => {
    if (!clubKey) return;
    let dead = false;
    const reader = getOutcomiaReadProgram(connection);
    void Promise.all([
      clubAccounts(reader).club.fetchNullable(clubKey),
      readClubRules(reader),
    ])
      .then(([account, clubRules]) =>
        account ? clubMarketPriceAccount(connection, account, clubRules) : null,
      )
      .then(() => !dead && setDepositIssue(null))
      .catch(
        (cause) =>
          !dead &&
          setDepositIssue(cause instanceof Error ? cause.message : String(cause)),
      );
    return () => {
      dead = true;
    };
  }, [clubKey, connection]);
  useEffect(() => {
    if (!clubKey || !wallet) return;
    let dead = false;
    void readClub(getOutcomiaReadProgram(connection), clubKey)
      .then((snapshot) => {
        if (dead) return;
        const member = snapshot?.members.find((m) =>
          m.wallet.equals(wallet.publicKey),
        );
        setClubAccess(
          snapshot
            ? {
                name: snapshot.club.name,
                allowed: canCreateClubMarket(snapshot.club, member),
              }
            : { name: "", allowed: false },
        );
      })
      .catch(() => !dead && setClubAccess({ name: "", allowed: false }));
    return () => {
      dead = true;
    };
  }, [clubKey, wallet, connection]);
  const loading = clubKey ? !!wallet && !clubAccess : roleLoading;
  const roleError = clubKey ? null : protocolRoleError;
  const isAdmin = clubKey
    ? !!clubAccess?.allowed
    : !roleLoading && (role === "admin" || role === "super-admin");
  const program = useMemo(
    () => (wallet ? getOutcomiaProgram(connection, wallet) : null),
    [connection, wallet],
  );
  const [name, setName] = useState("");
  const [mint, setMint] = useState("");
  const [symbol, setSymbol] = useState("");
  const [tick, setTick] = useState("0.01");
  const [draft, setDraft] = useState(initialPredictionRulesDraft);
  const [reviewedContent, setReviewedContent] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState<ArweaveRulesUpload | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const preview = useMemo(() => {
    try {
      return {
        json: serializePredictionRulesDraft(draft, creator),
        issue: null,
      };
    } catch (cause) {
      return {
        json: null,
        issue: cause instanceof Error ? cause.message : "Invalid rules",
      };
    }
  }, [draft, creator]);
  const reviewed = preview.json !== null && reviewedContent === preview.json;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    market: string;
    signature: string;
  } | null>(null);

  /** The price account a club market needs now (null for USDC deposits),
   * or an error explaining why the club cannot create markets. */
  async function clubPrice(key: PublicKey) {
    const reader = getOutcomiaReadProgram(connection);
    const [account, clubRules] = await Promise.all([
      clubAccounts(reader).club.fetchNullable(key),
      readClubRules(reader),
    ]);
    if (!account) throw new Error("This club was not found on this network.");
    return clubMarketPriceAccount(connection, account, clubRules);
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !PREDICTION_DRAFTS_ENABLED ||
      !isAdmin ||
      !program ||
      !wallet ||
      pending
    )
      return;
    setPending(true);
    setStage("Validating market and rules…");
    setError(null);
    setResult(null);
    try {
      if (!reviewed)
        throw new Error("Review the rules and public upload before continuing");
      if (!signMessage)
        throw new Error(
          "Choose a wallet that supports message signing for Arweave uploads",
        );
      if (!preview.json) throw new Error(preview.issue ?? "Complete the rules");
      const content = preview.json;
      if (!/^[\x20-\x7e]{1,64}$/.test(name) || name.trim() !== name)
        throw new Error(
          "Use a short name of 1–64 printable ASCII characters without outer spaces",
        );
      if (!/^[A-Za-z0-9._-]{1,16}$/.test(symbol))
        throw new Error(
          "Collateral symbol must contain 1–16 letters, digits, '.', '-' or '_'",
        );
      const rules = await parsePredictionRules(
        new TextEncoder().encode(content).buffer,
      );
      validatePredictionCreatorResolver(rules.resolver, wallet.publicKey);
      if (clubKey && rules.fallback)
        throw new Error(
          "Club markets have no fallback resolver; club admins resolve them",
        );
      if (rules.closeTs.lte(new BN(String(Math.floor(Date.now() / 1000)))))
        throw new Error("Trading close time must be in the future");
      if (!clubKey) {
        const admin = await getOutcomiaAccounts(
          program,
        ).adminRecord.fetchNullable(deriveAdminRecordPda(wallet.publicKey));
        if (
          !admin ||
          !admin.authority.equals(wallet.publicKey) ||
          !("active" in admin.status)
        )
          throw new Error(
            "An active administrator record is required before uploading rules",
          );
      }
      // Check the club's deposit before the paid rules upload.
      if (clubKey) await clubPrice(clubKey);
      const collateralMint = new PublicKey(mint.trim());
      const mintAccount = await getMint(
        connection,
        collateralMint,
        "confirmed",
        TOKEN_PROGRAM_ID,
      );
      const payout = parseTokenAmount(
        "1",
        mintAccount.decimals,
        "Contract payout",
      );
      const priceTick = parseTokenAmount(
        tick,
        mintAccount.decimals,
        "Price tick",
      );
      if (
        payout.isOdd() ||
        priceTick.lten(0) ||
        priceTick.gte(payout) ||
        !payout.mod(priceTick).isZero()
      )
        throw new Error(
          "Use a collateral mint with decimals and a tick below 1 that divides 1 exactly",
        );
      const assertCreator = () => {
        if (currentCreator.current !== creator)
          throw new Error(
            "Wallet changed. Reconnect the creator wallet before retrying.",
          );
      };
      assertCreator();
      let upload =
        uploaded?.content === content && uploaded.owner === creator
          ? uploaded
          : null;
      if (!upload) {
        setStage("Approve the rules upload in your wallet…");
        upload = await uploadArweaveRules(content, {
          publicKey: wallet.publicKey,
          signMessage: async (message) => {
            assertCreator();
            return signMessage(message);
          },
        });
        // Keep the receipt even if verification or the Solana transaction fails.
        setUploaded(upload);
      }
      setStage("Verifying the uploaded JSON bytes…");
      await verifyArweaveRules(upload);
      assertCreator();
      if (rules.closeTs.lte(new BN(String(Math.floor(Date.now() / 1000)))))
        throw new Error(
          "Trading close time passed during upload. Update the rules before creating the market.",
        );
      // New random IDs permit multiple independent questions for one mint.
      const marketId = crypto.getRandomValues(new Uint8Array(32));
      if (clubKey) {
        // Re-check with a fresh SOL price just before sending.
        const priceUpdate = await clubPrice(clubKey);
        const { market, instructions } = await createClubMarketInstructions(
          program,
          wallet.publicKey,
          clubKey,
          collateralMint,
          {
            resolver: rules.resolver,
            fallback: null,
            closeTs: rules.closeTs,
            earliestResolutionTs: rules.earliestResolutionTs,
            resolutionDelaySeconds: rules.resolutionDelaySeconds,
            payoutPerContract: payout,
            priceTick,
            rulesUri: upload.uri,
            questionHash: rules.questionHash,
            rulesHash: rules.rulesHash,
          },
          name,
          symbol,
          publicAccess,
          priceUpdate,
          marketId,
        );
        setStage("Approve market creation in your wallet…");
        const signature = await (
          program.provider as AnchorProvider
        ).sendAndConfirm(new Transaction().add(...instructions));
        setResult({ market: clubMarketHref(clubKey, market), signature });
        return;
      }
      const market = derivePredictionMarketPda(marketId);
      const instruction = await program.methods
        .initializePredictionMarket(
          Array.from(marketId),
          {
            resolver: rules.resolver,
            fallback: rules.fallback,
            closeTs: rules.closeTs,
            earliestResolutionTs: rules.earliestResolutionTs,
            resolutionDelaySeconds: rules.resolutionDelaySeconds,
            payoutPerContract: payout,
            priceTick,
            rulesUri: upload.uri,
            questionHash: rules.questionHash,
            rulesHash: rules.rulesHash,
          },
          name,
          symbol,
        )
        .accounts({
          authority: wallet.publicKey,
          adminRecord: deriveAdminRecordPda(wallet.publicKey),
          market,
          collateralMint,
          vaultAuthority: deriveVaultAuthorityPda(market),
          collateralVault: deriveVaultPda(market, collateralMint),
          marketMetadata: deriveMarketMetadataPda(market),
          marketFees: deriveMarketFeesPda(market),
          orderBook: derivePredictionBookPda(market),
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      setStage("Approve market creation in your wallet…");
      const signature = await (
        program.provider as AnchorProvider
      ).sendAndConfirm(new Transaction().add(instruction));
      setResult({ market: `/predictions/${market.toBase58()}`, signature });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Draft creation failed",
      );
    } finally {
      setPending(false);
      setStage(null);
    }
  }

  return (
    <div className="app-shell">
      <AppHeader />
      <main className="route-shell route-shell-narrow">
        {clubKey ? (
          <Link className="market-type-back" href={`/clubs/${club}`}>
            {t("← Club")}
          </Link>
        ) : (
          <Link className="market-type-back" href="/markets/new">
            {t("← Change market type")}
          </Link>
        )}
        <div className="route-heading">
          <h1>
            {clubKey
              ? t("Create a club market")
              : t("Create a prediction market")}
          </h1>
          {clubAccess?.name && <p>{clubAccess.name}</p>}
        </div>
        {!PREDICTION_DRAFTS_ENABLED && (
          <div className="access-card">
            {t(
              "Prediction draft creation is disabled in this app configuration.",
            )}
          </div>
        )}
        {!wallet ? (
          <div className="access-card">
            {clubKey
              ? t("Connect a wallet to see your clubs.")
              : t("Connect your administrator wallet.")}
          </div>
        ) : loading ? (
          <div className="access-card">{t("Checking role…")}</div>
        ) : (
          !isAdmin && (
            <div className="access-card">
              {clubKey
                ? t("This club's policy does not let you create markets.")
                : t("An active administrator role is required.")}
            </div>
          )
        )}
        {clubKey && isAdmin && depositIssue && (
          <div className="access-card access-denied" role="alert">
            {t(depositIssue)}
          </div>
        )}
        {roleError && (
          <div className="access-card access-denied" role="alert">
            {t(roleError ?? "")}
          </div>
        )}
        {isAdmin && (
          <form
            className="admin-card market-create-form"
            onSubmit={(event) => void create(event)}
          >
            <div className="form-section-heading">
              <span className="section-marker" aria-hidden="true">
                01
              </span>
              <div>
                <h2>{t("Market details")}</h2>
              </div>
            </div>
            <label>
              {t("Short display name")}
              <input
                required
                maxLength={64}
                value={name}
                disabled={pending}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              {t("Collateral mint")}
              <input
                required
                value={mint}
                disabled={pending}
                onChange={(e) => setMint(e.target.value)}
                placeholder={t("SPL token mint address")}
              />
            </label>
            <label>
              {t("Collateral symbol")}
              <input
                required
                maxLength={16}
                value={symbol}
                disabled={pending}
                onChange={(e) => setSymbol(e.target.value)}
                placeholder="tUSDC"
              />
            </label>
            <label>
              {t("Price increment per contract")}
              <input
                required
                value={tick}
                disabled={pending}
                onChange={(e) => setTick(e.target.value)}
                inputMode="decimal"
              />
            </label>
            {clubKey && (
              <label className="rules-checkbox">
                <input
                  type="checkbox"
                  checked={publicAccess}
                  disabled={pending}
                  onChange={(e) => setPublicAccess(e.target.checked)}
                />
                {t(
                  "Public market: anyone can trade. Leave unchecked to admit only current club members.",
                )}
              </label>
            )}
            {clubKey && (
              <p className="rules-help">
                {t(
                  "Club markets have no fallback resolver: any current club admin resolves them. The market opens with its order book in the same transaction.",
                )}
              </p>
            )}
            <details className="inline-explainer">
              <summary>{t("How does the price increment work?")}</summary>
              <p>
                {t(
                  "For example, a 0.01 increment allows prices of 0.50 or 0.51, but not 0.505.",
                )}
              </p>
            </details>
            <PredictionRulesEditor
              value={draft}
              creator={creator}
              disabled={pending}
              json={preview.json}
              issue={preview.issue}
              onChange={(value) => {
                setDraft(value);
                setReviewedContent(null);
              }}
            />
            {!signMessage && (
              <p className="access-denied" role="alert">
                {t(
                  "This wallet does not support message signing. Choose a wallet with message signing to upload the rules.",
                )}
              </p>
            )}
            <label className="rules-checkbox rules-review">
              <input
                type="checkbox"
                required
                checked={reviewed}
                disabled={pending}
                onChange={(e) =>
                  setReviewedContent(e.target.checked ? preview.json : null)
                }
              />
              {t(
                "I reviewed these rules and authorize their public, permanent upload. Turbo may use existing storage credits; this app never tops up or sends SOL for storage.",
              )}
            </label>
            <p className="rules-help">
              {t(
                "Rules upload is permanent, even if market creation is canceled. Retrying unchanged rules reuses the upload.",
              )}
            </p>
            {stage && (
              <p className="rules-progress" role="status">
                {stage}
              </p>
            )}
            <button
              className="primary-button"
              type="submit"
              disabled={
                !PREDICTION_DRAFTS_ENABLED ||
                pending ||
                !!roleError ||
                !reviewed ||
                !preview.json ||
                !signMessage ||
                !!result
              }
            >
              {pending
                ? t("Creating draft…")
                : t("Upload rules & create draft")}
            </button>
          </form>
        )}
        {uploaded && (
          <div className="access-card rules-upload-receipt">
            <h2>{t("Rules upload saved")}</h2>
            <p>
              {uploaded.content === preview.json && uploaded.owner === creator
                ? t("This upload can be reused for the current rules.")
                : t(
                    "The rules or creator changed. Creation will require a new upload.",
                  )}
            </p>
            <a
              href={`${RULES_GATEWAY}${uploaded.id}`}
              target="_blank"
              rel="noreferrer"
            >
              {t("View uploaded JSON ↗")}
            </a>
            <code>{uploaded.uri}</code>
            <button
              type="button"
              className="admin-action-button"
              onClick={() => {
                const url = URL.createObjectURL(
                  new Blob([JSON.stringify(uploaded, null, 2)], {
                    type: "application/json",
                  }),
                );
                const link = document.createElement("a");
                link.href = url;
                link.download = "outcomia-rules-upload-receipt.json";
                link.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              }}
            >
              {t("Download upload receipt")}
            </button>
          </div>
        )}
        {error && (
          <div className="access-card access-denied" role="alert">
            {t(error ?? "")}
          </div>
        )}
        {result && (
          <div className="access-card transaction-success">
            <p>
              {t("Draft confirmed.")}{" "}
              <Link href={result.market}>{t("Inspect draft →")}</Link>
            </p>
            <a
              href={transactionExplorerUrl(result.signature)}
              target="_blank"
              rel="noreferrer"
            >
              {t("View transaction ↗")}
            </a>
          </div>
        )}
      </main>
    </div>
  );
}
