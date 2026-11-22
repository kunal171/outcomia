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
  type ClubSnapshot,
} from "../../lib/clubs";
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
    [invitee, setInvitee] = useState("");
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
