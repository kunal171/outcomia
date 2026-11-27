"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useI18n } from "../preferences-provider";
import { useWalletSession } from "../wallet-session-provider";
import { INDEXER_ENABLED } from "../../lib/graphql/client";
import {
  getProfile,
  updateProfile,
  type ProfileInput,
} from "../../lib/graphql/social";
import { walletHue, WalletAvatar } from "./social-ui";
import { PROFILE_LINKS } from "./profile-links";
import type { Profile } from "../../lib/graphql/social";
import type { WalletUser } from "../../lib/auth/client";

/** Form values for every social link, empty when unset. */
function linkValues(p: Profile | null | undefined) {
  return Object.fromEntries(
    PROFILE_LINKS.map((l) => [l.key, p?.[l.key] ?? ""]),
  ) as Pick<ProfileInput, (typeof PROFILE_LINKS)[number]["key"]>;
}

/** `/u/<id>/edit` card: create or edit the signed-in user's public profile,
 * whether they signed in with a Solana wallet or a Canton party. */
export function ProfileEditor({ user }: { user: WalletUser }) {
  const { t } = useI18n();
  const session = useWalletSession();
  const signedIn = session?.user?.id === user.id;
  // The avatar and lookup key: the Solana wallet, else the first Canton party.
  const party = user.parties[0] ?? "";
  const wallet = user.wallet ?? (party || user.id);
  const [form, setForm] = useState<ProfileInput | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [exists, setExists] = useState(false);
  const [pending, setPending] = useState(false);
  const [issue, setIssue] = useState<string | null>(null);

  useEffect(() => {
    if (!INDEXER_ENABLED) return;
    let dead = false;
    setForm(null);
    getProfile(user.wallet ? { wallet: user.wallet } : { party })
      .then((p) => {
        if (dead) return;
        setExists(!!p);
        setSaved(p?.username ?? null);
        setForm({
          username: p?.username ?? "",
          displayName: p?.displayName ?? "",
          bio: p?.bio ?? "",
          avatarHue: p?.avatarHue ?? walletHue(wallet),
          showOnLeaderboards: p?.showOnLeaderboards ?? true,
          location: p?.location ?? "",
          ...linkValues(p),
        });
      })
      .catch(
        () =>
          !dead &&
          setIssue("Profiles are unavailable right now. Try again shortly."),
      );
    return () => {
      dead = true;
    };
  }, [wallet, user.wallet, party]);

  if (!INDEXER_ENABLED) return null;
  const set = <K extends keyof ProfileInput>(key: K, value: ProfileInput[K]) =>
    setForm((f) => (f ? { ...f, [key]: value } : f));

  async function save() {
    if (!form) return;
    setPending(true);
    setIssue(null);
    try {
      const profile = await updateProfile({
        ...form,
        location: form.location?.trim() || null,
        ...Object.fromEntries(
          PROFILE_LINKS.map((l) => [l.key, form[l.key]?.trim() || null]),
        ),
      });
      setExists(true);
      setSaved(profile.username);
      setForm({
        ...form,
        username: profile.username,
        location: profile.location ?? "",
        ...linkValues(profile),
      });
    } catch (cause) {
      setIssue(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="admin-card profile-editor">
      <h1>
        {exists ? t("Your public profile") : t("Create your public profile")}
      </h1>
      {!form ? (
        <p role="status">{issue ? t(issue) : t("Loading…")}</p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="profile-editor-preview">
            <WalletAvatar wallet={wallet} hue={form.avatarHue} size={64} />
            <div>
              <strong>
                {form.displayName ||
                  (form.username ? `@${form.username}` : t("Your name"))}
              </strong>
              {saved && (
                <Link href={`/u/${saved}`}>{t("View public profile →")}</Link>
              )}
            </div>
          </div>
          <label>
            {t("Username")}
            <input
              value={form.username}
              onChange={(e) => set("username", e.target.value.toLowerCase())}
              placeholder="satoshi_n"
              maxLength={20}
              pattern="[a-z0-9_]{3,20}"
              required
              disabled={pending}
            />
            <small>
              {t(
                "3–20 characters: letters, numbers and _. Your profile lives at /u/username.",
              )}
            </small>
          </label>
          <label>
            {t("Display name")}
            <input
              value={form.displayName}
              onChange={(e) => set("displayName", e.target.value)}
              maxLength={40}
              disabled={pending}
            />
          </label>
          <label>
            {t("Bio")}
            <textarea
              value={form.bio}
              onChange={(e) => set("bio", e.target.value)}
              maxLength={280}
              rows={3}
              disabled={pending}
            />
          </label>
          <label>
            {t("Avatar colour")}
            <input
              type="range"
              min={0}
              max={359}
              value={form.avatarHue}
              onChange={(e) => set("avatarHue", Number(e.target.value))}
              disabled={pending}
            />
          </label>
          <label>
            {t("Location (optional)")}
            <input
              value={form.location ?? ""}
              onChange={(e) => set("location", e.target.value)}
              placeholder={t("City or country")}
              maxLength={40}
              disabled={pending}
            />
          </label>
          <fieldset className="profile-editor-links">
            <legend>{t("Links (optional)")}</legend>
            <small>
              {t("Paste a profile link or type the handle; both work.")}
            </small>
            {PROFILE_LINKS.map((l) => (
              <label key={l.key}>
                {t(l.label)}
                <input
                  value={form[l.key] ?? ""}
                  onChange={(e) => set(l.key, e.target.value)}
                  placeholder={l.placeholder}
                  maxLength={
                    l.key === "website" || l.key === "linkedin" ? 140 : 60
                  }
                  disabled={pending}
                />
              </label>
            ))}
          </fieldset>
          <label className="profile-editor-check">
            <input
              type="checkbox"
              checked={form.showOnLeaderboards}
              onChange={(e) => set("showOnLeaderboards", e.target.checked)}
              disabled={pending}
            />
            {t("Show me on leaderboards")}
          </label>
          {issue && <p role="alert">{t(issue)}</p>}
          {signedIn ? (
            <button type="submit" className="ui-btn" disabled={pending}>
              {pending
                ? t("Saving…")
                : exists
                  ? t("Save profile")
                  : t("Create profile")}
            </button>
          ) : (
            <button
              type="button"
              className="ui-btn"
              disabled={!session || session.busy}
              onClick={() => void session?.signIn()}
            >
              {session?.busy
                ? t("Signing in…")
                : t("Sign in with your wallet to save")}
            </button>
          )}
          <small className="profile-editor-note">
            {t(
              "Profiles are public. Your trades are public on-chain either way; the profile only adds a name.",
            )}
          </small>
        </form>
      )}
    </section>
  );
}
