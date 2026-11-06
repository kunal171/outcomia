"use client";

import { useMemo, useRef, useState, type FormEvent } from "react";
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
  getTidebookProgram,
  getTidebookAccounts,
  parseTokenAmount,
  TOKEN_PROGRAM_ID,
  transactionExplorerUrl,
} from "../lib/tidebook";

export function CreatePredictionMarket() {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const { signMessage } = useWallet();
  const creator = wallet?.publicKey.toBase58() ?? "";
  const currentCreator = useRef(creator);
  currentCreator.current = creator;
  const { role, loading, error: roleError } = useProtocolRole();
  const isAdmin = !loading && (role === "admin" || role === "super-admin");
  const program = useMemo(
    () => (wallet ? getTidebookProgram(connection, wallet) : null),
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
      if (rules.closeTs.lte(new BN(String(Math.floor(Date.now() / 1000)))))
        throw new Error("Trading close time must be in the future");
      const admin = await getTidebookAccounts(
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
      setResult({ market: market.toBase58(), signature });
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
        <Link className="market-type-back" href="/markets/new">
          ← Change market type
        </Link>
        <div className="route-heading">
          <div className="eyebrow">Prediction market setup</div>
          <h1>Create a prediction market</h1>
          <p>
            Set the question, collateral and resolution rules. Create a draft,
            then open it as its active-admin creator. Resolution and reward
            claims are still being built.
          </p>
        </div>
        {!PREDICTION_DRAFTS_ENABLED && (
          <div className="access-card">
            Prediction draft creation is disabled in this app configuration.
          </div>
        )}
        {!wallet ? (
          <div className="access-card">Connect your administrator wallet.</div>
        ) : loading ? (
          <div className="access-card">Checking role…</div>
        ) : (
          !isAdmin && (
            <div className="access-card">
              An active administrator role is required.
            </div>
          )
        )}
        {roleError && (
          <div className="access-card access-denied" role="alert">
            {roleError}
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
                <h2>Market details</h2>
                <p>Name the question and choose its collateral.</p>
              </div>
            </div>
            <label>
              Short display name
              <input
                required
                maxLength={64}
                value={name}
                disabled={pending}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              Collateral mint
              <input
                required
                value={mint}
                disabled={pending}
                onChange={(e) => setMint(e.target.value)}
                placeholder="SPL token mint address"
              />
            </label>
            <label>
              Collateral symbol
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
              Price increment per contract
              <input
                required
                value={tick}
                disabled={pending}
                onChange={(e) => setTick(e.target.value)}
                inputMode="decimal"
              />
            </label>
            <details className="inline-explainer">
              <summary>How does the price increment work?</summary>
              <p>
                Prices are quoted in collateral per contract. A 0.01 increment
                allows prices such as 0.40 or 0.41. A winning contract is
                designed to pay 1 collateral token after settlement; resolution
                and claims are still in development.
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
                This wallet does not support message signing. Choose a wallet
                with message signing to upload the rules.
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
              I reviewed these rules and authorize their public, permanent
              upload. Turbo may use existing storage credits; this app never
              tops up or sends SOL for storage.
            </label>
            <p className="rules-help">
              The app uploads and checks the JSON, then asks you to sign market
              creation. If creation fails, retrying the same rules reuses the
              upload. Uploading cannot be undone by cancelling the market
              transaction.
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
              {pending ? "Creating draft…" : "Upload rules & create draft"}
            </button>
          </form>
        )}
        {uploaded && (
          <div className="access-card rules-upload-receipt">
            <h2>Rules upload saved</h2>
            <p>
              {uploaded.content === preview.json && uploaded.owner === creator
                ? "This upload can be reused for the current rules."
                : "The rules or creator changed. Creation will require a new upload."}
            </p>
            <a
              href={`${RULES_GATEWAY}${uploaded.id}`}
              target="_blank"
              rel="noreferrer"
            >
              View uploaded JSON ↗
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
                link.download = "tidebook-rules-upload-receipt.json";
                link.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              }}
            >
              Download upload receipt
            </button>
          </div>
        )}
        {error && (
          <div className="access-card access-denied" role="alert">
            {error}
          </div>
        )}
        {result && (
          <div className="access-card transaction-success">
            <p>
              Draft confirmed.{" "}
              <Link href={`/predictions/${result.market}`}>
                Inspect draft →
              </Link>
            </p>
            <a
              href={transactionExplorerUrl(result.signature)}
              target="_blank"
              rel="noreferrer"
            >
              View transaction ↗
            </a>
          </div>
        )}
      </main>
    </div>
  );
}
