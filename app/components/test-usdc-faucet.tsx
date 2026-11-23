"use client";
import { useState } from "react";
import { useAnchorWallet } from "@solana/wallet-adapter-react";
import type { PublicKey } from "@solana/web3.js";
import { useI18n } from "./preferences-provider";
import { transactionExplorerUrl } from "../lib/outcomia";
import { TEST_USDC_MINT, TEST_USDC_SYMBOL } from "../lib/collateral-display";

/** One rate-limited claim of valueless outcomia-tUSDC for the demo markets.
 * Renders only for that mint; the server faucet mints to the wallet's token
 * account, and the user then deposits it with the controls beside it. */
export function TestUsdcFaucet({
  mint,
  onClaimed,
}: {
  mint: PublicKey;
  onClaimed?: () => void;
}) {
  const { t } = useI18n(),
    wallet = useAnchorWallet(),
    [pending, setPending] = useState(false),
    [error, setError] = useState<string | null>(null),
    [signature, setSignature] = useState<string | null>(null);
  if (mint.toBase58() !== TEST_USDC_MINT) return null;

  async function claim() {
    if (!wallet) return;
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/faucet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          wallet: wallet.publicKey.toBase58(),
          asset: "test-usdc",
        }),
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
                minutes: Math.ceil((body.retryAfter ?? 3600) / 60),
              })
            : (body.error ?? t("The faucet could not complete this claim")),
        );
      setSignature(body.signature);
      onClaimed?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="test-usdc-faucet">
      <div>
        <strong>{t("Get 1,000 {symbol}", { symbol: TEST_USDC_SYMBOL })}</strong>
        <span>
          {t("Valueless devnet test collateral. Claim, then deposit below.")}
        </span>
      </div>
      <button
        type="button"
        className="market-open-link"
        disabled={!wallet || pending}
        onClick={() => void claim()}
      >
        {pending ? t("Minting…") : t("Claim test tokens")}
      </button>
      {signature && (
        <p role="status">
          {t("Test assets minted.")}{" "}
          <a
            href={transactionExplorerUrl(signature)}
            target="_blank"
            rel="noreferrer"
          >
            {t("View transaction ↗")}
          </a>
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
