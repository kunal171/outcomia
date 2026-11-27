"use client";
import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useI18n } from "../preferences-provider";
import { useWalletSession } from "../wallet-session-provider";
import { useCantonWallet } from "../canton-wallet-provider";
import { proveParty, unlinkParty } from "../../lib/canton/profile-claim";
import { cip103Message } from "../../lib/canton/cip103";
import { shortAddress } from "./social-ui";
import type { WalletUser } from "../../lib/auth/client";

/** The signed-in user's Solana wallet and Canton parties, with link and
 * unlink. Linking proves the other account: a Solana signature, or a Canton
 * ledger claim approved in the Canton wallet. */
export function LinkedAccounts({ user }: { user: WalletUser }) {
  const { t } = useI18n();
  const session = useWalletSession();
  const { publicKey } = useWallet();
  const { state: canton } = useCantonWallet();
  const [pending, setPending] = useState(false);
  const [issue, setIssue] = useState<string | null>(null);
  const solana = publicKey?.toBase58() ?? null;
  const party = canton.session?.partyId ?? null;

  async function run(action: () => Promise<WalletUser | void>) {
    setPending(true);
    setIssue(null);
    try {
      const next = await action();
      if (next) session?.setUser(next);
    } catch (cause) {
      setIssue(
        cip103Message(cause) ??
          (cause instanceof Error ? cause.message : String(cause)),
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="admin-card profile-accounts">
      <h2>{t("Linked accounts")}</h2>
      <p className="profile-editor-note">
        {t(
          "Linked accounts are public on your profile, so your Solana and Canton trading show under one name.",
        )}
      </p>
      <ul>
        <li>
          <span className="ui-badge">Solana</span>{" "}
          {user.wallet ? (
            <code>{shortAddress(user.wallet)}</code>
          ) : solana ? (
            <button
              type="button"
              className="ui-btn"
              disabled={pending || session?.busy}
              onClick={() =>
                void run(() => session?.linkSolana() ?? Promise.resolve())
              }
            >
              {t("Link connected Solana wallet")}
            </button>
          ) : (
            <span>{t("Connect a Solana wallet to link it.")}</span>
          )}
        </li>
        {user.parties.map((p) => (
          <li key={p}>
            <span className="ui-badge">Canton</span>{" "}
            <code title={p}>{shortParty(p)}</code>{" "}
            <button
              type="button"
              className="text-button"
              disabled={pending || (!user.wallet && user.parties.length === 1)}
              onClick={() => void run(() => unlinkParty(p))}
            >
              {t("Unlink")}
            </button>
          </li>
        ))}
        {party && !user.parties.includes(party) && (
          <li>
            <span className="ui-badge">Canton</span>{" "}
            <button
              type="button"
              className="ui-btn"
              disabled={pending || !user.wallet || !canton.session}
              onClick={() =>
                void run(() => proveParty(canton.session!, "link"))
              }
            >
              {t("Link connected Canton wallet")}
            </button>
            {!user.wallet && <small> {t("Link a Solana wallet first.")}</small>}
          </li>
        )}
      </ul>
      {pending && <p role="status">{t("Approve in your wallet…")}</p>}
      {(issue ?? session?.error) && (
        <p role="alert">{t(issue ?? session?.error ?? "")}</p>
      )}
    </section>
  );
}

/** `hint::1220ab…cdef`: the hint and both ends of the fingerprint. */
export function shortParty(party: string) {
  const [hint, fingerprint = ""] = party.split("::");
  return fingerprint.length > 12
    ? `${hint}::${fingerprint.slice(0, 6)}…${fingerprint.slice(-4)}`
    : party;
}
