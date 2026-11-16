"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AnchorProvider, BN } from "@anchor-lang/core";
import {
  useAnchorWallet,
  useConnection,
  useWallet,
} from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { getMint } from "@solana/spl-token";
import { PredictionRulesEditor } from "../prediction-rules-editor";
import {
  initialPredictionRulesDraft,
  serializePredictionRulesDraft,
  MULTI_INVALID_REFUND,
} from "../../lib/prediction-rules-draft";
import { parseMultiOutcomeRules } from "../../lib/prediction";
import {
  uploadArweaveRules,
  verifyArweaveRules,
  RULES_GATEWAY,
  type ArweaveRulesUpload,
} from "../../lib/arweave-rules";
import { getOutcomiaAccounts, deriveAdminRecordPda } from "../../lib/outcomia";
import { AppHeader } from "../app-header";
import { useProtocolRole } from "../protocol-role-provider";
import { getOutcomiaProgram, parseTokenAmount } from "../../lib/outcomia";
import {
  MULTI_OUTCOME_ENABLED,
  transactionBytes,
  type Terms,
} from "../../lib/multi-outcome";
import {
  creationTransactions,
  validateTerms,
} from "../../lib/multi-outcome-creation";
import { TermsRecovery } from "./terms-recovery";
export function CreateMultiOutcome() {
  const { connection } = useConnection(),
    wallet = useAnchorWallet(),
    { role, loading, error: roleError } = useProtocolRole();
  const { signMessage } = useWallet();
  const p = useMemo(
    () => (wallet ? getOutcomiaProgram(connection, wallet) : null),
    [connection, wallet],
  );
  const [name, setName] = useState(""),
    [labels, setLabels] = useState(""),
    [mint, setMint] = useState(""),
    [symbol, setSymbol] = useState(""),
    [tick, setTick] = useState("0.01"),
    [lot, setLot] = useState(""),
    [uri, setUri] = useState(""),
    [reviewed, setReviewed] = useState(false);
  const [draft, setDraft] = useState(() => ({
    ...initialPredictionRulesDraft(),
    conflictingEvidencePolicy:
      "Use the named source as authoritative. Document any revisions and apply the same cutoff to all outcomes.",
  }));
  const [criteria, setCriteria] = useState<Record<string, string>>({});
  const [externalRules, setExternalRules] = useState(false);
  const [uploaded, setUploaded] = useState<ArweaveRulesUpload | null>(null);
  const creator = wallet?.publicKey.toBase58() ?? "";
  const outcomeLabels = useMemo(
    () => labels.split("\n").filter((v) => v !== ""),
    [labels],
  );
  const preview = useMemo(() => {
    try {
      return {
        json: serializePredictionRulesDraft(
          draft,
          creator,
          outcomeLabels.map((label) => ({
            label,
            criteria:
              typeof criteria[label] === "string" ? criteria[label] : "",
          })),
        ),
        issue: null,
      };
    } catch (e) {
      return { json: null, issue: e instanceof Error ? e.message : String(e) };
    }
  }, [draft, creator, outcomeLabels, criteria]);
  const [busy, setBusy] = useState(false),
    [stage, setStage] = useState(""),
    [error, setError] = useState(""),
    [created, setCreated] = useState("");
  const identity = useRef(wallet?.publicKey.toBase58() ?? "");
  identity.current = wallet?.publicKey.toBase58() ?? "";
  const [recoveryRevision, setRecoveryRevision] = useState(0);
  const lock = useRef(false),
    id = useRef<Uint8Array | null>(null);
  const mounted = useRef(false),
    request = useRef<AbortController | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current?.abort();
    };
  }, []);
  useEffect(() => {
    setReviewed(false);
  }, [creator]);
  const admin = role === "admin" || role === "super-admin";
  return (
    <div className="app-shell">
      <AppHeader />
      <main className="route-shell route-shell-narrow">
        <Link className="market-type-back" href="/markets/new">
          ← Change market type
        </Link>
        <div className="route-heading">
          <h1>Create a multi-outcome market</h1>
        </div>
        {!MULTI_OUTCOME_ENABLED && (
          <div className="access-card" role="status">
            Creation is disabled until the matching program deployment is
            verified.
          </div>
        )}
        {!wallet ? (
          <div className="access-card">Connect your administrator wallet.</div>
        ) : loading ? (
          <div className="access-card">Checking role…</div>
        ) : (
          !admin && (
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
        {admin && (
          <form
            className="admin-card market-create-form"
            onChange={() => setReviewed(false)}
            onSubmit={(e) => {
              e.preventDefault();
              if (
                !p ||
                !wallet ||
                !MULTI_OUTCOME_ENABLED ||
                !admin ||
                lock.current ||
                !reviewed ||
                !preview.json ||
                roleError ||
                (!externalRules && !signMessage)
              )
                return;
              lock.current = true;
              const controller = new AbortController();
              request.current = controller;
              setBusy(true);
              setError("");
              const owner = wallet.publicKey,
                expected = owner.toBase58();
              void (async () => {
                try {
                  const assertCreator = () => {
                    if (
                      !mounted.current ||
                      controller.signal.aborted ||
                      identity.current !== expected
                    )
                      throw new Error(
                        "Wallet changed or creation was canceled. Reconnect before continuing.",
                      );
                  };
                  setStage("Validating market and rules…");
                  const content = preview.json!;
                  const rules = await parseMultiOutcomeRules(
                    new TextEncoder().encode(content).buffer,
                    outcomeLabels,
                  );
                  const record = await getOutcomiaAccounts(
                    p,
                  ).adminRecord.fetchNullable(deriveAdminRecordPda(owner));
                  if (
                    !record ||
                    !record.authority.equals(owner) ||
                    !("active" in record.status)
                  )
                    throw new Error(
                      "An active administrator record is required before uploading rules",
                    );
                  assertCreator();
                  const mintKey = new PublicKey(mint),
                    info = await getMint(connection, mintKey),
                    payout = new BN(10).pow(new BN(info.decimals));
                  if (info.decimals < 1 || info.decimals > 18)
                    throw new Error(
                      "Use an SPL collateral mint with 1–18 decimals.",
                    );
                  const count = outcomeLabels.length;
                  const terms: Terms = {
                    resolver: rules.resolver,
                    fallback: rules.fallback,
                    outcomeLabels,
                    questionHash: rules.questionHash,
                    rulesHash: rules.rulesHash,
                    rulesUri: externalRules ? uri : `ar://${"0".repeat(43)}`,
                    closeTs: rules.closeTs,
                    earliestResolutionTs: rules.earliestResolutionTs,
                    resolutionDelaySeconds: rules.resolutionDelaySeconds,
                    payoutPerContract: payout,
                    priceTick: parseTokenAmount(
                      tick,
                      info.decimals,
                      "Price tick",
                    ),
                    quantityLot: lot
                      ? new BN(lot)
                      : new BN(count).div(new BN(count).gcd(payout)),
                  };
                  validateTerms(terms);
                  // Validate metadata and packet plans before any permanent upload.
                  id.current ??= crypto.getRandomValues(new Uint8Array(32));
                  await creationTransactions(
                    p,
                    owner,
                    id.current,
                    mintKey,
                    terms,
                    name,
                    symbol,
                  );
                  assertCreator();
                  if (!externalRules) {
                    let upload =
                      uploaded?.content === content &&
                      uploaded.owner === expected
                        ? uploaded
                        : null;
                    if (!upload) {
                      setStage("Approve the rules upload in your wallet…");
                      upload = await uploadArweaveRules(content, {
                        publicKey: owner,
                        signMessage: async (message) => {
                          assertCreator();
                          return signMessage!(message);
                        },
                      });
                      if (mounted.current) setUploaded(upload);
                    }
                    assertCreator();
                    setStage("Verifying the uploaded JSON bytes…");
                    await verifyArweaveRules(upload, controller.signal);
                    terms.rulesUri = upload.uri;
                  } else {
                    const target = uri.startsWith("ar://")
                      ? `https://arweave.net/${uri.slice(5)}`
                      : uri;
                    const response = await fetch(target, {
                      cache: "no-store",
                      signal: AbortSignal.any([
                        controller.signal,
                        AbortSignal.timeout(15000),
                      ]),
                      redirect: "error",
                    });
                    if (!response.ok || !response.body)
                      throw new Error(
                        "Published rules could not be verified. Check the URI and CORS access.",
                      );
                    const reader = response.body.getReader(),
                      expectedBytes = new TextEncoder().encode(content);
                    let offset = 0;
                    try {
                      while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        if (
                          offset + value.length > expectedBytes.length ||
                          value.some((v, i) => v !== expectedBytes[offset + i])
                        )
                          throw new Error(
                            "Published rules differ from the reviewed document.",
                          );
                        offset += value.length;
                      }
                    } finally {
                      await reader.cancel();
                    }
                    if (offset !== expectedBytes.length)
                      throw new Error("Published rules are incomplete.");
                  }
                  assertCreator();
                  validateTerms(terms);
                  const plan = await creationTransactions(
                      p,
                      owner,
                      id.current,
                      mintKey,
                      terms,
                      name,
                      symbol,
                    ),
                    provider = p.provider as AnchorProvider;
                  const send = async (
                    tx: Parameters<typeof transactionBytes>[0],
                    label: string,
                  ) => {
                    if (!mounted.current || identity.current !== expected)
                      throw new Error(
                        "Wallet changed. Reconnect before continuing.",
                      );
                    setStage(label);
                    transactionBytes(tx, owner);
                    await provider.sendAndConfirm(tx);
                  };
                  for (let i = 0; i < plan.uploads.length; i++)
                    await send(
                      plan.uploads[i],
                      `Approve terms upload ${i + 1} of ${plan.uploads.length}`,
                    );
                  await send(plan.create, "Approve market creation");
                  if (mounted.current && identity.current === expected)
                    setCreated(plan.market.toBase58());
                  if (plan.cleanup)
                    await send(plan.cleanup, "Recover terms buffer rent");
                  setStage(
                    "Market created as a draft. Initialize its book, then open trading.",
                  );
                } catch (e) {
                  if (mounted.current)
                    setError(e instanceof Error ? e.message : String(e));
                } finally {
                  lock.current = false;
                  request.current = null;
                  if (mounted.current) {
                    setBusy(false);
                    setRecoveryRevision((v) => v + 1);
                  }
                }
              })();
            }}
          >
            <div className="form-section-heading">
              <span className="section-marker" aria-hidden="true">
                01
              </span>
              <div>
                <h2>Market details</h2>
              </div>
            </div>
            <label>
              Short display name
              <input
                disabled={busy}
                required
                maxLength={64}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              Outcomes (one per line, 2–8)
              <textarea
                disabled={busy}
                required
                value={labels}
                onChange={(e) => setLabels(e.target.value)}
              />
            </label>
            <label>
              Collateral mint
              <input
                disabled={busy}
                required
                value={mint}
                onChange={(e) => setMint(e.target.value)}
              />
            </label>
            <label>
              Collateral symbol
              <input
                disabled={busy}
                required
                maxLength={16}
                value={symbol}
                onChange={(e) => setSymbol(e.target.value)}
              />
            </label>
            <label>
              Price increment per contract
              <input
                disabled={busy}
                required
                inputMode="decimal"
                value={tick}
                onChange={(e) => setTick(e.target.value)}
              />
            </label>
            <details className="inline-explainer">
              <summary>Advanced trading settings</summary>
              <label>
                Contract lot
                <input
                  disabled={busy}
                  inputMode="numeric"
                  value={lot}
                  onChange={(e) => setLot(e.target.value)}
                />
                <small>
                  Optional; defaults to the smallest lot that permits exact
                  equal Invalid refunds.
                </small>
              </label>
            </details>
            <details className="inline-explainer">
              <summary>How does the price increment work?</summary>
              <p>
                For example, a 0.01 increment allows prices of 0.50 or 0.51, but
                not 0.505.
              </p>
            </details>
            <PredictionRulesEditor
              value={draft}
              creator={creator}
              disabled={busy}
              json={preview.json}
              issue={preview.issue}
              onChange={(value) => {
                setDraft(value);
                setReviewed(false);
              }}
              outcomeCriteria={
                <>
                  {outcomeLabels.map((label, index) => (
                    <label key={index}>
                      Outcome {index + 1} criteria — {label}
                      <textarea
                        required
                        rows={3}
                        aria-label={`Outcome ${index + 1} criteria`}
                        value={
                          typeof criteria[label] === "string"
                            ? criteria[label]
                            : ""
                        }
                        onChange={(e) =>
                          setCriteria((current) => ({
                            ...current,
                            [label]: e.target.value,
                          }))
                        }
                      />
                    </label>
                  ))}
                  <p className="rules-help">
                    One outcome wins and pays one collateral token per contract.{" "}
                    {MULTI_INVALID_REFUND}
                  </p>
                </>
              }
            />
            <details className="inline-explainer">
              <summary>Already published these rules?</summary>
              <label className="rules-checkbox">
                <input
                  disabled={busy}
                  type="checkbox"
                  checked={externalRules}
                  onChange={(e) => setExternalRules(e.target.checked)}
                />
                Use an existing rules document
              </label>
              {externalRules && (
                <label>
                  Published rules URI
                  <input
                    disabled={busy}
                    required
                    aria-label="Published rules URI"
                    value={uri}
                    maxLength={200}
                    onChange={(e) => setUri(e.target.value)}
                  />
                  <small>
                    The published bytes must exactly match the generated JSON,
                    including its final newline.
                  </small>
                </label>
              )}
            </details>
            {!externalRules && !signMessage && (
              <p className="access-denied" role="alert">
                This wallet does not support message signing. Choose a wallet
                with message signing to upload the rules.
              </p>
            )}
            <label className="rules-checkbox rules-review">
              <input
                disabled={busy}
                type="checkbox"
                checked={reviewed}
                onChange={(e) => {
                  e.stopPropagation();
                  setReviewed(e.target.checked);
                }}
              />
              {externalRules
                ? "I reviewed the immutable outcomes, collateral, rules and resolution terms."
                : "I reviewed these rules and authorize their public, permanent upload. Turbo may use existing storage credits; this app never tops up or sends SOL for storage."}
            </label>
            <p className="rules-help">
              Rules upload is permanent, even if market creation is canceled.
              Retrying unchanged rules reuses the upload.
            </p>
            <p className="rules-help">
              Large terms may require several wallet approvals. Partial terms
              uploads create no market, and their rent can be recovered below.
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
                busy ||
                !admin ||
                !MULTI_OUTCOME_ENABLED ||
                !wallet ||
                !reviewed ||
                !preview.json ||
                !!roleError ||
                (!externalRules && !signMessage) ||
                !!created
              }
            >
              {busy
                ? "Creating draft…"
                : externalRules
                  ? "Review creation in wallet"
                  : "Upload rules & create draft"}
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
                link.download = "outcomia-rules-upload-receipt.json";
                link.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              }}
            >
              Download upload receipt
            </button>
          </div>
        )}
        <TermsRecovery
          program={p}
          owner={wallet?.publicKey ?? null}
          revision={recoveryRevision}
          disabled={busy}
        />
        {error && (
          <div className="access-card access-denied" role="alert">
            {error}
          </div>
        )}
        {created && (
          <p>
            <Link href={`/predictions/multi/${created}`}>
              Open created market →
            </Link>
          </p>
        )}
      </main>
    </div>
  );
}
