"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { AppHeader } from "../app-header";
import { useI18n } from "../preferences-provider";
import { INDEXER_ENABLED } from "../../lib/graphql/client";
import { getProfile } from "../../lib/graphql/social";
import { ProfileEditor } from "./profile-editor";
import { isAddress } from "./profile-page";
import { useQuietData } from "./social-ui";

/** `/u/<username | wallet>/edit`: create or edit a profile. Only the
 * connected wallet that owns it gets the form; saving still needs sign-in. */
export function ProfileEditPage({ id }: { id: string }) {
  const { t } = useI18n();
  const { publicKey } = useWallet();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const connected = mounted ? (publicKey?.toBase58() ?? null) : null;
  const lookup = decodeURIComponent(id);
  const result = useQuietData(
    async () =>
      isAddress(lookup)
        ? lookup
        : ((await getProfile({ username: lookup }))?.wallet ?? null),
    [lookup],
  );
  const wallet = result.data;
  const back = `/u/${encodeURIComponent(lookup)}`;

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
        ) : result.error && !wallet ? (
          <p role="alert">
            {t("This profile could not load. Try again shortly.")}
          </p>
        ) : result.loading || !mounted ? (
          <p role="status">{t("Loading…")}</p>
        ) : !wallet ? (
          <div className="access-card">
            <h2>{t("No profile called @{value0}", { value0: lookup })}</h2>
          </div>
        ) : !connected ? (
          <div className="access-card">
            <h2>{t("Connect your wallet to edit your profile.")}</h2>
          </div>
        ) : connected !== wallet ? (
          <div className="access-card">
            <h2>{t("You can only edit your own profile.")}</h2>
          </div>
        ) : (
          <ProfileEditor wallet={wallet} />
        )}
      </main>
    </div>
  );
}
