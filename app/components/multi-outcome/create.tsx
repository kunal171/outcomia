"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AnchorProvider, BN } from "@anchor-lang/core";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { getMint } from "@solana/spl-token";
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
  sha256,
  validateTerms,
} from "../../lib/multi-outcome-creation";
import { TermsRecovery } from "./terms-recovery";
import "./multi-outcome.css";
export function CreateMultiOutcome() {
  const { connection } = useConnection(),
    wallet = useAnchorWallet(),
    { role } = useProtocolRole();
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
    [close, setClose] = useState(""),
    [delay, setDelay] = useState("86400"),
    [uri, setUri] = useState(""),
    [rules, setRules] = useState(""),
    [reviewed, setReviewed] = useState(false);
  const [fallback, setFallback] = useState(""),
    [fallbackAt, setFallbackAt] = useState(""),
    [deadline, setDeadline] = useState("");
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
  const admin = role === "admin" || role === "super-admin";
  return (
    <div className="app-shell">
      <AppHeader />
      <main className="route-shell multi-outcome">
        <Link href="/predictions/multi">← Multi-outcome markets</Link>
        <h1>Create a multi-outcome market</h1>
        {!MULTI_OUTCOME_ENABLED && (
          <p role="status">
            Creation is disabled until the matching program deployment is
            verified.
          </p>
        )}
        {!admin && (
          <p>An active protocol admin must create and resolve this market.</p>
        )}
        <form
          onChange={() => setReviewed(false)}
          onSubmit={(e) => {
            e.preventDefault();
            if (
              !p ||
              !wallet ||
              !MULTI_OUTCOME_ENABLED ||
              !admin ||
              lock.current ||
              !reviewed
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
                setStage("Validating collateral and published rules…");
                const mintKey = new PublicKey(mint),
                  info = await getMint(connection, mintKey),
                  payout = new BN(10).pow(new BN(info.decimals));
                if (info.decimals < 1 || info.decimals > 18)
                  throw new Error(
                    "Use an SPL collateral mint with 1–18 decimals.",
                  );
                const outcomeLabels = labels
                  .split("\n")
                  .filter((v) => v !== "");
                const count = outcomeLabels.length;
                const terms: Terms = {
                  resolver: owner,
                  fallback: fallback
                    ? {
                        resolver: new PublicKey(fallback),
                        availableTs: new BN(
                          Math.floor(new Date(fallbackAt).getTime() / 1000),
                        ),
                        deadlineTs: deadline
                          ? new BN(
                              Math.floor(new Date(deadline).getTime() / 1000),
                            )
                          : null,
                      }
                    : null,
                  outcomeLabels,
                  questionHash: await sha256(new TextEncoder().encode(name)),
                  rulesHash: await sha256(new TextEncoder().encode(rules)),
                  rulesUri: uri,
                  closeTs: new BN(Math.floor(new Date(close).getTime() / 1000)),
                  earliestResolutionTs: null,
                  resolutionDelaySeconds: new BN(delay),
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
                if (!rules.trim())
                  throw new Error(
                    "Provide the exact published rules document.",
                  );
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
                  expectedBytes = new TextEncoder().encode(rules);
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
                id.current ??= crypto.getRandomValues(new Uint8Array(32));
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
          <label>
            Question / name
            <input
              required
              maxLength={64}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            Outcomes (one per line, 2–8)
            <textarea
              required
              value={labels}
              onChange={(e) => setLabels(e.target.value)}
            />
          </label>
          <label>
            Collateral mint
            <input
              required
              value={mint}
              onChange={(e) => setMint(e.target.value)}
            />
          </label>
          <label>
            Collateral symbol
            <input
              required
              maxLength={16}
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
            />
          </label>
          <label>
            Price tick (collateral tokens)
            <input
              required
              inputMode="decimal"
              value={tick}
              onChange={(e) => setTick(e.target.value)}
            />
          </label>
          <label>
            Contract lot (leave blank for smallest exact Invalid refund lot)
            <input
              inputMode="numeric"
              value={lot}
              onChange={(e) => setLot(e.target.value)}
            />
          </label>
          <label>
            Trading closes (your local time)
            <input
              required
              type="datetime-local"
              value={close}
              onChange={(e) => setClose(e.target.value)}
            />
          </label>
          <label>
            Resolution review delay (seconds)
            <input
              required
              type="number"
              min="1"
              step="1"
              value={delay}
              onChange={(e) => setDelay(e.target.value)}
            />
          </label>
          <details>
            <summary>Optional fallback resolver</summary>
            <label>
              Fallback public key
              <input
                value={fallback}
                onChange={(e) => setFallback(e.target.value)}
              />
            </label>
            <label>
              Available from
              <input
                type="datetime-local"
                required={!!fallback}
                value={fallbackAt}
                onChange={(e) => setFallbackAt(e.target.value)}
              />
            </label>
            <label>
              Optional timeout to Invalid
              <input
                type="datetime-local"
                value={deadline}
                onChange={(e) => setDeadline(e.target.value)}
              />
            </label>
          </details>
          <label>
            Published rules URI
            <input
              required
              value={uri}
              maxLength={200}
              onChange={(e) => setUri(e.target.value)}
            />
          </label>
          <label>
            Exact published rules document
            <textarea
              required
              value={rules}
              onChange={(e) => setRules(e.target.value)}
            />
          </label>
          <p>
            Rules must describe the outcomes, evidence, resolver, timing and
            Invalid refunds. The app verifies the published bytes before
            signing. Large terms use several wallet approvals; partial uploads
            create no market.
          </p>
          <label>
            <input
              type="checkbox"
              checked={reviewed}
              onChange={(e) => {
                e.stopPropagation();
                setReviewed(e.target.checked);
              }}
            />
            I reviewed the immutable outcomes, collateral, rules and resolution
            terms.
          </label>
          <button
            disabled={
              busy ||
              !admin ||
              !MULTI_OUTCOME_ENABLED ||
              !wallet ||
              !reviewed ||
              !!created
            }
          >
            {busy ? "Waiting for wallet…" : "Review creation in wallet"}
          </button>
        </form>
        <TermsRecovery
          program={p}
          owner={wallet?.publicKey ?? null}
          revision={recoveryRevision}
          disabled={busy}
        />
        {stage && <p role="status">{stage}</p>}
        {error && <p role="alert">{error}</p>}
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
