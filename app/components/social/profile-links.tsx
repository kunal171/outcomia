"use client";
/** Social links shown on profiles and edited on the Wallet page. Handles are
 * stored without '@' or a site prefix; the indexer validates every value. */
import { useState } from "react";
import { useI18n } from "../preferences-provider";
import type { Profile } from "../../lib/graphql/social";

export type LinkKey =
  | "website"
  | "xHandle"
  | "telegram"
  | "instagram"
  | "linkedin"
  | "discord"
  | "github"
  | "youtube";

export const PROFILE_LINKS: {
  key: LinkKey;
  label: string;
  placeholder: string;
  href: ((value: string) => string) | null;
  shown: (value: string) => string;
}[] = [
  {
    key: "website",
    label: "Website",
    placeholder: "https://example.com",
    href: (v) => v,
    shown: (v) => v.replace(/^https:\/\//, "").replace(/\/$/, ""),
  },
  {
    key: "xHandle",
    label: "X",
    placeholder: "@handle",
    href: (v) => `https://x.com/${v}`,
    shown: (v) => `@${v}`,
  },
  {
    key: "telegram",
    label: "Telegram",
    placeholder: "@username",
    href: (v) => `https://t.me/${v}`,
    shown: (v) => `@${v}`,
  },
  {
    key: "instagram",
    label: "Instagram",
    placeholder: "@username",
    href: (v) => `https://instagram.com/${v}`,
    shown: (v) => `@${v}`,
  },
  {
    key: "linkedin",
    label: "LinkedIn",
    placeholder: "linkedin.com/in/your-name",
    href: (v) => `https://www.linkedin.com/in/${v}`,
    shown: (v) => v,
  },
  {
    key: "github",
    label: "GitHub",
    placeholder: "username",
    href: (v) => `https://github.com/${v}`,
    shown: (v) => v,
  },
  {
    key: "youtube",
    label: "YouTube",
    placeholder: "@channel",
    href: (v) => `https://youtube.com/@${v}`,
    shown: (v) => `@${v}`,
  },
  // Discord usernames have no public profile URL; the chip copies the name.
  {
    key: "discord",
    label: "Discord",
    placeholder: "username",
    href: null,
    shown: (v) => v,
  },
];

export function ProfileLinks({ profile }: { profile: Profile }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const links = PROFILE_LINKS.filter((l) => profile[l.key]);
  if (links.length === 0) return null;
  return (
    <ul className="profile-links">
      {links.map((l) => {
        const value = profile[l.key] as string;
        return (
          <li key={l.key}>
            {l.href ? (
              <a href={l.href(value)} target="_blank" rel="noreferrer nofollow">
                <span>{t(l.label)}</span>
                {l.shown(value)} ↗
              </a>
            ) : (
              <button
                type="button"
                title={t("Copy")}
                onClick={() => {
                  void navigator.clipboard?.writeText(value).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  });
                }}
              >
                <span>{t(l.label)}</span>
                {copied ? t("Copied") : l.shown(value)}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
