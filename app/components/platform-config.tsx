"use client";
/** Super-admin platform settings, kept apart from administrator management.
 * Club rules today; deposits, disputes and penalties join in later milestones
 * (docs/club-rules-and-disputes.md). */
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { Transaction, type PublicKey } from "@solana/web3.js";
import type { AnchorProvider } from "@anchor-lang/core";
import { useI18n } from "./preferences-provider";
import { TransactionToast } from "./transaction-toast";
import { getOutcomiaProgram, getOutcomiaReadProgram } from "../lib/outcomia";
import {
  clubAccounts,
  clubKind,
  clubListingPda,
  migrateClubInstruction,
  readClubRules,
  setClubRulesInstruction,
  type ClubAccount,
  type ClubKind,
  type ClubRulesAccount,
} from "../lib/clubs";

const DEFAULTS: ClubRulesAccount = {
  publicMemberCap: 100_000,
  privateMemberCap: 1_000,
  maxOwnedClubs: 2,
  maxClubAdmins: 5,
};
const FIELDS: { key: keyof ClubRulesAccount; label: string; max: number }[] = [
  {
    key: "publicMemberCap",
    label: "Public club member cap",
    max: 4_294_967_295,
  },
  {
    key: "privateMemberCap",
    label: "Private club member cap",
    max: 4_294_967_295,
  },
  { key: "maxOwnedClubs", label: "Clubs one wallet may own", max: 65_535 },
  {
    key: "maxClubAdmins",
    label: "Admins per club (owner included)",
    max: 65_535,
  },
];

type LegacyClub = {
  address: PublicKey;
  club: ClubAccount;
  listed: boolean;
};

export function PlatformConfig() {
  const { t } = useI18n();
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const reader = useMemo(
    () => getOutcomiaReadProgram(connection),
    [connection],
  );
  const [rules, setRules] = useState<ClubRulesAccount | null | undefined>(
    undefined,
  );
  const [form, setForm] = useState<Record<keyof ClubRulesAccount, string>>(
    () =>
      Object.fromEntries(
        FIELDS.map((f) => [f.key, String(DEFAULTS[f.key])]),
      ) as Record<keyof ClubRulesAccount, string>,
  );
  const [legacy, setLegacy] = useState<LegacyClub[] | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [issue, setIssue] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let dead = false;
    void readClubRules(reader)
      .then((value) => {
        if (dead) return;
        setRules(value);
        if (value)
          setForm(
            Object.fromEntries(
              FIELDS.map((f) => [f.key, String(value[f.key])]),
            ) as Record<keyof ClubRulesAccount, string>,
          );
      })
      .catch(() => !dead && setRules(null));
    void clubAccounts(reader)
      .club.all()
      .then(async (clubs) => {
        const old = clubs.filter((c) => !clubKind(c.account));
        const listings = await Promise.all(
          old.map((c) =>
            clubAccounts(reader)
              .clubListing.fetchNullable(clubListingPda(c.publicKey))
              .catch(() => null),
          ),
        );
        if (!dead)
          setLegacy(
            old.map((c, i) => ({
              address: c.publicKey,
              club: c.account,
              listed: !!listings[i],
            })),
          );
      })
      .catch(() => !dead && setLegacy([]));
    return () => {
      dead = true;
    };
  }, [reader, revision]);

  const send = useCallback(
    async (
      label: string,
      build: (
        p: ReturnType<typeof getOutcomiaProgram>,
        signer: PublicKey,
      ) => Promise<import("@solana/web3.js").TransactionInstruction>,
    ) => {
      if (!wallet) return;
      setPending(label);
      setIssue(null);
      setSignature(null);
      try {
        const p = getOutcomiaProgram(connection, wallet);
        const tx = new Transaction().add(await build(p, wallet.publicKey));
        setSignature(await (p.provider as AnchorProvider).sendAndConfirm(tx));
        setRevision((v) => v + 1);
      } catch (cause) {
        setIssue(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setPending(null);
      }
    },
    [connection, wallet],
  );

  const parsed = FIELDS.map((f) => {
    const value = Number(form[f.key]);
    return Number.isInteger(value) && value >= 1 && value <= f.max
      ? value
      : null;
  });
  const valid = parsed.every((v) => v !== null);

  function save(event: FormEvent) {
    event.preventDefault();
    if (!valid) return;
    const [publicMemberCap, privateMemberCap, maxOwnedClubs, maxClubAdmins] =
      parsed as number[];
    const next: ClubRulesAccount = {
      publicMemberCap,
      privateMemberCap,
      maxOwnedClubs,
      maxClubAdmins,
    };
    void send("rules", (p, signer) => setClubRulesInstruction(p, signer, next));
  }
  function upgrade(item: LegacyClub, kind: ClubKind) {
    void send(item.address.toBase58(), (p, signer) =>
      migrateClubInstruction(p, signer, item.address, item.club.owner, kind),
    );
  }

  return (
    <div className="admin-layout">
      <section className="admin-card">
        <div className="card-label">{t("Clubs")}</div>
        <h2>{t("Club rules")}</h2>
        <p>
          {rules === undefined
            ? t("Loading…")
            : rules === null
              ? t(
                  "Not set yet. Nobody can create or join clubs until you save these rules.",
                )
              : t(
                  "Applies to new joins, promotions and clubs. Lowering a limit never removes anyone.",
                )}
        </p>
        <form className="admin-form" onSubmit={save}>
          {FIELDS.map((f, i) => (
            <label key={f.key}>
              {t(f.label)}
              <input
                inputMode="numeric"
                value={form[f.key]}
                onChange={(e) =>
                  setForm((v) => ({ ...v, [f.key]: e.target.value.trim() }))
                }
                aria-invalid={parsed[i] === null}
                disabled={pending !== null}
              />
            </label>
          ))}
          <button
            className="primary-button"
            type="submit"
            disabled={!valid || pending !== null}
          >
            {pending === "rules"
              ? t("Saving…")
              : rules
                ? t("Save club rules")
                : t("Set club rules")}
          </button>
        </form>
      </section>

      <section className="admin-card">
        <div className="card-label">{t("Clubs")}</div>
        <h2>{t("Clubs awaiting upgrade")}</h2>
        <p>
          {t(
            "Clubs created before club types need a one-time upgrade. Listed clubs must become public. You pay the small extra rent.",
          )}
        </p>
        {legacy === null ? (
          <p role="status">{t("Loading…")}</p>
        ) : legacy.length === 0 ? (
          <p className="lb-empty">{t("Every club is up to date.")}</p>
        ) : (
          <div className="admin-list">
            {legacy.map((item) => (
              <article className="admin-row" key={item.address.toBase58()}>
                <div>
                  <strong>{item.club.name}</strong>
                  <p>
                    {t("{value0} members", {
                      value0: String(item.club.memberCount),
                    })}
                    {item.listed ? ` · ${t("Listed")}` : ""}
                  </p>
                </div>
                <div className="admin-actions">
                  {!item.listed && (
                    <button
                      type="button"
                      className="admin-action-button"
                      disabled={pending !== null || !rules}
                      onClick={() => upgrade(item, "private")}
                    >
                      {t("Upgrade as private")}
                    </button>
                  )}
                  <button
                    type="button"
                    className="admin-action-button"
                    disabled={pending !== null || !rules}
                    onClick={() => upgrade(item, "public")}
                  >
                    {pending === item.address.toBase58()
                      ? t("Upgrading…")
                      : t("Upgrade as public")}
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
        {!rules && legacy && legacy.length > 0 && (
          <p className="club-help">{t("Save the club rules first.")}</p>
        )}
      </section>
      {issue && (
        <p className="transaction-message transaction-error">{t(issue)}</p>
      )}
      <TransactionToast signature={signature} />
    </div>
  );
}
