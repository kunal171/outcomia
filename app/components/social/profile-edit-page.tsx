"use client";
import Link from "next/link";
import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { AppHeader } from "../app-header";
import { useI18n } from "../preferences-provider";
import { useWalletSession } from "../wallet-session-provider";
import { useCantonWallet } from "../canton-wallet-provider";
import { INDEXER_ENABLED } from "../../lib/graphql/client";
import { getProfile } from "../../lib/graphql/social";
import { proveParty } from "../../lib/canton/profile-claim";
import { cip103Message } from "../../lib/canton/cip103";
import { ProfileEditor } from "./profile-editor";
import { LinkedAccounts } from "./linked-accounts";
import { isAddress, isParty, owns, type Target } from "./profile-identity";
import { useQuietData } from "./social-ui";

/** `/u/<username | wallet | party>/edit`: create or edit a profile. Only its
 * signed-in owner gets the form; sign-in works with Solana or Canton. */
export function ProfileEditPage({ id }: { id: string }) {
  const { t } = useI18n();
  const session = useWalletSession();
  const { publicKey } = useWallet();
  const { state: canton } = useCantonWallet();
  const [pending, setPending] = useState(false);
  const [issue, setIssue] = useState<string | null>(null);
  const lookup = decodeURIComponent(id);
  const result = useQuietData<Target>(async () => {
    if (isAddress(lookup))
      return { wallet: lookup, profile: await getProfile({ wallet: lookup }) };
    if (isParty(lookup))
      return { party: lookup, profile: await getProfile({ party: lookup }) };
    return { profile: await getProfile({ username: lookup }) };
  }, [lookup]);
  const target = result.data;
  const user = session?.user ?? null;
  const back = `/u/${encodeURIComponent(lookup)}`;

  async function signInCanton() {
    if (!canton.session) return;
    setPending(true);
    setIssue(null);
    try {
      session?.setUser(await proveParty(canton.session, "signIn"));
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
    <div className="app-shell">
      <AppHeader />
      <main className="route-shell profile-page">
        <Link href={back}>{t("← Back to profile")}</Link>
        {!INDEXER_ENABLED ? (
          <div className="access-card">
            <h2>
              {t("Profiles need the indexer, which is off in this deployment.")}
            </h2>
          </div>
        ) : result.error && !target ? (
          <p role="alert">
            {t("This profile could not load. Try again shortly.")}
          </p>
        ) : result.loading || !target ? (
          <p role="status">{t("Loading…")}</p>
        ) : !target.wallet && !target.party && !target.profile ? (
          <div className="access-card">
            <h2>{t("No profile called @{value0}", { value0: lookup })}</h2>
          </div>
        ) : !user ? (
          <div className="access-card profile-sign-in">
            <h2>{t("Sign in to edit your profile.")}</h2>
            <p>
              {t(
                "Use the Solana wallet or the Canton wallet this profile belongs to.",
              )}
            </p>
            {publicKey && (
              <button
                type="button"
                className="ui-btn"
                disabled={!session || session.busy}
                onClick={() => void session?.signIn()}
              >
                {t("Sign in with Solana")}
              </button>
            )}
            {canton.session ? (
              <button
                type="button"
                className="ui-btn"
                disabled={pending}
                onClick={() => void signInCanton()}
              >
                {pending
                  ? t("Approve in your wallet…")
                  : t("Sign in with Canton")}
              </button>
            ) : null}
            {!publicKey && !canton.session && (
              <p>{t("Connect your wallet to edit your profile.")}</p>
            )}
            {issue && <p role="alert">{t(issue)}</p>}
          </div>
        ) : !owns(user, target) ? (
          <div className="access-card">
            <h2>{t("You can only edit your own profile.")}</h2>
          </div>
        ) : (
          <>
            <ProfileEditor user={user} />
            <LinkedAccounts user={user} />
          </>
        )}
      </main>
    </div>
  );
}
