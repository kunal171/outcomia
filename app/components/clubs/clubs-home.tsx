"use client";
/** A wallet's clubs, its invitations and club creation. */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useConnection } from "@solana/wallet-adapter-react";
import { AppHeader } from "../app-header";
import { useI18n } from "../preferences-provider";
import { getOutcomiaReadProgram } from "../../lib/outcomia";
import {
  CLUBS_ENABLED,
  acceptClubInviteInstruction,
  closeClubInviteInstruction,
  clubNameIssue,
  clubRole,
  createClubInstruction,
  inviteExpired,
  isOpenListing,
  joinOpenClubInstruction,
  closeClubRequestInstruction,
  readClubListings,
  readClubRules,
  readOwnedClubCount,
  readWalletClubs,
  type ClubKind,
  type ClubRulesConfigAccount,
  requestClubMembershipInstruction,
} from "../../lib/clubs";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  depositClubSolInstruction,
  depositClubUsdcInstruction,
  depositShortfall,
  depositsConfigured,
  formatUsd,
  freshSolUsdPrice,
  minimumDepositUsd,
} from "../../lib/club-deposits";
import { ClubFeedback, useClubTransaction } from "./club-transaction";

type WalletClubs = Awaited<ReturnType<typeof readWalletClubs>>;
type Listings = Awaited<ReturnType<typeof readClubListings>>;

export function ClubsHome() {
  const { t } = useI18n();
  const router = useRouter();
  const { connection } = useConnection();
  const program = useMemo(
    () => getOutcomiaReadProgram(connection),
    [connection],
  );
  const [data, setData] = useState<WalletClubs | null>(null),
    [loadIssue, setLoadIssue] = useState<string | null>(null),
    [revision, setRevision] = useState(0),
    [name, setName] = useState(""),
    [kind, setKind] = useState<ClubKind>("private"),
    [rules, setRules] = useState<ClubRulesConfigAccount | null | undefined>(
      undefined,
    ),
    [payWith, setPayWith] = useState<"usdc" | "sol" | "later">("usdc"),
    [owned, setOwned] = useState<number | null>(null),
    [listings, setListings] = useState<Listings | null>(null);
  const tx = useClubTransaction(() => setRevision((v) => v + 1));
  const wallet = tx.wallet?.publicKey;

  useEffect(() => {
    if (!wallet || !CLUBS_ENABLED) return;
    let dead = false;
    setLoadIssue(null);
    void readWalletClubs(program, wallet)
      .then((value) => !dead && setData(value))
      .catch((e) => !dead && setLoadIssue(String(e)));
    return () => {
      dead = true;
    };
  }, [program, wallet, revision]);

  // Platform limits decide what this wallet may create.
  useEffect(() => {
    if (!CLUBS_ENABLED) return;
    let dead = false;
    void readClubRules(program)
      .then((value) => !dead && setRules(value))
      .catch(() => !dead && setRules(null));
    if (wallet)
      void readOwnedClubCount(program, wallet)
        .then((value) => !dead && setOwned(value))
        .catch(() => !dead && setOwned(null));
    return () => {
      dead = true;
    };
  }, [program, wallet, revision]);
  const atLimit = !!rules && owned !== null && owned >= rules.maxOwnedClubs;

  // Verified public and open clubs are discoverable without a wallet.
  useEffect(() => {
    if (!CLUBS_ENABLED) return;
    let dead = false;
    void readClubListings(program)
      .then((value) => !dead && setListings(value))
      .catch(() => !dead && setListings([]));
    return () => {
      dead = true;
    };
  }, [program, revision]);

  async function create(event: FormEvent) {
    event.preventDefault();
    const issue = clubNameIssue(name);
    if (issue) return tx.setIssue(issue);
    let created: string | null = null;
    const deposit = depositsConfigured(rules) ? rules : null;
    const done = await tx.run(async (p, signer) => {
      const { club, instruction } = await createClubInstruction(
        p,
        signer,
        name,
        kind,
      );
      created = club.toBase58();
      // The deposit rides in the same transaction, sized to the minimum.
      if (!deposit || payWith === "later") return [instruction];
      if (payWith === "usdc")
        return [
          instruction,
          await depositClubUsdcInstruction(
            p,
            signer,
            club,
            deposit.depositMint,
            getAssociatedTokenAddressSync(deposit.depositMint, signer),
            depositShortfall(deposit, kind, "usdc", BigInt(0)),
          ),
        ];
      const read = await freshSolUsdPrice(connection, deposit);
      // 1% above the minimum, so a small price move before signing still passes.
      const lamports =
        (depositShortfall(deposit, kind, "sol", BigInt(0), read.price) *
          BigInt(101) +
          BigInt(99)) /
        BigInt(100);
      return [
        instruction,
        await depositClubSolInstruction(p, signer, club, read.address, lamports),
      ];
    });
    if (done && created) router.push(`/clubs/${created}`);
  }

  const now = Math.floor(Date.now() / 1000);
  return (
    <div className="app-shell">
      <AppHeader />
      <main className="route-shell club-page">
        <header className="ui-page-head">
          <div>
            <p className="ui-eyebrow">{t("Clubs")}</p>
            <h1 className="ui-title">{t("Clubs")}</h1>
            <p className="ui-lead">
              {t(
                "Clubs run their own markets. Members-only markets admit only current members; anyone can always exit a position.",
              )}
            </p>
          </div>
        </header>
        {!CLUBS_ENABLED && (
          <div className="ui-notice">
            {t("Clubs are not enabled in this app configuration.")}
          </div>
        )}
        {CLUBS_ENABLED && (
          <section className="ui-section" aria-labelledby="discover-clubs">
            <div className="ui-section-head">
              <h2 id="discover-clubs">{t("Discover clubs")}</h2>
            </div>
            {!listings && <p className="club-muted">{t("Loading clubs…")}</p>}
            {listings?.length === 0 && (
              <div className="ui-empty">{t("No public clubs yet.")}</div>
            )}
            <div className="ui-grid">
              {listings?.map(({ address, club, listing }) => {
                const key = address.toBase58();
                const member = data?.clubs.some((c) =>
                  c.address.equals(address),
                );
                const requested = data?.requests.some((r) =>
                  r.address.equals(address),
                );
                const open = isOpenListing(listing);
                return (
                  <article className="ui-card club-card" key={key}>
                    <div className="club-badges">
                      <span
                        className={`ui-badge ${open ? "ui-badge-yes" : "ui-badge-accent"}`}
                      >
                        {t(open ? "Open" : "Public")}
                      </span>
                      {listing.topic && (
                        <span className="ui-badge">{listing.topic}</span>
                      )}
                    </div>
                    <h3 className="club-card-title">
                      <Link href={`/clubs/${key}`}>{club.name}</Link>
                    </h3>
                    {listing.description && (
                      <p className="club-card-text">{listing.description}</p>
                    )}
                    <div className="club-card-foot">
                      <span className="club-muted">
                        {t("{value0} members", {
                          value0: String(club.memberCount),
                        })}
                      </span>
                      {!wallet ? (
                        <Link
                          className="ui-btn ui-btn-sm"
                          href={`/clubs/${key}`}
                        >
                          {t("View club")}
                        </Link>
                      ) : member ? (
                        <Link
                          className="ui-btn ui-btn-sm"
                          href={`/clubs/${key}`}
                        >
                          {t("Member")} →
                        </Link>
                      ) : requested ? (
                        <button
                          type="button"
                          className="ui-btn ui-btn-sm"
                          disabled={tx.pending}
                          onClick={() =>
                            void tx.run(async (p, signer) => [
                              await closeClubRequestInstruction(
                                p,
                                signer,
                                address,
                                signer,
                                false,
                              ),
                            ])
                          }
                        >
                          {t("Requested · Cancel")}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="ui-btn ui-btn-sm ui-btn-primary"
                          disabled={tx.pending}
                          onClick={() =>
                            void tx.run(async (p, signer) => [
                              open
                                ? await joinOpenClubInstruction(
                                    p,
                                    signer,
                                    address,
                                  )
                                : await requestClubMembershipInstruction(
                                    p,
                                    signer,
                                    address,
                                    "",
                                  ),
                            ])
                          }
                        >
                          {t(open ? "Join club" : "Request to join")}
                        </button>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        )}
        {CLUBS_ENABLED && !wallet && (
          <section className="ui-section">
            <div className="ui-notice">
              {t("Connect a wallet to see your clubs.")}
            </div>
          </section>
        )}
        {CLUBS_ENABLED && wallet && (
          <section className="ui-section club-layout">
            <div className="club-main">
              <section className="ui-card">
                <div className="club-card-head">
                  <h2 className="ui-h3">{t("Your clubs")}</h2>
                  {data && data.clubs.length > 0 && (
                    <span className="ui-badge">
                      {String(data.clubs.length)}
                    </span>
                  )}
                </div>
                {loadIssue && (
                  <p className="ui-notice" role="alert">
                    {t(loadIssue)}
                  </p>
                )}
                {!data && !loadIssue && (
                  <p className="club-muted">{t("Loading clubs…")}</p>
                )}
                {data?.clubs.length === 0 && (
                  <p className="club-muted">
                    {t("You are not in any club yet.")}
                  </p>
                )}
                {data && data.clubs.length > 0 && (
                  <ul className="ui-list">
                    {data.clubs.map(({ address, club, member }) => {
                      const r = clubRole(club, member);
                      return (
                        <li key={address.toBase58()}>
                          <Link
                            className="ui-row"
                            href={`/clubs/${address.toBase58()}`}
                          >
                            <div>
                              <p className="ui-row-title">{club.name}</p>
                              <p className="ui-row-meta">
                                {t("{value0} members", {
                                  value0: String(club.memberCount),
                                })}
                              </p>
                            </div>
                            <div className="club-badges">
                              <span
                                className={`ui-badge ${r === "owner" ? "ui-badge-accent" : r === "admin" ? "ui-badge-yes" : ""}`}
                              >
                                {t(roleLabel(r))}
                              </span>
                              <span
                                className="club-row-arrow"
                                aria-hidden="true"
                              >
                                →
                              </span>
                            </div>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
              <section className="ui-card">
                <div className="club-card-head">
                  <h2 className="ui-h3">{t("Invitations")}</h2>
                  {data && data.invites.length > 0 && (
                    <span className="ui-badge ui-badge-warn">
                      {String(data.invites.length)}
                    </span>
                  )}
                </div>
                {data?.invites.length === 0 && (
                  <p className="club-muted">{t("No pending invitations.")}</p>
                )}
                {data && data.invites.length > 0 && (
                  <ul className="ui-list">
                    {data.invites.map(({ address, invite, club }) => {
                      const expired = inviteExpired(invite, now);
                      return (
                        <li className="ui-row" key={address.toBase58()}>
                          <div>
                            <p className="ui-row-title">{club.name}</p>
                            <p className="ui-row-meta">
                              {expired
                                ? t("Expired")
                                : t("Expires {value0}", {
                                    value0: new Date(
                                      invite.expiresAt.toNumber() * 1000,
                                    ).toLocaleString(),
                                  })}
                            </p>
                          </div>
                          <div className="club-row-actions">
                            {!expired && (
                              <button
                                type="button"
                                className="ui-btn ui-btn-sm ui-btn-primary"
                                disabled={tx.pending}
                                onClick={() =>
                                  void tx.run(async (p, signer) => [
                                    await acceptClubInviteInstruction(
                                      p,
                                      signer,
                                      invite,
                                    ),
                                  ])
                                }
                              >
                                {t("Accept")}
                              </button>
                            )}
                            <button
                              type="button"
                              className="ui-btn ui-btn-sm"
                              disabled={tx.pending}
                              onClick={() =>
                                void tx.run(async (p, signer) => [
                                  await closeClubInviteInstruction(
                                    p,
                                    signer,
                                    invite,
                                    false,
                                  ),
                                ])
                              }
                            >
                              {expired ? t("Clear") : t("Decline")}
                            </button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            </div>
            <aside className="club-side">
              <section className="ui-card">
                <h2 className="ui-h3">{t("Create a club")}</h2>
                <form className="club-form" onSubmit={(e) => void create(e)}>
                  <label className="ui-field">
                    <span>{t("Club name")}</span>
                    <input
                      className="ui-input"
                      required
                      value={name}
                      maxLength={64}
                      disabled={tx.pending}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </label>
                  <fieldset className="club-kind" disabled={tx.pending}>
                    <legend>{t("Club type")}</legend>
                    {(["private", "public"] as const).map((value) => (
                      <label key={value} className="club-kind-option">
                        <input
                          type="radio"
                          name="club-kind"
                          checked={kind === value}
                          onChange={() => setKind(value)}
                        />
                        <span>
                          <strong>
                            {value === "public" ? t("Public") : t("Private")}
                          </strong>
                          <small>
                            {value === "public"
                              ? t(
                                  "Can be listed for discovery. Up to {value0} members.",
                                  {
                                    value0: (
                                      rules?.publicMemberCap ?? 100000
                                    ).toLocaleString(),
                                  },
                                )
                              : t("Invite-only. Up to {value0} members.", {
                                  value0: (
                                    rules?.privateMemberCap ?? 1000
                                  ).toLocaleString(),
                                })}
                          </small>
                        </span>
                      </label>
                    ))}
                  </fieldset>
                  {depositsConfigured(rules) && (
                    <fieldset className="club-kind" disabled={tx.pending}>
                      <legend>
                        {t("Security deposit: {value0} minimum", {
                          value0: formatUsd(minimumDepositUsd(rules, kind)),
                        })}
                      </legend>
                      {(["usdc", "sol", "later"] as const).map((value) => (
                        <label key={value} className="club-kind-option">
                          <input
                            type="radio"
                            name="club-deposit"
                            checked={payWith === value}
                            onChange={() => setPayWith(value)}
                          />
                          <span>
                            <strong>
                              {value === "usdc"
                                ? t("Pay now in USDC")
                                : value === "sol"
                                  ? t("Pay now in SOL")
                                  : t("Pay later")}
                            </strong>
                            <small>
                              {value === "usdc"
                                ? t("Exactly the minimum, from your USDC account.")
                                : value === "sol"
                                  ? t(
                                      "Worth {value0} of the minimum at the current SOL price, plus 1%.",
                                      { value0: `${rules.solBufferBps / 100}%` },
                                    )
                                  : t(
                                      "The club cannot create markets until the deposit is paid.",
                                    )}
                            </small>
                          </span>
                        </label>
                      ))}
                    </fieldset>
                  )}
                  <p className="club-help">
                    {t(
                      "You become the owner and pay the account rent. Your wallet's club roles never grant protocol administration.",
                    )}
                  </p>
                  {rules && owned !== null && (
                    <p className="club-help">
                      {t("You own {value0} of {value1} clubs allowed.", {
                        value0: owned,
                        value1: rules.maxOwnedClubs,
                      })}
                    </p>
                  )}
                  {rules === null && (
                    <p className="ui-notice" role="status">
                      {t(
                        "Club creation opens once Outcomia sets the platform club rules.",
                      )}
                    </p>
                  )}
                  {atLimit && (
                    <p className="ui-notice" role="status">
                      {t(
                        "You already own the maximum number of clubs. Close or hand over a club to create another.",
                      )}
                    </p>
                  )}
                  <button
                    className="ui-btn ui-btn-primary ui-btn-block"
                    type="submit"
                    disabled={tx.pending || !name || !rules || atLimit}
                  >
                    {t("Create club")}
                  </button>
                </form>
              </section>
            </aside>
          </section>
        )}
        <ClubFeedback issue={tx.issue} signature={tx.signature} />
      </main>
    </div>
  );
}

export function roleLabel(role: ReturnType<typeof clubRole>) {
  return role === "owner"
    ? "Owner"
    : role === "admin"
      ? "Admin"
      : role === "member"
        ? "Member"
        : "Not a member";
}
