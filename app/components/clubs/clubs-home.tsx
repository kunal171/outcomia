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
  readWalletClubs,
  requestClubMembershipInstruction,
} from "../../lib/clubs";
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
    const done = await tx.run(async (p, signer) => {
      const { club, instruction } = await createClubInstruction(
        p,
        signer,
        name,
      );
      created = club.toBase58();
      return [instruction];
    });
    if (done && created) router.push(`/clubs/${created}`);
  }

  const now = Math.floor(Date.now() / 1000);
  return (
    <div className="app-shell">
      <AppHeader />
      <main className="route-shell">
        <div className="route-heading">
          <h1>{t("Clubs")}</h1>
          <p>
            {t(
              "Clubs run their own markets. Members-only markets admit only current members; anyone can always exit a position.",
            )}
          </p>
        </div>
        {CLUBS_ENABLED && (
          <section className="club-discovery" aria-labelledby="discover-clubs">
            <div className="section-heading">
              <h2 id="discover-clubs">{t("Discover clubs")}</h2>
            </div>
            {!listings && <p>{t("Loading clubs…")}</p>}
            {listings?.length === 0 && (
              <p className="wallet-empty">{t("No public clubs yet.")}</p>
            )}
            <div className="club-discovery-grid">
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
                  <article className="club-discovery-card" key={key}>
                    <div className="club-discovery-head">
                      <span
                        className={`role-badge ${open ? "club-open" : "club-public"}`}
                      >
                        {t(open ? "Open" : "Public")}
                      </span>
                      <small>{listing.topic}</small>
                    </div>
                    <Link href={`/clubs/${key}`}>
                      <h3>{club.name}</h3>
                    </Link>
                    {listing.description && <p>{listing.description}</p>}
                    <div className="market-card-actions wallet-card-actions">
                      <small>
                        {t("{value0} members", {
                          value0: String(club.memberCount),
                        })}
                      </small>
                      {!wallet ? null : member ? (
                        <span className="role-badge">{t("Member")}</span>
                      ) : requested ? (
                        <button
                          type="button"
                          className="admin-action-button"
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
                          className="market-open-link"
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
        {!CLUBS_ENABLED ? (
          <div className="access-card">
            {t("Clubs are not enabled in this app configuration.")}
          </div>
        ) : !wallet ? (
          <div className="access-card">
            {t("Connect a wallet to see your clubs.")}
          </div>
        ) : (
          <div className="admin-layout">
            <section className="admin-card admin-list-card">
              <div className="card-label">{t("Your clubs")}</div>
              {loadIssue && (
                <p className="access-denied" role="alert">
                  {t(loadIssue)}
                </p>
              )}
              {!data && !loadIssue && <p>{t("Loading clubs…")}</p>}
              {data?.clubs.length === 0 && (
                <p>{t("You are not in any club yet.")}</p>
              )}
              <ul className="club-list">
                {data?.clubs.map(({ address, club, member }) => (
                  <li key={address.toBase58()}>
                    <Link href={`/clubs/${address.toBase58()}`}>
                      {club.name}
                    </Link>
                    <small>
                      {t(roleLabel(clubRole(club, member)))} ·{" "}
                      {t("{value0} members", {
                        value0: String(club.memberCount),
                      })}
                    </small>
                  </li>
                ))}
              </ul>
            </section>
            <section className="admin-card">
              <div className="card-label">{t("Invitations")}</div>
              {data?.invites.length === 0 && (
                <p>{t("No pending invitations.")}</p>
              )}
              <ul className="club-list">
                {data?.invites.map(({ address, invite, club }) => {
                  const expired = inviteExpired(invite, now);
                  return (
                    <li key={address.toBase58()}>
                      <strong>{club.name}</strong>
                      <small>
                        {expired
                          ? t("Expired")
                          : t("Expires {value0}", {
                              value0: new Date(
                                invite.expiresAt.toNumber() * 1000,
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
                          className="admin-action-button"
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
            </section>
            <section className="admin-card">
              <div className="card-label">{t("Create a club")}</div>
              <form className="admin-form" onSubmit={(e) => void create(e)}>
                <label>
                  {t("Club name")}
                  <input
                    required
                    value={name}
                    disabled={tx.pending}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
                <p>
                  {t(
                    "You become the owner and pay the account rent. Your wallet's club roles never grant protocol administration.",
                  )}
                </p>
                <button
                  className="primary-button"
                  type="submit"
                  disabled={tx.pending || !name}
                >
                  {t("Create club")}
                </button>
              </form>
            </section>
            <ClubFeedback issue={tx.issue} signature={tx.signature} />
          </div>
        )}
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
