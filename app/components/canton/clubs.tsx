"use client";
import { PartyName } from "../social/party-name";
import Link from "next/link";
import { useCantonWallet } from "../canton-wallet-provider";
import { useCantonTrading } from "./trading-provider";
import {
  ActionButton,
  ActionForm,
  TradingFrame,
  marketLink,
  marketRecord,
  marketRecords,
} from "./trading-ui";
import { FactoryMarketForm } from "./manage";
import {
  factoryRefKey,
  isListedClub,
  isVerifiedListing,
  list,
  obj,
  text,
  type Contract,
  type RecordValue,
} from "../../lib/canton/model";
import { useI18n } from "../preferences-provider";

/** Route number of a club: N from its policy ID "club/N". */
export function clubNumber(club: Contract) {
  return text(obj(club.data.ref).policyId).replace(/^club\//, "");
}

/** The factory scope of a market record, if it was factory-issued. */
function scopeOf(record: RecordValue) {
  return record.key ? obj(record.key).scope : record.factory;
}

/** Catalog markets issued by one club's factory. */
export function clubMarkets(contracts: Contract[], club: Contract) {
  const wanted = factoryRefKey(club.data.factoryRef);
  return marketRecords(contracts).filter((c) => {
    const scope = scopeOf(marketRecord(c));
    return !!scope && factoryRefKey(scope) === wanted;
  });
}

/** A member, invitee or requester: their profile name when linked. */
function Party({ id }: { id: unknown }) {
  return <PartyName party={text(id)} />;
}

function pendingInvite(club: Contract, party?: string) {
  return list(club.data.invitations)
    .map(obj)
    .find((i) => i.invitee === party);
}

function pendingRequest(club: Contract, party?: string) {
  return list(club.data.requests)
    .map(obj)
    .find((r) => r.requester === party);
}

/** "Public club · 3 of 256 members · 1 of 5 admins" */
function ClubFacts({ club }: { club: Contract }) {
  const { t } = useI18n();
  return (
    <span>
      {t(club.data.kind === "PublicClub" ? "Public club" : "Private club")} ·{" "}
      {t("{value0} of {value1} members", {
        value0: list(club.data.members).length,
        value1: text(club.data.memberCap),
      })}{" "}
      ·{" "}
      {t("{value0} of {value1} admins", {
        value0: list(club.data.admins).length,
        value1: text(club.data.adminCap),
      })}
    </span>
  );
}

/** Order books of a club's markets (scoped to the club's factory). */
function clubBooks(contracts: Contract[], club: Contract) {
  const wanted = factoryRefKey(club.data.factoryRef);
  return contracts.filter((c) => {
    if (c.kind !== "OrderBook" && c.kind !== "MultiBook") return false;
    const scope = obj(c.data.key).scope;
    return !!scope && factoryRefKey(scope) === wanted;
  });
}

const ownedCount = (registry: Contract | undefined, party?: string) =>
  Number(
    (list(registry?.data.owned)
      .map(list)
      .find((e) => e[0] === party) ?? [])[1] ?? 0,
  );

/** Clubs this wallet belongs to or is invited to, and club creation. */
export function CantonClubs() {
  const s = useCantonTrading(),
    { state: wallet } = useCantonWallet(),
    { t } = useI18n(),
    party = wallet.session?.partyId,
    clubs = s.owned.filter((c) => c.kind === "Club"),
    mine = clubs.filter((c) => list(c.data.members).includes(party)),
    invited = clubs.filter((c) => pendingInvite(c, party)),
    requested = clubs.filter((c) => pendingRequest(c, party)),
    registry = s.catalog?.contracts.find((c) => c.kind === "ClubRegistry"),
    catalogClubs = (s.catalog?.contracts ?? []).filter(isListedClub),
    discover = catalogClubs.filter(
      (c) => isVerifiedListing(c) && !list(c.data.members).includes(party),
    ),
    protocol = s.catalog?.contracts.find((c) => c.kind === "Protocol"),
    protocolAdmin = !!party && list(protocol?.data.admins).includes(party),
    operator = !!party && party === s.catalog?.deployment.operator,
    rules = registry ? obj(registry.data.rules) : null,
    owned = ownedCount(registry, party);
  return (
    <TradingFrame title="Clubs">
      <div className="canton-grid">
        <section className="canton-panel">
          <h2>{t("Discover clubs")}</h2>
          <div className="canton-market-list">
            {discover.map((c) => {
              const listing = obj(c.data.listing),
                open = listing.visibility === "OpenToAll",
                mine = clubs.find(
                  (x) => x.id === c.id && pendingRequest(x, party),
                );
              return (
                <div className="canton-market-row" key={c.id}>
                  <h2>{text(c.data.name)}</h2>
                  <p>
                    <strong>{text(listing.topic)}</strong>
                    {text(listing.description ?? "") ? (
                      <> · {text(listing.description)}</>
                    ) : null}
                  </p>
                  <ClubFacts club={c} />
                  {mine ? (
                    <ActionButton
                      label="Cancel request"
                      intent={{
                        action: "clubCloseRequest",
                        target: mine.id,
                        values: { wallet: party ?? "" },
                      }}
                    />
                  ) : open ? (
                    <ActionButton
                      label="Join"
                      intent={{ action: "clubJoinOpen", target: c.id }}
                    />
                  ) : (
                    <ActionForm
                      label="Request to join"
                      disabled={!party}
                      fields={[
                        {
                          name: "note",
                          label: "Note to the admins (optional)",
                        },
                      ]}
                      build={(v) => ({
                        action: "clubRequestJoin",
                        target: c.id,
                        values: { note: v.note ?? "" },
                      })}
                    />
                  )}
                </div>
              );
            })}
            {!discover.length ? <p>{t("No public clubs yet.")}</p> : null}
          </div>
        </section>
        {requested.length ? (
          <section className="canton-panel">
            <h2>{t("Your join requests")}</h2>
            {requested.map((c) => (
              <p key={c.id}>
                <strong>{text(c.data.name)}</strong> · {t("Expires")}{" "}
                {new Date(
                  text(pendingRequest(c, party)?.expiresAt),
                ).toLocaleString()}{" "}
                <ActionButton
                  label="Cancel request"
                  intent={{
                    action: "clubCloseRequest",
                    target: c.id,
                    values: { wallet: party ?? "" },
                  }}
                />
              </p>
            ))}
          </section>
        ) : null}
        <section className="canton-panel">
          <h2>{t("Your clubs")}</h2>
          <div className="canton-market-list">
            {mine.map((c) => (
              <Link
                className="canton-market-row"
                href={`/canton/clubs/${clubNumber(c)}`}
                key={c.id}
              >
                <h2>{text(c.data.name)}</h2>
                <span>
                  <ClubFacts club={c} />
                  {c.data.owner === party ? <> · {t("Owner")}</> : null}
                  {c.data.owner !== party &&
                  list(c.data.admins).includes(party) ? (
                    <> · {t("Admin")}</>
                  ) : null}
                </span>
              </Link>
            ))}
            {!mine.length ? <p>{t("You are not in any club yet.")}</p> : null}
          </div>
        </section>
        {invited.length ? (
          <section className="canton-panel">
            <h2>{t("Invitations")}</h2>
            {invited.map((c) => (
              <div key={c.id}>
                <p>
                  <strong>{text(c.data.name)}</strong> · {t("Expires")}{" "}
                  {new Date(
                    text(pendingInvite(c, party)?.expiresAt),
                  ).toLocaleString()}
                </p>
                <ActionButton
                  label="Accept"
                  intent={{ action: "clubAccept", target: c.id }}
                />{" "}
                <ActionButton
                  label="Decline"
                  intent={{ action: "clubDecline", target: c.id }}
                />
              </div>
            ))}
          </section>
        ) : null}
        <section className="canton-panel">
          <h2>{t("Create a club")}</h2>
          {registry ? (
            <>
              <ActionForm
                label="Create club"
                fields={[
                  { name: "name", label: "Club name" },
                  {
                    name: "kind",
                    label: "Club type",
                    value: "PrivateClub",
                    options: [
                      { value: "PrivateClub", label: "Private: invite-only" },
                      { value: "PublicClub", label: "Public: can be listed" },
                    ],
                  },
                ]}
                disabled={
                  !party ||
                  (!!rules && owned >= Number(text(rules.maxOwnedClubs)))
                }
                build={(v) => ({
                  action: "createClub",
                  target: registry.id,
                  values: { name: v.name, kind: v.kind },
                })}
              />
              {rules ? (
                <p>
                  {t("You own {value0} of {value1} clubs allowed.", {
                    value0: owned,
                    value1: text(rules.maxOwnedClubs),
                  })}{" "}
                  {t(
                    "Members: up to {value0} in a public club, {value1} in a private club.",
                    {
                      value0: text(rules.publicMemberCap),
                      value1: text(rules.privateMemberCap),
                    },
                  )}
                </p>
              ) : null}
            </>
          ) : (
            <p>{t("Clubs are not deployed yet.")}</p>
          )}
        </section>
        {protocolAdmin ? (
          <section className="canton-panel">
            <h2>{t("Listings awaiting verification")}</h2>
            {catalogClubs
              .filter((c) => !isVerifiedListing(c))
              .map((c) => {
                const listing = obj(c.data.listing);
                return (
                  <p key={c.id}>
                    <strong>{text(c.data.name)}</strong> · {text(listing.topic)}{" "}
                    ·{" "}
                    {t(
                      listing.visibility === "OpenToAll"
                        ? "Open to all"
                        : "Request to join",
                    )}{" "}
                    <ActionButton
                      label="Verify"
                      intent={{ action: "clubVerifyListing", target: c.id }}
                    />
                  </p>
                );
              })}
            {catalogClubs.filter(isVerifiedListing).map((c) => (
              <p key={c.id}>
                <strong>{text(c.data.name)}</strong> · {t("Verified")}{" "}
                <ActionButton
                  label="Withdraw verification"
                  intent={{
                    action: "clubVerifyListing",
                    target: c.id,
                    values: { verified: "false" },
                  }}
                />
              </p>
            ))}
            {!catalogClubs.length ? <p>{t("No listings to review.")}</p> : null}
          </section>
        ) : null}
        {operator && registry && rules ? (
          <section className="canton-panel">
            <h2>{t("Club rules")}</h2>
            <ActionForm
              label="Save club rules"
              fields={[
                {
                  name: "publicMemberCap",
                  label: "Public club member cap (max 256)",
                  value: text(rules.publicMemberCap),
                },
                {
                  name: "privateMemberCap",
                  label: "Private club member cap (max 256)",
                  value: text(rules.privateMemberCap),
                },
                {
                  name: "maxOwnedClubs",
                  label: "Clubs one wallet may own",
                  value: text(rules.maxOwnedClubs),
                },
                {
                  name: "maxClubAdmins",
                  label: "Admins per club (owner included)",
                  value: text(rules.maxClubAdmins),
                },
                {
                  name: "clubShareBps",
                  label: "Club share of taker fees (bps, max 5,000)",
                  value: text(rules.clubShareBps ?? "0"),
                },
              ]}
              build={(v) => ({
                action: "setClubRules",
                target: registry.id,
                values: v,
              })}
            />
            <h3>{t("Club markets with a different fee share")}</h3>
            {clubs
              .flatMap((c) => clubBooks(s.catalog?.contracts ?? [], c))
              .filter(
                (b) =>
                  text(b.data.clubShareBps ?? "0") !==
                  text(rules.clubShareBps ?? "0"),
              )
              .map((b) => (
                <p key={b.id}>
                  <strong>{text(obj(b.data.terms).question)}</strong> ·{" "}
                  {text(b.data.clubShareBps ?? "0")} bps{" "}
                  <ActionButton
                    label="Apply share"
                    intent={{
                      action:
                        b.kind === "MultiBook"
                          ? "multiSetShare"
                          : "clubSetShare",
                      target: b.id,
                      values: { bps: text(rules.clubShareBps ?? "0") },
                    }}
                  />
                </p>
              ))}
            <h3>{t("Clubs behind the current rules")}</h3>
            {clubs
              .filter(
                (c) =>
                  text(c.data.adminCap) !== text(rules.maxClubAdmins) ||
                  text(c.data.memberCap) !==
                    text(
                      c.data.kind === "PublicClub"
                        ? rules.publicMemberCap
                        : rules.privateMemberCap,
                    ),
              )
              .map((c) => (
                <p key={c.id}>
                  <strong>{text(c.data.name)}</strong>{" "}
                  <ActionButton
                    label="Apply rules"
                    intent={{ action: "clubApplyRules", target: c.id }}
                  />
                </p>
              ))}
          </section>
        ) : null}
      </div>
    </TradingFrame>
  );
}

/** One club: roster, invitations, roles, policy and its markets. */
export function CantonClub({ clubId }: { clubId: string }) {
  const s = useCantonTrading(),
    { state: wallet } = useCantonWallet(),
    { t } = useI18n(),
    party = wallet.session?.partyId,
    contracts = [...(s.catalog?.contracts ?? []), ...s.owned],
    club = s.owned.find((c) => c.kind === "Club" && clubNumber(c) === clubId);
  if (!club || !list(club.data.members).includes(party))
    return (
      <TradingFrame title="Club">
        <p>{t("This club is not visible to your wallet.")}</p>
        <Link href="/canton/clubs">{t("Clubs")}</Link>
      </TradingFrame>
    );
  const owner = club.data.owner,
    admins = list(club.data.admins),
    isOwner = owner === party,
    isAdmin = admins.includes(party),
    invitations = list(club.data.invitations).map(obj),
    wantedFactory = factoryRefKey(club.data.factoryRef),
    factory = contracts.find(
      (c) =>
        c.kind === "OutcomiaMarketFactory" &&
        factoryRefKey(c.data.ref) === wantedFactory,
    ),
    mayCreate = isAdmin || club.data.marketPolicy === "AnyMember",
    markets = clubMarkets(s.catalog?.contracts ?? [], club),
    listing = club.data.listing ? obj(club.data.listing) : null,
    requests = list(club.data.requests).map(obj),
    adminsFull = admins.length >= Number(text(club.data.adminCap));
  return (
    <TradingFrame
      title={text(club.data.name)}
      tools={<Link href="/canton/clubs">{t("Clubs")}</Link>}
    >
      <p>
        <ClubFacts club={club} />
      </p>
      <div className="canton-grid">
        <section className="canton-panel">
          <h2>{t("Markets")}</h2>
          <div className="canton-market-list">
            {markets.map((c) => {
              const data = marketRecord(c);
              return (
                <Link
                  className="canton-market-row"
                  href={marketLink(c)}
                  key={c.id}
                >
                  <h2>{text(obj(data.terms).question)}</h2>
                  <span>
                    {t(String(data.status ?? c.kind))} ·{" "}
                    {t(data.access ? "Members only" : "Anyone")}
                  </span>
                </Link>
              );
            })}
            {!markets.length ? <p>{t("No markets yet.")}</p> : null}
          </div>
        </section>
        <section className="canton-panel">
          <h2>{t("Members")}</h2>
          <dl>
            {list(club.data.members).map((m) => {
              const member = text(m),
                admin = admins.includes(member);
              return (
                <div key={member}>
                  <dt>
                    {t(member === owner ? "Owner" : admin ? "Admin" : "Member")}
                    {club.data.pendingOwner === member ? (
                      <> · {t("Nominated owner")}</>
                    ) : null}
                  </dt>
                  <dd>
                    <Party id={member} />{" "}
                    {isOwner && member !== owner ? (
                      <>
                        <ActionButton
                          disabled={!admin && adminsFull}
                          label={admin ? "Remove admin" : "Make admin"}
                          intent={{
                            action: "clubSetAdmin",
                            target: club.id,
                            values: {
                              wallet: member,
                              makeAdmin: admin ? "false" : "true",
                            },
                          }}
                        />{" "}
                        {club.data.pendingOwner !== member ? (
                          <ActionButton
                            label="Nominate as owner"
                            intent={{
                              action: "clubNominate",
                              target: club.id,
                              values: { wallet: member },
                            }}
                          />
                        ) : null}{" "}
                      </>
                    ) : null}
                    {isAdmin &&
                    member !== owner &&
                    member !== party &&
                    (!admin || isOwner) ? (
                      <ActionButton
                        label="Remove"
                        intent={{
                          action: "clubRemove",
                          target: club.id,
                          values: { wallet: member },
                        }}
                      />
                    ) : null}
                  </dd>
                </div>
              );
            })}
          </dl>
          {club.data.pendingOwner === party ? (
            <ActionButton
              label="Accept ownership"
              intent={{ action: "clubAcceptOwnership", target: club.id }}
            />
          ) : null}
          {isOwner && club.data.pendingOwner ? (
            <ActionButton
              label="Cancel nomination"
              intent={{ action: "clubNominate", target: club.id, values: {} }}
            />
          ) : null}
          {!isOwner ? (
            <ActionButton
              label="Leave club"
              intent={{ action: "clubLeave", target: club.id }}
            />
          ) : null}
        </section>
        {isAdmin ? (
          <section className="canton-panel">
            <h2>{t("Invitations")}</h2>
            <ActionForm
              label="Invite"
              fields={[{ name: "wallet", label: "Wallet party" }]}
              build={(v) => ({
                action: "clubInvite",
                target: club.id,
                values: { wallet: v.wallet },
              })}
            />
            <dl>
              {invitations.map((i) => (
                <div key={text(i.invitee)}>
                  <dt>
                    {t("Expires")}{" "}
                    {new Date(text(i.expiresAt)).toLocaleString()}
                  </dt>
                  <dd>
                    <Party id={i.invitee} />{" "}
                    <ActionButton
                      label="Revoke"
                      intent={{
                        action: "clubRevoke",
                        target: club.id,
                        values: { wallet: text(i.invitee) },
                      }}
                    />
                  </dd>
                </div>
              ))}
            </dl>
            {invitations.some(
              (i) => Date.parse(text(i.expiresAt)) <= Date.now(),
            ) ? (
              <ActionButton
                label="Clear expired"
                intent={{ action: "clubClear", target: club.id }}
              />
            ) : null}
            <h3>{t("Who can create markets")}</h3>
            <ActionForm
              label="Save"
              fields={[
                {
                  name: "policy",
                  label: "Market creators",
                  value: text(club.data.marketPolicy),
                  options: [
                    { value: "AdminsOnly", label: "Admins only" },
                    { value: "AnyMember", label: "Any member" },
                  ],
                },
              ]}
              build={(v) => ({
                action: "clubPolicy",
                target: club.id,
                values: { policy: v.policy },
              })}
            />
          </section>
        ) : null}
        {isAdmin && requests.length ? (
          <section className="canton-panel">
            <h2>{t("Join requests")}</h2>
            <dl>
              {requests.map((r) => (
                <div key={text(r.requester)}>
                  <dt>
                    {t("Expires")}{" "}
                    {new Date(text(r.expiresAt)).toLocaleString()}
                    {text(r.note ?? "") ? <> · “{text(r.note)}”</> : null}
                  </dt>
                  <dd>
                    <Party id={r.requester} />{" "}
                    <ActionButton
                      label="Approve"
                      intent={{
                        action: "clubApproveRequest",
                        target: club.id,
                        values: { wallet: text(r.requester) },
                      }}
                    />{" "}
                    <ActionButton
                      label="Reject"
                      intent={{
                        action: "clubCloseRequest",
                        target: club.id,
                        values: { wallet: text(r.requester) },
                      }}
                    />
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ) : null}
        {isOwner ? (
          <section className="canton-panel">
            <h2>{t("Club fees")}</h2>
            <p>
              {t(
                "The club earns a share of the taker fees in its markets. Withdraw it to your wallet.",
              )}
            </p>
            {clubBooks(s.catalog?.contracts ?? [], club).map((b) => {
              const owed = text(b.data.clubFees ?? "0");
              return (
                <div key={b.id}>
                  <p>
                    <strong>{text(obj(b.data.terms).question)}</strong> ·{" "}
                    {t("Owed to the club: {value0}", { value0: owed })} ·{" "}
                    {t("Share: {value0} bps", {
                      value0: text(b.data.clubShareBps ?? "0"),
                    })}
                  </p>
                  {Number(owed) > 0 ? (
                    <ActionForm
                      label="Withdraw club fees"
                      fields={[
                        { name: "amount", label: "Amount", value: owed },
                      ]}
                      build={(v) => ({
                        action:
                          b.kind === "MultiBook"
                            ? "clubWithdrawMultiFees"
                            : "clubWithdrawFees",
                        target: b.id,
                        values: { amount: v.amount },
                      })}
                    />
                  ) : null}
                </div>
              );
            })}
            {!clubBooks(s.catalog?.contracts ?? [], club).length ? (
              <p>{t("No club markets yet.")}</p>
            ) : null}
          </section>
        ) : null}
        {isOwner ? (
          <section className="canton-panel">
            <h2>{t("Listing")}</h2>
            {club.data.kind !== "PublicClub" ? (
              <p>
                {t(
                  "Private clubs are invite-only and cannot be listed for discovery.",
                )}
              </p>
            ) : (
              <>
                <p>
                  {listing
                    ? t(
                        listing.verifiedBy
                          ? "Listed and verified."
                          : "Awaiting verification by an Outcomia admin.",
                      )
                    : t("Not listed. List the club so wallets can find it.")}
                </p>
                <ActionForm
                  label={listing ? "Update listing" : "List club"}
                  fields={[
                    {
                      name: "visibility",
                      label: "Who can join",
                      value: text(listing?.visibility ?? "RequestToJoin"),
                      options: [
                        { value: "RequestToJoin", label: "Request to join" },
                        { value: "OpenToAll", label: "Open to all" },
                      ],
                    },
                    {
                      name: "topic",
                      label: "Topic",
                      value: text(listing?.topic ?? ""),
                    },
                    {
                      name: "description",
                      label: "Description",
                      value: text(listing?.description ?? ""),
                    },
                  ]}
                  build={(v) => ({
                    action: "clubSetListing",
                    target: club.id,
                    values: v,
                  })}
                />
                {listing ? (
                  <ActionButton
                    label="Close listing"
                    intent={{ action: "clubCloseListing", target: club.id }}
                  />
                ) : null}
              </>
            )}
          </section>
        ) : null}
        {factory && mayCreate ? (
          <section className="canton-panel">
            <h2>{t("Create a club market")}</h2>
            <FactoryMarketForm
              factory={factory}
              access={[
                { value: "club", label: "Members only" },
                { value: "public", label: "Anyone" },
              ]}
            />
          </section>
        ) : null}
      </div>
    </TradingFrame>
  );
}
