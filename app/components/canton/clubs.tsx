"use client";
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

function Party({ id }: { id: unknown }) {
  const value = text(id);
  return (
    <code title={value}>
      {value.length > 28 ? `${value.slice(0, 12)}…${value.slice(-10)}` : value}
    </code>
  );
}

function pendingInvite(club: Contract, party?: string) {
  return list(club.data.invitations)
    .map(obj)
    .find((i) => i.invitee === party);
}

/** Clubs this wallet belongs to or is invited to, and club creation. */
export function CantonClubs() {
  const s = useCantonTrading(),
    { state: wallet } = useCantonWallet(),
    { t } = useI18n(),
    party = wallet.session?.partyId,
    clubs = s.owned.filter((c) => c.kind === "Club"),
    mine = clubs.filter((c) => list(c.data.members).includes(party)),
    invited = clubs.filter((c) => pendingInvite(c, party)),
    registry = s.catalog?.contracts.find((c) => c.kind === "ClubRegistry");
  return (
    <TradingFrame title="Clubs">
      <div className="canton-grid">
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
                  {list(c.data.members).length} {t("members")}
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
            <ActionForm
              label="Create club"
              fields={[{ name: "name", label: "Club name" }]}
              disabled={!party}
              build={(v) => ({
                action: "createClub",
                target: registry.id,
                values: { name: v.name },
              })}
            />
          ) : (
            <p>{t("Clubs are not deployed yet.")}</p>
          )}
        </section>
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
    markets = clubMarkets(s.catalog?.contracts ?? [], club);
  return (
    <TradingFrame
      title={text(club.data.name)}
      tools={<Link href="/canton/clubs">{t("Clubs")}</Link>}
    >
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
