"use client";
/** Super-admin platform settings, kept apart from administrator management.
 * Club rules and deposits today; disputes and penalties join in later
 * milestones (docs/club-rules-and-disputes.md). */
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction } from "@solana/web3.js";
import { BN } from "@anchor-lang/core";
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
  type ClubRulesConfigAccount,
} from "../lib/clubs";
import {
  SOL_USD_FEED_ID,
  depositsConfigured,
  parseUnits,
  setClubDepositRulesInstruction,
  setClubLiveMarketsInstruction,
} from "../lib/club-deposits";
import { TEST_USDC_MINT } from "../lib/collateral-display";
import {
  readDisputeConfig,
  setDisputeConfigInstruction,
  type DisputeConfigAccount,
} from "../lib/disputes";

/** Dispute settings form, as typed: days, whole tokens and a wallet. */
type DisputeForm = {
  clubDays: string;
  regularDays: string;
  bond: string;
  deadlineDays: string;
  treasury: string;
};
const DISPUTE_DEFAULTS: DisputeForm = {
  clubDays: "5",
  regularDays: "3",
  bond: "1",
  deadlineDays: "7",
  treasury: "",
};
const DISPUTE_FIELDS: { key: keyof DisputeForm; label: string }[] = [
  { key: "clubDays", label: "Club market dispute window (days)" },
  { key: "regularDays", label: "Other markets' dispute window (days)" },
  { key: "bond", label: "Dispute bond (whole collateral tokens)" },
  { key: "deadlineDays", label: "Time to rule before the market becomes invalid (days)" },
  { key: "treasury", label: "Treasury wallet" },
];
const DAY = 86_400;
/** The form as program values, or null when any is invalid. */
function parseDisputeForm(form: DisputeForm): DisputeConfigAccount | null {
  const seconds = (days: string) => {
    const value = Math.round(Number(days) * DAY);
    return Number.isFinite(value) && value >= 1 && value <= 30 * DAY ? value : null;
  };
  const club = seconds(form.clubDays);
  const regular = seconds(form.regularDays);
  const deadline = seconds(form.deadlineDays);
  const bond = Number(form.bond);
  let treasury: PublicKey;
  try {
    treasury = new PublicKey(form.treasury.trim());
  } catch {
    return null;
  }
  if (!club || !regular || !deadline || !Number.isInteger(bond) || bond < 1) return null;
  return {
    clubWindowSeconds: new BN(club),
    regularWindowSeconds: new BN(regular),
    bondTokens: new BN(bond),
    rulingDeadlineSeconds: new BN(deadline),
    treasury,
  };
}
const daysText = (seconds: BN) => String(seconds.toNumber() / DAY);

/** Deposit-rule form, as typed: dollars, percent and seconds. */
type DepositForm = {
  mint: string;
  privateMin: string;
  publicMin: string;
  buffer: string;
  feed: string;
  maxAge: string;
  maxConf: string;
};
const DEPOSIT_DEFAULTS: DepositForm = {
  mint: TEST_USDC_MINT,
  privateMin: "100",
  publicMin: "200",
  buffer: "120",
  feed: SOL_USD_FEED_ID,
  maxAge: "60",
  maxConf: "1",
};
const DEPOSIT_FIELDS: { key: keyof DepositForm; label: string }[] = [
  { key: "mint", label: "USDC mint" },
  { key: "privateMin", label: "Private club minimum (USD)" },
  { key: "publicMin", label: "Public club minimum (USD)" },
  { key: "buffer", label: "SOL buffer (% of the minimum)" },
  { key: "feed", label: "Pyth SOL/USD feed id" },
  { key: "maxAge", label: "Oldest SOL price accepted (seconds)" },
  { key: "maxConf", label: "Widest SOL price confidence (% of price)" },
];
/** The form values as program rules, or null when any is invalid. */
function parseDepositForm(form: DepositForm) {
  let mint: PublicKey;
  try {
    mint = new PublicKey(form.mint.trim());
  } catch {
    return null;
  }
  const privateMin = parseUnits(form.privateMin, 6);
  const publicMin = parseUnits(form.publicMin, 6);
  const buffer = parseUnits(form.buffer, 2);
  const conf = parseUnits(form.maxConf, 2);
  const maxAge = Number(form.maxAge);
  const feed = form.feed.trim().replace(/^0x/, "").toLowerCase();
  if (
    !privateMin ||
    !publicMin ||
    buffer === null ||
    buffer < BigInt(10_000) ||
    buffer > BigInt(30_000) ||
    conf === null ||
    conf > BigInt(1_000) ||
    !Number.isInteger(maxAge) ||
    maxAge < 1 ||
    maxAge > 300 ||
    !/^[0-9a-f]{64}$/.test(feed) ||
    /^0+$/.test(feed)
  )
    return null;
  return {
    mint,
    rules: {
      privateMinDepositUsd: new BN(privateMin.toString()),
      publicMinDepositUsd: new BN(publicMin.toString()),
      solBufferBps: Number(buffer),
      solUsdFeedId: Array.from(Buffer.from(feed, "hex")),
      maxPriceAgeSeconds: maxAge,
      maxPriceConfBps: Number(conf),
    },
  };
}
const usdText = (value: { toString(): string }) =>
  (Number(value.toString()) / 1_000_000).toString();
const pctText = (bps: number) => (bps / 100).toString();

type UncountedClub = { address: PublicKey; club: ClubAccount; markets: number };

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
  const [rules, setRules] = useState<ClubRulesConfigAccount | null | undefined>(
    undefined,
  );
  const [depositForm, setDepositForm] = useState<DepositForm>(DEPOSIT_DEFAULTS);
  const [uncounted, setUncounted] = useState<UncountedClub[] | null>(null);
  const [disputes, setDisputes] = useState<DisputeConfigAccount | null>(null);
  const [disputeForm, setDisputeForm] = useState<DisputeForm>(DISPUTE_DEFAULTS);
  const [form, setForm] = useState<Record<keyof ClubRulesAccount, string>>(
    () =>
      Object.fromEntries(
        FIELDS.map((f) => [f.key, String(DEFAULTS[f.key])]),
      ) as Record<keyof ClubRulesAccount, string>,
  );
  const [legacy, setLegacy] = useState<LegacyClub[] | null>(null);
  const [legacyIssue, setLegacyIssue] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [issue, setIssue] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let dead = false;
    setLegacyIssue(null);
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
        if (depositsConfigured(value))
          setDepositForm({
            mint: value.depositMint.toBase58(),
            privateMin: usdText(value.privateMinDepositUsd),
            publicMin: usdText(value.publicMinDepositUsd),
            buffer: pctText(value.solBufferBps),
            feed: Buffer.from(value.solUsdFeedId).toString("hex"),
            maxAge: String(value.maxPriceAgeSeconds),
            maxConf: pctText(value.maxPriceConfBps),
          });
      })
      .catch(() => !dead && setRules(null));
    void readDisputeConfig(reader).then((value) => {
      if (dead) return;
      setDisputes(value);
      if (value)
        setDisputeForm({
          clubDays: daysText(value.clubWindowSeconds),
          regularDays: daysText(value.regularWindowSeconds),
          bond: value.bondTokens.toString(),
          deadlineDays: daysText(value.rulingDeadlineSeconds),
          treasury: value.treasury.toBase58(),
        });
    });
    void clubAccounts(reader)
      .club.all()
      .then(async (clubs) => {
        // Upgraded clubs whose market count predates the counter.
        const pending = clubs.filter(
          (c) => clubKind(c.account) && c.account.liveMarketsReady === false,
        );
        const counts = await Promise.all(
          pending.map((c) =>
            clubAccounts(reader)
              .clubMarket.all([
                { memcmp: { offset: 8, bytes: c.publicKey.toBase58() } },
              ])
              .then((rows) => rows.filter((r) => r.account.club.equals(c.publicKey)).length),
          ),
        );
        if (!dead)
          setUncounted(
            pending.map((c, i) => ({
              address: c.publicKey,
              club: c.account,
              markets: counts[i],
            })),
          );
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
      .catch((cause) => {
        if (dead) return;
        setLegacy(null);
        setLegacyIssue(cause instanceof Error ? cause.message : String(cause));
      });
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
  const deposit = parseDepositForm(depositForm);
  function saveDeposits(event: FormEvent) {
    event.preventDefault();
    if (!deposit) return;
    void send("deposits", (p, signer) =>
      setClubDepositRulesInstruction(p, signer, deposit.mint, deposit.rules),
    );
  }
  const disputeConfig = parseDisputeForm(disputeForm);
  function saveDisputes(event: FormEvent) {
    event.preventDefault();
    if (!disputeConfig) return;
    void send("disputes", (p, signer) =>
      setDisputeConfigInstruction(p, signer, disputeConfig),
    );
  }
  function count(item: UncountedClub) {
    void send(`count-${item.address.toBase58()}`, (p, signer) =>
      setClubLiveMarketsInstruction(p, signer, item.address, item.markets),
    );
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
        <h2>{t("Club deposits")}</h2>
        <p>
          {depositsConfigured(rules)
            ? t(
                "Applies to new deposits and market checks. Deposits already paid are unchanged.",
              )
            : t(
                "Not set yet. No club can create or open markets until you save these rules.",
              )}
        </p>
        <form className="admin-form" onSubmit={saveDeposits}>
          {DEPOSIT_FIELDS.map((f) => (
            <label key={f.key}>
              {t(f.label)}
              <input
                value={depositForm[f.key]}
                onChange={(e) =>
                  setDepositForm((v) => ({ ...v, [f.key]: e.target.value.trim() }))
                }
                aria-invalid={!deposit}
                disabled={pending !== null}
              />
            </label>
          ))}
          <button
            className="primary-button"
            type="submit"
            disabled={!deposit || !rules || pending !== null}
          >
            {pending === "deposits"
              ? t("Saving…")
              : depositsConfigured(rules)
                ? t("Save deposit rules")
                : t("Set deposit rules")}
          </button>
        </form>
        {!rules && <p className="club-help">{t("Save the club rules first.")}</p>}
      </section>

      <section className="admin-card">
        <div className="card-label">{t("Markets")}</div>
        <h2>{t("Outcome disputes")}</h2>
        <p>
          {disputes
            ? t(
                "Applies to new proposals and disputes. Windows and deadlines already running keep their length.",
              )
            : t(
                "Not set yet. No market can receive a proposal until you save these settings.",
              )}
        </p>
        <form className="admin-form" onSubmit={saveDisputes}>
          {DISPUTE_FIELDS.map((f) => (
            <label key={f.key}>
              {t(f.label)}
              <input
                value={disputeForm[f.key]}
                onChange={(e) =>
                  setDisputeForm((v) => ({ ...v, [f.key]: e.target.value.trim() }))
                }
                aria-invalid={!disputeConfig}
                disabled={pending !== null}
              />
            </label>
          ))}
          <button
            className="primary-button"
            type="submit"
            disabled={!disputeConfig || pending !== null}
          >
            {pending === "disputes"
              ? t("Saving…")
              : disputes
                ? t("Save dispute settings")
                : t("Set dispute settings")}
          </button>
        </form>
      </section>

      <section className="admin-card">
        <div className="card-label">{t("Clubs")}</div>
        <h2>{t("Club market counts")}</h2>
        <p>
          {t(
            "Clubs created before deposits need their existing markets counted once, so they can be closed safely later. Each count is the club's markets on chain now.",
          )}
        </p>
        {uncounted === null ? (
          <p role="status">{t("Loading…")}</p>
        ) : uncounted.length === 0 ? (
          <p className="lb-empty">{t("Every club is counted.")}</p>
        ) : (
          <div className="admin-list">
            {uncounted.map((item) => (
              <article className="admin-row" key={item.address.toBase58()}>
                <div>
                  <strong>{item.club.name}</strong>
                  <p>
                    {t("{value0} markets", { value0: String(item.markets) })}
                  </p>
                </div>
                <div className="admin-actions">
                  <button
                    type="button"
                    className="admin-action-button"
                    disabled={pending !== null}
                    onClick={() => count(item)}
                  >
                    {pending === `count-${item.address.toBase58()}`
                      ? t("Saving…")
                      : t("Record count")}
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="admin-card">
        <div className="card-label">{t("Clubs")}</div>
        <h2>{t("Clubs awaiting upgrade")}</h2>
        <p>
          {t(
            "Clubs created before club types need a one-time upgrade. Listed clubs must become public. You pay the small extra rent.",
          )}
        </p>
        {legacyIssue && !legacy ? (
          <p role="alert">
            {t("Clubs could not be read: {value0}", { value0: legacyIssue })}
          </p>
        ) : legacy === null ? (
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
