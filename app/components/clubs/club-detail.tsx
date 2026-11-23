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
  verifyClubListingInstruction,
  type ClubSnapshot,
} from "../../lib/clubs";
import { useProtocolRole } from "../protocol-role-provider";
import { ClubFeedback, shortKey, useClubTransaction } from "./club-transaction";
import { roleLabel } from "./clubs-home";
import { STATUS_LABELS } from "./club-market";

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

  return (
    <div className="app-shell">
      <AppHeader />
      <main className="route-shell">
        <Link className="text-button" href="/clubs">
          {t("← Clubs")}
        </Link>
        {!CLUBS_ENABLED && (
          <div className="access-card">
            {t("Clubs are not enabled in this app configuration.")}
          </div>
        )}
        {loadIssue && (
          <div className="access-card access-denied" role="alert">
            {t(loadIssue)}
          </div>
        )}
        {loaded && !snapshot && (
          <div className="access-card">
            {t("This club was not found on this network.")}
          </div>
        )}
        {snapshot && (
          <>
            <div className="route-heading">
              <h1>{snapshot.club.name}</h1>
              <p>
                {t(roleLabel(role))} ·{" "}
                {t("{value0} members", {
                  value0: String(snapshot.club.memberCount),
                })}{" "}
                ·{" "}
                {"anyMember" in snapshot.club.marketPolicy
                  ? t("Any member can create markets")
                  : t("Admins create markets")}
              </p>
            </div>
            {listing && (
              <section
                className="club-listing-banner"
                aria-label={t("Club listing")}
              >
                <div className="club-discovery-head">
                  <span
                    className={`role-badge ${isOpenListing(listing) ? "club-open" : "club-public"}`}
                  >
                    {t(isOpenListing(listing) ? "Open" : "Public")}
                  </span>
                  <span
                    className={`ui-badge ${listingVerified(listing) ? "ui-badge-yes" : "ui-badge-warn"}`}
                  >
                    {t(
                      listingVerified(listing)
                        ? "Verified"
                        : "Awaiting verification",
                    )}
                  </span>
                  <small>{listing.topic}</small>
                </div>
                {listing.description && <p>{listing.description}</p>}
                {wallet &&
                  !me &&
                  listingVerified(listing) &&
                  (isOpenListing(listing) ? (
                    <button
                      type="button"
                      className="primary-button"
                      disabled={tx.pending}
                      onClick={() =>
                        void tx.run(async (p, signer) => [
                          await joinOpenClubInstruction(p, signer, club),
                        ])
                      }
                    >
                      {t("Join club")}
                    </button>
                  ) : myRequest ? (
                    <div className="market-card-actions wallet-card-actions">
                      <span className="ui-badge">{t("Request pending")}</span>
                      <button
                        type="button"
                        className="admin-action-button"
                        disabled={tx.pending}
                        onClick={() =>
                          void tx.run(async (p, signer) => [
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
                      className="admin-form"
                      onSubmit={(e) => void requestJoin(e)}
                    >
                      <label>
                        {t("Note to the club admins (optional)")}
                        <input
                          value={note}
                          maxLength={140}
                          disabled={tx.pending}
                          onChange={(e) => setNote(e.target.value)}
                        />
                      </label>
                      <button
                        className="primary-button"
                        type="submit"
                        disabled={tx.pending}
                      >
                        {t("Request to join")}
                      </button>
                    </form>
                  ))}
                {protocolAdmin && (
                  <div className="market-card-actions wallet-card-actions">
                    <button
                      type="button"
                      className="admin-action-button"
                      disabled={tx.pending}
                      onClick={() =>
                        void tx.run(async (p, signer) => [
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
            <div className="admin-layout">
              <section className="admin-card admin-list-card">
                <div className="admin-list-heading">
                  <div className="card-label">{t("Club markets")}</div>
                  {canCreateClubMarket(snapshot.club, me) && (
                    <Link
                      className="admin-action-button"
                      href={`/clubs/${address}/markets/new`}
                    >
                      {t("Create market")}
                    </Link>
                  )}
                </div>
                {snapshot.markets.length === 0 && (
                  <p>{t("This club has no markets yet.")}</p>
                )}
                <ul className="club-list">
                  {snapshot.markets.map((row) => (
                    <li key={row.address.toBase58()}>
                      <Link href={clubMarketHref(club, row.address)}>
                        {row.metadata?.displayName ?? shortKey(row.address)}
                      </Link>
                      <small>
                        {t(
                          STATUS_LABELS[predictionStatus(row.market)] ??
                            predictionStatus(row.market),
                        )}{" "}
                        ·{" "}
                        {membersOnly(row.binding)
                          ? t("Members only")
                          : t("Public")}
                      </small>
                      {owner && !row.binding.accruedClubFees.isZero() && (
                        <button
                          type="button"
                          className="admin-action-button"
                          disabled={tx.pending}
                          onClick={() =>
                            void tx.run(async (p, signer) => {
                              const mint = row.market.collateralMint;
                              const destination = getAssociatedTokenAddressSync(
                                mint,
                                signer,
                              );
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
                              row.market.payoutPerContract.toString().length -
                                1,
                            )} ${row.metadata?.quoteSymbol ?? ""}`.trim(),
                          })}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </section>

              <section className="admin-card admin-list-card">
                <div className="card-label">{t("Members")}</div>
                <ul className="club-list">
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
                      <li key={m.wallet.toBase58()}>
                        <code title={m.wallet.toBase58()}>
                          {shortKey(m.wallet)}
                        </code>
                        <small>
                          {t(roleLabel(memberRole))}
                          {nominated ? ` · ${t("Nominated owner")}` : ""}
                        </small>
                        <div className="admin-actions">
                          {owner && memberRole !== "owner" && (
                            <button
                              type="button"
                              className="admin-action-button"
                              disabled={tx.pending}
                              onClick={() =>
                                void tx.run(async (p, signer) => [
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
                              {isAdmin(m) ? t("Make member") : t("Make admin")}
                            </button>
                          )}
                          {owner && memberRole !== "owner" && !nominated && (
                            <button
                              type="button"
                              className="admin-action-button"
                              disabled={tx.pending}
                              onClick={() =>
                                void tx.run(async (p, signer) => [
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
                              className="admin-action-button"
                              disabled={tx.pending}
                              onClick={() =>
                                void tx.run(async (p, signer) => [
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
                {owner && snapshot.club.pendingOwner && (
                  <button
                    type="button"
                    className="admin-action-button"
                    disabled={tx.pending}
                    onClick={() =>
                      void tx.run(async (p, signer) => [
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
                    className="primary-button"
                    disabled={tx.pending}
                    onClick={() =>
                      void tx.run(async (p, signer) => [
                        await acceptClubOwnershipInstruction(p, signer, club),
                      ])
                    }
                  >
                    {t("Accept club ownership")}
                  </button>
                )}
                {me && !owner && (
                  <button
                    type="button"
                    className="admin-action-button"
                    disabled={tx.pending}
                    onClick={() =>
                      void tx.run(async (p, signer) => [
                        await leaveClubInstruction(p, signer, club),
                      ])
                    }
                  >
                    {t("Leave club")}
                  </button>
                )}
              </section>

              {owner && (
                <section className="admin-card">
                  <div className="card-label">{t("Listing")}</div>
                  <form
                    className="admin-form"
                    onSubmit={(e) => void saveListing(e)}
                  >
                    <label>
                      {t("Who can join")}
                      <select
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
                        <label>
                          {t("Topic")}
                          <input
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
                        <label>
                          {t("Description")}
                          <textarea
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
                    <p>
                      {t(
                        "Public and open clubs appear in discovery after a protocol admin verifies the listing. Any change needs verification again.",
                      )}
                    </p>
                    <button
                      className="primary-button"
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

              {admin && (snapshot.requests.length > 0 || listing) && (
                <section className="admin-card admin-list-card">
                  <div className="card-label">{t("Join requests")}</div>
                  {snapshot.requests.length === 0 && (
                    <p>{t("No pending requests.")}</p>
                  )}
                  <ul className="club-list">
                    {snapshot.requests.map((r) => {
                      const expired = requestExpired(r, now);
                      return (
                        <li key={r.wallet.toBase58()}>
                          <strong title={r.wallet.toBase58()}>
                            {shortKey(r.wallet)}
                          </strong>
                          {r.note && <small>“{r.note}”</small>}
                          <small>
                            {expired
                              ? t("Expired")
                              : t("Expires {value0}", {
                                  value0: new Date(
                                    r.expiresAt.toNumber() * 1000,
                                  ).toLocaleString(),
                                })}
                          </small>
                          <div className="admin-actions">
                            {!expired && (
                              <button
                                type="button"
                                className="primary-button"
                                disabled={tx.pending}
                                onClick={() =>
                                  void tx.run(async (p, signer) => [
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
                              className="admin-action-button"
                              disabled={tx.pending}
                              onClick={() =>
                                void tx.run(async (p, signer) => [
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
                </section>
              )}

              {admin && (
                <section className="admin-card">
                  <div className="card-label">{t("Invite a member")}</div>
                  <form className="admin-form" onSubmit={(e) => void invite(e)}>
                    <label>
                      {t("Wallet address")}
                      <input
                        required
                        value={invitee}
                        disabled={tx.pending}
                        onChange={(e) => setInvitee(e.target.value)}
                      />
                    </label>
                    <p>
                      {t(
                        "The wallet joins only by accepting within seven days. You pay the invitation rent and get it back when it closes.",
                      )}
                    </p>
                    <button
                      className="primary-button"
                      type="submit"
                      disabled={tx.pending || !invitee}
                    >
                      {t("Send invitation")}
                    </button>
                  </form>
                  <label className="rules-checkbox">
                    <input
                      type="checkbox"
                      checked={"anyMember" in snapshot.club.marketPolicy}
                      disabled={tx.pending}
                      onChange={(e) => {
                        const anyMember = e.target.checked;
                        void tx.run(async (p, signer) => [
                          await setClubMarketPolicyInstruction(
                            p,
                            signer,
                            club,
                            anyMember,
                          ),
                        ]);
                      }}
                    />
                    {t("Let every member create markets")}
                  </label>
                </section>
              )}

              {snapshot.invites.length > 0 && (
                <section className="admin-card admin-list-card">
                  <div className="card-label">{t("Pending invitations")}</div>
                  <ul className="club-list">
                    {snapshot.invites.map((invitation) => {
                      const expired = inviteExpired(invitation, now);
                      return (
                        <li key={invitation.wallet.toBase58()}>
                          <code title={invitation.wallet.toBase58()}>
                            {shortKey(invitation.wallet)}
                          </code>
                          <small>
                            {expired
                              ? t("Expired")
                              : t("Expires {value0}", {
                                  value0: new Date(
                                    invitation.expiresAt.toNumber() * 1000,
                                  ).toLocaleString(),
                                })}
                          </small>
                          {(admin || expired) && wallet && (
                            <button
                              type="button"
                              className="admin-action-button"
                              disabled={tx.pending}
                              onClick={() =>
                                void tx.run(async (p, signer) => [
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
              <ClubFeedback issue={tx.issue} signature={tx.signature} />
            </div>
          </>
        )}
      </main>
    </div>
  );
}
