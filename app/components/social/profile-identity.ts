/** Which account or profile a `/u/<id>` route names, and who owns it. */
import { PublicKey } from "@solana/web3.js";
import type { WalletUser } from "../../lib/auth/client";
import type { Profile } from "../../lib/graphql/social";

export function isAddress(value: string) {
  try {
    new PublicKey(value);
    return value.length >= 32;
  } catch {
    return false;
  }
}

/** Who `/u/<id>` names: a Solana wallet, a Canton party or a username. */
export type Target = {
  wallet?: string;
  party?: string;
  profile: Profile | null;
};

export function isParty(value: string) {
  return /^[A-Za-z0-9_:-]+::[0-9a-fA-F]{8,}$/.test(value);
}

/** Whether `user` owns the profile or account the route names. */
export function owns(user: WalletUser | null | undefined, target: Target) {
  if (!user) return false;
  const wallets = [target.wallet, target.profile?.wallet].filter(Boolean);
  const parties = [target.party, ...(target.profile?.cantonParties ?? [])];
  return (
    (!!user.wallet && wallets.includes(user.wallet)) ||
    parties.some((p) => !!p && user.parties.includes(p))
  );
}
