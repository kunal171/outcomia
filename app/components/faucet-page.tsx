"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { BN } from "@anchor-lang/core";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { AppHeader } from "./app-header";
import { useI18n } from "./preferences-provider";
import { TransactionToast } from "./transaction-toast";
import { accountExplorerUrl, TOKEN_PROGRAM_ID } from "../lib/outcomia";
import { knownTokenSymbol, readableAmount } from "../lib/market-display";
import { TEST_USDC_SYMBOL } from "../lib/collateral-display";

type Config = {
  enabled: boolean;
  baseMint?: string;
  quoteMint?: string;
  baseClaimAtoms?: string;
  quoteClaimAtoms?: string;
  testUsdcMint?: string;
  testUsdcClaimAtoms?: string;
  windowSeconds?: number;
};
type Token = { mint: PublicKey; symbol: string; claim: BN };
type Holding = { amount: BN; decimals: number };

/** Devnet-only: every valueless test token the server faucet can mint, in
 * one place. The faucet itself decides what exists via GET /api/faucet. */
export function FaucetPage() {
  const { t } = useI18n();
  const wallet = useAnchorWallet(),
    { connection } = useConnection();
  const [config, setConfig] = useState<Config | null>(null),
    [holdings, setHoldings] = useState<Map<string, Holding>>(new Map()),
    [sol, setSol] = useState<number | null>(null),
    [revision, setRevision] = useState(0);

  useEffect(() => {
    let dead = false;
    fetch("/api/faucet", { cache: "no-store" })
      .then((r) => r.json() as Promise<Config>)
      .then((body) => !dead && setConfig(body))
      .catch(() => !dead && setConfig({ enabled: false }));
    return () => {
      dead = true;
    };
  }, []);

  const groups = useMemo(() => {
    if (!config?.enabled) return [];
    const list: { asset?: string; tokens: Token[]; use: string }[] = [];
    if (config.testUsdcMint && config.testUsdcClaimAtoms)
      list.push({
        asset: "test-usdc",
        use: "Collateral for prediction markets and clubs.",
        tokens: [
          {
            mint: new PublicKey(config.testUsdcMint),
            symbol: TEST_USDC_SYMBOL,
            claim: new BN(config.testUsdcClaimAtoms),
          },
        ],
      });
    if (
      config.baseMint &&
      config.quoteMint &&
      config.baseClaimAtoms &&
      config.quoteClaimAtoms
    ) {
      const base = new PublicKey(config.baseMint),
        quote = new PublicKey(config.quoteMint);
      list.push({
        use: "The spot market pair. Both tokens arrive in one claim.",
        tokens: [
          {
            mint: base,
            symbol: knownTokenSymbol(base) ?? "Base token",
            claim: new BN(config.baseClaimAtoms),
          },
          {
            mint: quote,
            symbol: knownTokenSymbol(quote) ?? "Quote token",
            claim: new BN(config.quoteClaimAtoms),
          },
        ],
      });
    }
    return list;
  }, [config]);

  // Decimals come from the mints themselves; balances from the wallet's
  // token accounts (all accounts of a mint are summed).
  useEffect(() => {
    const mints = groups.flatMap((g) => g.tokens.map((x) => x.mint));
    if (mints.length === 0) return;
    let dead = false;
    void (async () => {
      try {
        const infos = await connection.getMultipleParsedAccounts(mints);
        const next = new Map<string, Holding>();
        mints.forEach((mint, i) => {
          const data = infos.value[i]?.data;
          const decimals =
            data && "parsed" in data ? Number(data.parsed.info.decimals) : 0;
          next.set(mint.toBase58(), { amount: new BN(0), decimals });
        });
        if (wallet) {
          const [owned, lamports] = await Promise.all([
            connection.getParsedTokenAccountsByOwner(
              wallet.publicKey,
              { programId: TOKEN_PROGRAM_ID },
              "confirmed",
            ),
            connection.getBalance(wallet.publicKey, "confirmed"),
          ]);
          for (const { account } of owned.value) {
            const info = account.data.parsed?.info;
            const row = next.get(info?.mint);
            if (row)
              row.amount = row.amount.add(
                new BN(info.tokenAmount?.amount ?? "0"),
              );
          }
          if (!dead) setSol(lamports / 1e9);
        }
        if (!dead) setHoldings(next);
      } catch {
        /* Balances are a convenience; claiming still works without them. */
      }
    })();
    return () => {
      dead = true;
    };
  }, [connection, wallet, groups, revision]);

  return (
    <div className="app-shell">
      <AppHeader />
      <main className="route-shell faucet-page">
        <div className="route-heading">
          <h1>{t("Faucet")}</h1>
          <p>
            {t(
              "Free test tokens for trying Outcomia on devnet. They have no value and only exist on devnet.",
            )}
          </p>
        </div>
        {config === null ? (
          <p role="status">{t("Loading…")}</p>
        ) : !config.enabled ? (
          <div className="access-card">
            <h2>{t("The faucet is not available on this deployment.")}</h2>
          </div>
        ) : (
          <div className="faucet-grid">
            {groups.map((group) => (
              <ClaimCard
                key={group.asset ?? "pair"}
                asset={group.asset}
                use={group.use}
                tokens={group.tokens}
                holdings={holdings}
                windowSeconds={config.windowSeconds ?? 3600}
                onClaimed={() => setRevision((v) => v + 1)}
              />
            ))}
            <article className="admin-card faucet-card">
              <h2>{t("Devnet SOL")}</h2>
              <p>{t("Pays network fees for every transaction.")}</p>
              <p className="faucet-held">
                {t("You hold")}{" "}
                <strong>
                  {sol === null
                    ? "—"
                    : sol.toLocaleString(undefined, {
                        maximumFractionDigits: 4,
                      })}{" "}
                  SOL
                </strong>
              </p>
              <a
                className="ui-btn faucet-claim"
                href="https://faucet.solana.com"
                target="_blank"
                rel="noreferrer"
              >
                {t("Get devnet SOL ↗")}
              </a>
            </article>
          </div>
        )}
        <p className="faucet-next">
          {t("Claimed tokens land in your wallet. To trade with them,")}{" "}
          <Link href="/wallet">{t("deposit them on the Wallet page")}</Link>.
        </p>
      </main>
    </div>
  );
}

function ClaimCard({
  asset,
  use,
  tokens,
  holdings,
  windowSeconds,
  onClaimed,
}: {
  asset?: string;
  use: string;
  tokens: Token[];
  holdings: Map<string, Holding>;
  windowSeconds: number;
  onClaimed: () => void;
}) {
  const { t } = useI18n();
  const wallet = useAnchorWallet();
  const [pending, setPending] = useState(false),
    [error, setError] = useState<string | null>(null),
    [signature, setSignature] = useState<string | null>(null);

  async function claim() {
    if (!wallet) return;
    setPending(true);
    setError(null);
    setSignature(null);
    try {
      const response = await fetch("/api/faucet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet: wallet.publicKey.toBase58(), asset }),
      });
      const body = (await response.json()) as {
        signature?: string;
        error?: string;
        retryAfter?: number;
      };
      if (!response.ok || !body.signature)
        throw new Error(
          response.status === 429
            ? t("You already claimed recently. Try again in {minutes} min.", {
                minutes: Math.ceil((body.retryAfter ?? windowSeconds) / 60),
              })
            : (body.error ?? t("The faucet could not complete this claim")),
        );
      setSignature(body.signature);
      onClaimed();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }

  const amount = (token: Token) => {
    const held = holdings.get(token.mint.toBase58());
    return held ? readableAmount(token.claim, held.decimals) : "…";
  };
  return (
    <article className="admin-card faucet-card">
      <h2>{tokens.map((x) => x.symbol).join(" + ")}</h2>
      <p>{t(use)}</p>
      <ul className="faucet-tokens">
        {tokens.map((token) => {
          const held = holdings.get(token.mint.toBase58());
          return (
            <li key={token.mint.toBase58()}>
              <span>
                <strong>
                  +{amount(token)} {token.symbol}
                </strong>{" "}
                <small>{t("per claim")}</small>
              </span>
              <span>
                {t("You hold")}{" "}
                <strong>
                  {held && wallet
                    ? readableAmount(held.amount, held.decimals)
                    : "—"}
                </strong>
              </span>
              <a
                href={accountExplorerUrl(token.mint)}
                target="_blank"
                rel="noreferrer"
              >
                {`${token.mint.toBase58().slice(0, 4)}…${token.mint.toBase58().slice(-4)} ↗`}
              </a>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        className="ui-btn faucet-claim"
        disabled={!wallet || pending}
        onClick={() => void claim()}
      >
        {pending
          ? t("Minting…")
          : t("Claim {value0}", {
              value0: tokens.map((x) => x.symbol).join(" + "),
            })}
      </button>
      <small className="faucet-limit">
        {t("One claim per wallet every {value0} min.", {
          value0: Math.round(windowSeconds / 60),
        })}
      </small>
      {error && <p role="alert">{error}</p>}
      <TransactionToast signature={signature} />
    </article>
  );
}
