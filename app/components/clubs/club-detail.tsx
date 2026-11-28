"use client";
/** One club: markets, members, roles, invitations, policy, ownership and fees. */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import Link from "next/link";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { AppHeader } from "../app-header";
import { useI18n } from "../preferences-provider";
import { getOutcomiaReadProgram } from "../../lib/outcomia";
import { readableAmount } from "../../lib/market-display";
import { predictionStatus } from "../../lib/prediction";
import {
  CLUBS_ENABLED,
  acceptClubOwnershipInstruction,
  canCreateClubMarket,
  clubMarketHref,
  clubRole,
  closeClubInviteInstruction,
  inviteClubMemberInstruction,
  inviteExpired,
  isAdmin,
  leaveClubInstruction,
  membersOnly,
  nominateClubOwnerInstruction,
  readClub,
  removeClubMemberInstruction,
  setClubMarketPolicyInstruction,
  setClubMemberRoleInstruction,
  withdrawClubFeesInstruction,
  approveClubRequestInstruction,
  closeClubListingInstruction,
  closeClubRequestInstruction,
  clubListingIssue,
  clubRequestNoteIssue,
  isOpenListing,
  joinOpenClubInstruction,
  listingVerified,
  requestClubMembershipInstruction,
  requestExpired,
  setClubListingInstruction,
  clubKind,
  memberCap,
  readClubRules,
  type ClubRulesConfigAccount,
  verifyClubListingInstruction,
  type ClubSnapshot,
} from "../../lib/clubs";
import { useProtocolRole } from "../protocol-role-provider";
import { ClubFeedback, shortKey, useClubTransaction } from "./club-transaction";
import { roleLabel } from "./clubs-home";
import { STATUS_LABELS } from "./club-market";
import { ClubDeposit } from "./club-deposit";

export function ClubDetail({ address }: { address: string }) {
  const { t } = useI18n();
  const { connection } = useConnection();
  const program = useMemo(
    () => getOutcomiaReadProgram(connection),
    [connection],
  );
  const club = useMemo(() => new PublicKey(address), [address]);
  const [snapshot, setSnapshot] = useState<ClubSnapshot | null>(null),
    [loaded, setLoaded] = useState(false),
    [loadIssue, setLoadIssue] = useState<string | null>(null),
    [revision, setRevision] = useState(0),
    [invitee, setInvitee] = useState(""),
    [note, setNote] = useState(""),
    [listingDraft, setListingDraft] = useState<{
      type: "private" | "public" | "open";
      topic: string;
      description: string;
    } | null>(null);
  const { role: protocolRole } = useProtocolRole();
  const protocolAdmin =
    protocolRole === "admin" || protocolRole === "super-admin";
  const tx = useClubTransaction(() => setRevision((v) => v + 1));
  const wallet = tx.wallet?.publicKey;

  const [rules, setRules] = useState<ClubRulesConfigAccount | null>(null);
  useEffect(() => {
    if (!CLUBS_ENABLED) return;
    let dead = false;
    void readClubRules(program)
      .then((value) => !dead && setRules(value))
      .catch(() => !dead && setRules(null));
    return () => {
      dead = true;
    };
  }, [program, revision]);

  useEffect(() => {
    if (!CLUBS_ENABLED) return;
    let dead = false;
    setLoadIssue(null);
    void readClub(program, club)
      .then((value) => {
        if (dead) return;
        setSnapshot(value);
        setLoaded(true);
      })
      .catch((e) => !dead && setLoadIssue(String(e)));
    return () => {
      dead = true;
    };
  }, [program, club, revision]);

  const me = wallet
    ? snapshot?.members.find((m) => m.wallet.equals(wallet))
    : undefined;
  const role = snapshot ? clubRole(snapshot.club, me) : null;
  const owner = role === "owner";
  const admin = owner || role === "admin";
  const now = Math.floor(Date.now() / 1000);

  const listing = snapshot?.listing ?? null;
  const kind = snapshot ? clubKind(snapshot.club) : null;
  const cap = rules && kind ? memberCap(rules, kind) : null;
  const adminsFull =
    !!rules && !!snapshot && snapshot.club.adminCount >= rules.maxClubAdmins;
  const myRequest = wallet
    ? snapshot?.requests.find((r) => r.wallet.equals(wallet))
    : undefined;
  const draft = listingDraft ?? {
    type: listing ? (isOpenListing(listing) ? "open" : "public") : "private",
    topic: listing?.topic ?? "",
    description: listing?.description ?? "",
  };

  async function saveListing(event: FormEvent) {
    event.preventDefault();
    if (draft.type === "private") {
      if (!listing) return;
      if (
        await tx.run(async (p, signer) => [
          await closeClubListingInstruction(p, signer, club),
        ])
      )
        setListingDraft(null);
      return;
    }
    const issue = clubListingIssue(draft.topic, draft.description);
    if (issue) return tx.setIssue(issue);
    if (
      await tx.run(async (p, signer) => [
        await setClubListingInstruction(
          p,
          signer,
          club,
          draft.type === "open",
          draft.topic,
          draft.description,
        ),
      ])
    )
      setListingDraft(null);
  }

  async function requestJoin(event: FormEvent) {
    event.preventDefault();
    const issue = clubRequestNoteIssue(note);
    if (issue) return tx.setIssue(issue);
    if (
      await tx.run(async (p, signer) => [
        await requestClubMembershipInstruction(p, signer, club, note),
      ])
    )
      setNote("");
  }

  async function invite(event: FormEvent) {
    event.preventDefault();
    let target: PublicKey;
    try {
      target = new PublicKey(invitee.trim());
    } catch {
      return tx.setIssue("Enter a valid wallet address");
    }
    if (
      await tx.run(async (p, signer) => [
        await inviteClubMemberInstruction(p, signer, club, target),
      ])
    )
      setInvitee("");
  }

  const run = (build: Parameters<typeof tx.run>[0]) => void tx.run(build);
  const expiry = (seconds: { toNumber(): number }) =>
    new Date(seconds.toNumber() * 1000).toLocaleString();
  const roleTone = (r: ReturnType<typeof clubRole>) =>
    r === "owner" ? "ui-badge-accent" : r === "admin" ? "ui-badge-yes" : "";

  return (
    <div className="app-shell">
      <AppHeader />
      <main className="route-shell club-page">
        <Link className="club-back" href="/clubs">
          {t("← Clubs")}
        </Link>
        {!CLUBS_ENABLED && (
          <div className="ui-notice">
            {t("Clubs are not enabled in this app configuration.")}
          </div>
        )}
        {loadIssue && (
          <div className="ui-notice" role="alert">
            {t(loadIssue)}
          </div>
        )}
        {loaded && !snapshot && (
          <div className="ui-empty">
            {t("This club was not found on this network.")}
          </div>
        )}
        {snapshot && (
          <>
            <header className="ui-page-head club-head">
              <div>
                <p className="ui-eyebrow">{t("Club")}</p>
                <h1 className="ui-title">{snapshot.club.name}</h1>
                <div className="club-head-meta">
                  {kind ? (
                    <span className="ui-badge">
                      {kind === "public" ? t("Public club") : t("Private club")}
                    </span>
                  ) : (
                    <span className="ui-badge ui-badge-warn">
                      {t("Awaiting upgrade")}
                    </span>
                  )}
                  {listing && (
                    <span
                      className={`ui-badge ${isOpenListing(listing) ? "ui-badge-yes" : "ui-badge-accent"}`}
                    >
                      {t(isOpenListing(listing) ? "Open" : "Public")}
                    </span>
                  )}
                  {listing && (
                    <span
                      className={`ui-badge ${listingVerified(listing) ? "ui-badge-yes" : "ui-badge-warn"}`}
                    >
                      {t(
                        listingVerified(listing)
                          ? "Verified"
                          : "Awaiting verification",
                      )}
                    </span>
                  )}
                  {listing?.topic && (
                    <span className="ui-badge">{listing.topic}</span>
                  )}
                  <span>
                    {cap
                      ? t("{value0} of {value1} members", {
                          value0: snapshot.club.memberCount.toLocaleString(),
                          value1: cap.toLocaleString(),
                        })
                      : t("{value0} members", {
                          value0: String(snapshot.club.memberCount),
                        })}
                  </span>
                  {rules && (
                    <span>
                      {t("{value0} of {value1} admins", {
                        value0: snapshot.club.adminCount,
                        value1: rules.maxClubAdmins,
                      })}
                    </span>
                  )}
                  <span>
                    {"anyMember" in snapshot.club.marketPolicy
                      ? t("Any member can create markets")
                      : t("Admins create markets")}
                  </span>
                </div>
              </div>
              <div className="ui-actions">
                {me && role && (
                  <span className={`ui-badge ${roleTone(role)}`}>
                    {t(roleLabel(role))}
                  </span>
                )}
                {canCreateClubMarket(snapshot.club, me) && (
                  <Link
                    className="ui-btn ui-btn-primary"
                    href={`/clubs/${address}/markets/new`}
                  >
                    {t("Create market")}
                  </Link>
                )}
              </div>
            </header>

            {listing && (
              <section
                className="ui-card club-about"
                aria-label={t("Club listing")}
              >
                {listing.description && (
                  <p className="club-about-text">{listing.description}</p>
                )}
                {wallet &&
                  !me &&
                  listingVerified(listing) &&
                  (isOpenListing(listing) ? (
                    <div className="ui-actions">
                      <button
                        type="button"
                        className="ui-btn ui-btn-primary"
                        disabled={tx.pending}
                        onClick={() =>
                          run(async (p, signer) => [
                            await joinOpenClubInstruction(p, signer, club),
                          ])
                        }
                      >
                        {t("Join club")}
                      </button>
                    </div>
                  ) : myRequest ? (
                    <div className="ui-actions club-inline">
                      <span className="ui-badge ui-badge-warn">
                        {t("Request pending")}
                      </span>
                      <button
                        type="button"
                        className="ui-btn ui-btn-sm"
                        disabled={tx.pending}
                        onClick={() =>
                          run(async (p, signer) => [
                            await closeClubRequestInstruction(
                              p,
                              signer,
                              club,
                              signer,
                              false,
                            ),
                          ])
                        }
                      >
                        {t("Cancel request")}
                      </button>
                    </div>
                  ) : (
                    <form
                      className="club-join-form"
                      onSubmit={(e) => void requestJoin(e)}
                    >
                      <label className="ui-field">
                        <span>{t("Note to the club admins (optional)")}</span>
                        <input
                          className="ui-input"
                          value={note}
                          maxLength={140}
                          disabled={tx.pending}
                          onChange={(e) => setNote(e.target.value)}
                        />
                      </label>
                      <button
                        className="ui-btn ui-btn-primary"
                        type="submit"
                        disabled={tx.pending}
                      >
                        {t("Request to join")}
                      </button>
                    </form>
                  ))}
                {protocolAdmin && (
                  <div className="ui-actions">
                    <button
                      type="button"
                      className="ui-btn ui-btn-sm"
                      disabled={tx.pending}
                      onClick={() =>
                        run(async (p, signer) => [
                          await verifyClubListingInstruction(
                            p,
                            signer,
                            club,
                            !listingVerified(listing),
                          ),
                        ])
                      }
                    >
                      {t(
                        listingVerified(listing)
                          ? "Withdraw verification"
                          : "Verify listing",
                      )}
                    </button>
                  </div>
                )}
              </section>
            )}

            <div
              className={
                admin ? "club-layout" : "club-layout club-layout-single"
              }
            >
              <div className="club-main">
                <ClubDeposit
                  club={club}
                  account={snapshot.club}
                  rules={rules}
                  owner={owner}
                  tx={tx}
                />
                <section className="ui-card">
                  <div className="club-card-head">
                    <h2 className="ui-h3">{t("Club markets")}</h2>
                  </div>
                  {snapshot.markets.length === 0 ? (
                    <p className="club-muted">
                      {t("This club has no markets yet.")}
                    </p>
                  ) : (
                    <ul className="ui-list">
                      {snapshot.markets.map((row) => (
                        <li
                          className="ui-row club-market-row"
                          key={row.address.toBase58()}
                        >
                          <Link
                            className="club-market-link"
                            href={clubMarketHref(club, row.address)}
                          >
                            <p className="ui-row-title">
                              {row.metadata?.displayName ??
                                shortKey(row.address)}
                            </p>
                            <div className="club-badges">
                              <span className="ui-badge ui-badge-accent">
                                {t(
                                  STATUS_LABELS[predictionStatus(row.market)] ??
                                    predictionStatus(row.market),
                                )}
                              </span>
                              <span className="ui-badge">
                                {membersOnly(row.binding)
                                  ? t("Members only")
                                  : t("Public")}
                              </span>
                            </div>
                          </Link>
                          {owner && !row.binding.accruedClubFees.isZero() && (
                            <button
                              type="button"
                              className="ui-btn ui-btn-sm"
                              disabled={tx.pending}
                              onClick={() =>
                                run(async (p, signer) => {
                                  const mint = row.market.collateralMint;
                                  const destination =
                                    getAssociatedTokenAddressSync(mint, signer);
                                  return [
                                    createAssociatedTokenAccountIdempotentInstruction(
                                      signer,
                                      destination,
                                      signer,
                                      mint,
                                    ),
                                    await withdrawClubFeesInstruction(
                                      p,
                                      signer,
                                      club,
                                      row.address,
                                      mint,
                                      destination,
                                      row.binding.accruedClubFees,
                                    ),
                                  ];
                                })
                              }
                            >
                              {t("Withdraw {value0} club fees", {
                                value0: `${readableAmount(
                                  row.binding.accruedClubFees,
                                  row.market.payoutPerContract.toString()
                                    .length - 1,
                                )} ${row.metadata?.quoteSymbol ?? ""}`.trim(),
                              })}
                            </button>
                          )}
                          <span className="club-row-arrow" aria-hidden="true">
                            →
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                <section className="ui-card">
                  <div className="club-card-head">
                    <h2 className="ui-h3">{t("Members")}</h2>
                    <span className="ui-badge">
                      {cap
                        ? `${snapshot.club.memberCount.toLocaleString()} / ${cap.toLocaleString()}`
                        : String(snapshot.club.memberCount)}
                    </span>
                  </div>
                  <ul className="ui-list">
                    {snapshot.members.map((m) => {
                      const memberRole = clubRole(snapshot.club, m);
                      const isMe = !!wallet && m.wallet.equals(wallet);
                      const nominated = snapshot.club.pendingOwner?.equals(
                        m.wallet,
                      );
                      const removable =
                        memberRole !== "owner" &&
                        !isMe &&
                        (owner || (admin && memberRole === "member"));
                      return (
                        <li
                          className="ui-row club-member-row"
                          key={m.wallet.toBase58()}
                        >
                          <code className="ui-num" title={m.wallet.toBase58()}>
                            {shortKey(m.wallet)}
                          </code>
                          <div className="club-badges">
                            <span
                              className={`ui-badge ${roleTone(memberRole)}`}
                            >
                              {t(roleLabel(memberRole))}
                            </span>
                            {nominated && (
                              <span className="ui-badge ui-badge-warn">
                                {t("Nominated owner")}
                              </span>
                            )}
                          </div>
                          <div className="club-row-actions">
                            {owner && memberRole !== "owner" && (
                              <button
                                type="button"
                                className="ui-btn ui-btn-sm"
                                disabled={
                                  tx.pending || (!isAdmin(m) && adminsFull)
                                }
                                title={
                                  !isAdmin(m) && adminsFull
                                    ? t(
                                        "This club already has the maximum number of admins",
                                      )
                                    : undefined
                                }
                                onClick={() =>
                                  run(async (p, signer) => [
                                    await setClubMemberRoleInstruction(
                                      p,
                                      signer,
                                      club,
                                      m.wallet,
                                      !isAdmin(m),
                                    ),
                                  ])
                                }
                              >
                                {isAdmin(m)
                                  ? t("Make member")
                                  : t("Make admin")}
                              </button>
                            )}
                            {owner && memberRole !== "owner" && !nominated && (
                              <button
                                type="button"
                                className="ui-btn ui-btn-sm"
                                disabled={tx.pending}
                                onClick={() =>
                                  run(async (p, signer) => [
                                    await nominateClubOwnerInstruction(
                                      p,
                                      signer,
                                      club,
                                      m.wallet,
                                    ),
                                  ])
                                }
                              >
                                {t("Nominate as owner")}
                              </button>
                            )}
                            {removable && (
                              <button
                                type="button"
                                className="ui-btn ui-btn-sm club-danger"
                                disabled={tx.pending}
                                onClick={() =>
                                  run(async (p, signer) => [
                                    await removeClubMemberInstruction(
                                      p,
                                      signer,
                                      club,
                                      m.wallet,
                                    ),
                                  ])
                                }
                              >
                                {t("Remove")}
                              </button>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                  {((owner && snapshot.club.pendingOwner) ||
                    (wallet && snapshot.club.pendingOwner?.equals(wallet)) ||
                    (me && !owner)) && (
                    <div className="ui-actions club-card-foot">
                      {owner && snapshot.club.pendingOwner && (
                        <button
                          type="button"
                          className="ui-btn ui-btn-sm"
                          disabled={tx.pending}
                          onClick={() =>
                            run(async (p, signer) => [
                              await nominateClubOwnerInstruction(
                                p,
                                signer,
                                club,
                                signer,
                              ),
                            ])
                          }
                        >
                          {t("Cancel ownership nomination")}
                        </button>
                      )}
                      {wallet && snapshot.club.pendingOwner?.equals(wallet) && (
                        <button
                          type="button"
                          className="ui-btn ui-btn-primary"
                          disabled={tx.pending}
                          onClick={() =>
                            run(async (p, signer) => [
                              await acceptClubOwnershipInstruction(
                                p,
                                signer,
                                club,
                                snapshot.club.owner,
                              ),
                            ])
                          }
                        >
                          {t("Accept club ownership")}
                        </button>
                      )}
                      {me && !owner && (
                        <button
                          type="button"
                          className="ui-btn ui-btn-sm club-danger"
                          disabled={tx.pending}
                          onClick={() =>
                            run(async (p, signer) => [
                              await leaveClubInstruction(p, signer, club),
                            ])
                          }
                        >
                          {t("Leave club")}
                        </button>
                      )}
                    </div>
                  )}
                </section>

                {admin && (snapshot.requests.length > 0 || listing) && (
                  <section className="ui-card">
                    <div className="club-card-head">
                      <h2 className="ui-h3">{t("Join requests")}</h2>
                      {snapshot.requests.length > 0 && (
                        <span className="ui-badge ui-badge-warn">
                          {String(snapshot.requests.length)}
                        </span>
                      )}
                    </div>
                    {snapshot.requests.length === 0 ? (
                      <p className="club-muted">{t("No pending requests.")}</p>
                    ) : (
                      <ul className="ui-list">
                        {snapshot.requests.map((r) => {
                          const expired = requestExpired(r, now);
                          return (
                            <li
                              className="ui-row club-request-row"
                              key={r.wallet.toBase58()}
                            >
                              <div className="club-request-main">
                                <code
                                  className="ui-num"
                                  title={r.wallet.toBase58()}
                                >
                                  {shortKey(r.wallet)}
                                </code>
                                {r.note && (
                                  <p className="club-request-note">
                                    “{r.note}”
                                  </p>
                                )}
                                <p className="ui-row-meta">
                                  {expired
                                    ? t("Expired")
                                    : t("Expires {value0}", {
                                        value0: expiry(r.expiresAt),
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
                                      run(async (p, signer) => [
                                        await approveClubRequestInstruction(
                                          p,
                                          signer,
                                          club,
                                          r.wallet,
                                        ),
                                      ])
                                    }
                                  >
                                    {t("Approve")}
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className="ui-btn ui-btn-sm"
                                  disabled={tx.pending}
                                  onClick={() =>
                                    run(async (p, signer) => [
                                      await closeClubRequestInstruction(
                                        p,
                                        signer,
                                        club,
                                        r.wallet,
                                        true,
                                      ),
                                    ])
                                  }
                                >
                                  {t(expired ? "Clear" : "Reject")}
                                </button>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </section>
                )}

                {snapshot.invites.length > 0 && (
                  <section className="ui-card">
                    <div className="club-card-head">
                      <h2 className="ui-h3">{t("Pending invitations")}</h2>
                    </div>
                    <ul className="ui-list">
                      {snapshot.invites.map((invitation) => {
                        const expired = inviteExpired(invitation, now);
                        return (
                          <li
                            className="ui-row"
                            key={invitation.wallet.toBase58()}
                          >
                            <div>
                              <code
                                className="ui-num"
                                title={invitation.wallet.toBase58()}
                              >
                                {shortKey(invitation.wallet)}
                              </code>
                              <p className="ui-row-meta">
                                {expired
                                  ? t("Expired")
                                  : t("Expires {value0}", {
                                      value0: expiry(invitation.expiresAt),
                                    })}
                              </p>
                            </div>
                            {(admin || expired) && wallet && (
                              <button
                                type="button"
                                className="ui-btn ui-btn-sm"
                                disabled={tx.pending}
                                onClick={() =>
                                  run(async (p, signer) => [
                                    await closeClubInviteInstruction(
                                      p,
                                      signer,
                                      invitation,
                                      admin,
                                    ),
                                  ])
                                }
                              >
                                {expired ? t("Clear") : t("Revoke")}
                              </button>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                )}
              </div>

              {admin && (
                <aside className="club-side" aria-label={t("Manage club")}>
                  <p className="ui-eyebrow">{t("Manage club")}</p>
                  {!kind && (
                    <p className="ui-notice" role="status">
                      {t(
                        "This club was created before club types. An Outcomia admin will upgrade it shortly; until then it cannot accept members.",
                      )}
                    </p>
                  )}
                  {owner && kind === "private" && (
                    <section className="ui-card">
                      <h2 className="ui-h3">{t("Listing")}</h2>
                      <p className="club-help">
                        {t(
                          "Private clubs are invite-only and cannot be listed for discovery.",
                        )}
                      </p>
                    </section>
                  )}
                  {owner && kind === "public" && (
                    <section className="ui-card">
                      <h2 className="ui-h3">{t("Listing")}</h2>
                      <form
                        className="club-form"
                        onSubmit={(e) => void saveListing(e)}
                      >
                        <label className="ui-field">
                          <span>{t("Who can join")}</span>
                          <select
                            className="ui-select"
                            value={draft.type}
                            disabled={tx.pending}
                            onChange={(e) =>
                              setListingDraft({
                                ...draft,
                                type: e.target.value as
                                  "private" | "public" | "open",
                              })
                            }
                          >
                            <option value="private">
                              {t("Private: invitation only")}
                            </option>
                            <option value="public">
                              {t("Public: request and approval")}
                            </option>
                            <option value="open">
                              {t("Open: anyone can join")}
                            </option>
                          </select>
                        </label>
                        {draft.type !== "private" && (
                          <>
                            <label className="ui-field">
                              <span className="club-field-label">
                                {t("Topic")}
                                <small>{draft.topic.length}/32</small>
                              </span>
                              <input
                                className="ui-input"
                                value={draft.topic}
                                maxLength={32}
                                disabled={tx.pending}
                                onChange={(e) =>
                                  setListingDraft({
                                    ...draft,
                                    topic: e.target.value,
                                  })
                                }
                              />
                            </label>
                            <label className="ui-field">
                              <span className="club-field-label">
                                {t("Description")}
                                <small>{draft.description.length}/280</small>
                              </span>
                              <textarea
                                className="ui-input"
                                rows={4}
                                value={draft.description}
                                maxLength={280}
                                disabled={tx.pending}
                                onChange={(e) =>
                                  setListingDraft({
                                    ...draft,
                                    description: e.target.value,
                                  })
                                }
                              />
                            </label>
                          </>
                        )}
                        <p className="club-help">
                          {t(
                            "Public and open clubs appear in discovery after a protocol admin verifies the listing. Any change needs verification again.",
                          )}
                        </p>
                        <button
                          className="ui-btn ui-btn-primary ui-btn-block"
                          type="submit"
                          disabled={
                            tx.pending || (draft.type === "private" && !listing)
                          }
                        >
                          {t(
                            draft.type === "private"
                              ? "Make private"
                              : "Save listing",
                          )}
                        </button>
                      </form>
                    </section>
                  )}

                  <section className="ui-card">
                    <h2 className="ui-h3">{t("Invite a member")}</h2>
                    <form
                      className="club-form"
                      onSubmit={(e) => void invite(e)}
                    >
                      <label className="ui-field">
                        <span>{t("Wallet address")}</span>
                        <input
                          className="ui-input ui-num"
                          required
                          value={invitee}
                          disabled={tx.pending}
                          onChange={(e) => setInvitee(e.target.value)}
                        />
                      </label>
                      <p className="club-help">
                        {t(
                          "The wallet joins only by accepting within seven days. You pay the invitation rent and get it back when it closes.",
                        )}
                      </p>
                      <button
                        className="ui-btn ui-btn-primary ui-btn-block"
                        type="submit"
                        disabled={tx.pending || !invitee}
                      >
                        {t("Send invitation")}
                      </button>
                    </form>
                  </section>

                  <section className="ui-card">
                    <h2 className="ui-h3">{t("Market creation")}</h2>
                    <label className="club-toggle">
                      <input
                        type="checkbox"
                        checked={"anyMember" in snapshot.club.marketPolicy}
                        disabled={tx.pending}
                        onChange={(e) => {
                          const anyMember = e.target.checked;
                          run(async (p, signer) => [
                            await setClubMarketPolicyInstruction(
                              p,
                              signer,
                              club,
                              anyMember,
                            ),
                          ]);
                        }}
                      />
                      <span>{t("Let every member create markets")}</span>
                    </label>
                  </section>
                </aside>
              )}
            </div>
            <ClubFeedback issue={tx.issue} signature={tx.signature} />
          </>
        )}
      </main>
    </div>
  );
}
