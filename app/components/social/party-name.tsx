"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { INDEXER_ENABLED } from "../../lib/graphql/client";
import { getPartyProfiles, type Profile } from "../../lib/graphql/social";
import { createPartyProfiles } from "../../lib/party-profiles";
import { shortParty } from "./linked-accounts";
import { WalletAvatar } from "./social-ui";

const lookup = createPartyProfiles(getPartyProfiles);

/** The profile linked to a Canton party, or null while loading / unlinked. */
export function usePartyProfile(party: string | null | undefined) {
  const [state, setState] = useState<{
    party: string;
    profile: Profile | null;
  }>();
  useEffect(() => {
    if (!INDEXER_ENABLED || !party) return;
    let live = true;
    void lookup(party).then((profile) => {
      if (live) setState({ party, profile });
    });
    return () => {
      live = false;
    };
  }, [party]);
  return state && state.party === party ? state.profile : null;
}

/** A Canton party as its linked profile's avatar and name, linking to the
 * profile; an unlinked party shows its shortened id. */
export function PartyName({
  party,
  size = 22,
}: {
  party: string;
  size?: number;
}) {
  const profile = usePartyProfile(party);
  if (!profile) return <code title={party}>{shortParty(party)}</code>;
  return (
    <Link
      className="trader-name party-name"
      href={`/u/${profile.username}`}
      title={party}
    >
      <WalletAvatar
        wallet={profile.wallet ?? party}
        hue={profile.avatarHue}
        size={size}
      />
      <span>
        <strong>{profile.displayName || `@${profile.username}`}</strong>
        {profile.displayName && <small>@{profile.username}</small>}
      </span>
    </Link>
  );
}
