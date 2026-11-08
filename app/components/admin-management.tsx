"use client";
import { useI18n } from "./preferences-provider";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  decodeAdminStatus,
  deriveAdminRecordPda,
  deriveProgramDataAddress,
  deriveProtocolConfigPda,
  getTidebookAccounts,
  getTidebookProgram,
  transactionExplorerUrl,
  type AdminRecordView,
} from "../lib/tidebook";
import { PROGRAM_ID } from "../lib/solana";
import { AppHeader } from "./app-header";
import { useProtocolRole } from "./protocol-role-provider";

type AdminAction = "add" | "disable" | "enable" | "remove";

function shortAddress(address: PublicKey) {
  const value = address.toBase58();
  return `${value.slice(0, 6)}…${value.slice(-6)}`;
}

function getErrorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : "Transaction failed";
}

export function AdminManagement() {
  const { t } = useI18n();

  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const {
    role,
    loading: roleLoading,
    error: roleError,
    refresh: refreshRole,
  } = useProtocolRole();
  const [newAdmin, setNewAdmin] = useState("");
  const [takerFeeBps, setTakerFeeBps] = useState<number | null>(null);
  const [feeRateInput, setFeeRateInput] = useState("0");
  const [admins, setAdmins] = useState<AdminRecordView[]>([]);
  const [loadingAdmins, setLoadingAdmins] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);

  const program = useMemo(
    () => (wallet ? getTidebookProgram(connection, wallet) : null),
    [connection, wallet],
  );

  const loadAdmins = useCallback(async () => {
    if (!program || role !== "super-admin") return;

    setLoadingAdmins(true);
    setError(null);

    try {
      const accounts = getTidebookAccounts(program);
      const [records, protocolConfig] = await Promise.all([
        accounts.adminRecord.all(),
        accounts.protocolConfig.fetchNullable(deriveProtocolConfigPda()),
      ]);
      if (!protocolConfig) {
        throw new Error("Protocol configuration was not found");
      }
      setTakerFeeBps(protocolConfig.takerFeeBps);
      setFeeRateInput(protocolConfig.takerFeeBps.toString());
      setAdmins(
        records
          .map(({ publicKey, account }) => ({
            address: publicKey,
            authority: account.authority,
            addedBy: account.addedBy,
            status: decodeAdminStatus(account.status),
          }))
          .sort((left, right) =>
            left.authority.toBase58().localeCompare(right.authority.toBase58()),
          ),
      );
    } catch (cause) {
      setError(getErrorMessage(cause));
    } finally {
      setLoadingAdmins(false);
    }
  }, [program, role]);

  useEffect(() => {
    void loadAdmins();
  }, [loadAdmins]);

  const initializeProtocol = async () => {
    if (!program || !wallet) return;

    setPending("initialize");
    setError(null);
    setSignature(null);

    try {
      const tx = await program.methods
        .initializeProtocol()
        .accounts({
          deployer: wallet.publicKey,
          protocolConfig: deriveProtocolConfigPda(),
          deployerAdmin: deriveAdminRecordPda(wallet.publicKey),
          program: PROGRAM_ID,
          programData: deriveProgramDataAddress(),
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      setSignature(tx);
      await refreshRole();
    } catch (cause) {
      setError(getErrorMessage(cause));
    } finally {
      setPending(null);
    }
  };

  const runAdminAction = async (action: AdminAction, target: PublicKey) => {
    if (!program || !wallet) return;

    setPending(`${action}:${target.toBase58()}`);
    setError(null);
    setSignature(null);

    const commonAccounts = {
      superAdmin: wallet.publicKey,
      protocolConfig: deriveProtocolConfigPda(),
      adminRecord: deriveAdminRecordPda(target),
    };

    try {
      let tx: string;

      if (action === "add") {
        tx = await program.methods
          .addAdmin(target)
          .accounts({
            ...commonAccounts,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
      } else if (action === "disable") {
        tx = await program.methods
          .disableAdmin(target)
          .accounts(commonAccounts)
          .rpc();
      } else if (action === "enable") {
        tx = await program.methods
          .enableAdmin(target)
          .accounts(commonAccounts)
          .rpc();
      } else {
        tx = await program.methods
          .removeAdmin(target)
          .accounts(commonAccounts)
          .rpc();
      }

      setSignature(tx);
      setNewAdmin("");
      await loadAdmins();
      await refreshRole();
    } catch (cause) {
      setError(getErrorMessage(cause));
    } finally {
      setPending(null);
    }
  };

  const submitNewAdmin = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    try {
      await runAdminAction("add", new PublicKey(newAdmin.trim()));
    } catch {
      setError("Enter a valid Solana public key");
    }
  };

  const updateTakerFee = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!program || !wallet) return;

    const normalized = feeRateInput.trim();
    if (!/^[0-9]+$/.test(normalized)) {
      setError("Taker fee must be a whole number of basis points");
      return;
    }
    const nextFeeBps = Number(normalized);
    if (!Number.isSafeInteger(nextFeeBps) || nextFeeBps > 1_000) {
      setError("Taker fee must be between 0 and 1,000 basis points");
      return;
    }

    setPending("set-fee");
    setError(null);
    setSignature(null);
    try {
      const tx = await program.methods
        .setTakerFee(nextFeeBps)
        .accounts({
          superAdmin: wallet.publicKey,
          protocolConfig: deriveProtocolConfigPda(),
        })
        .rpc();
      setSignature(tx);
      setTakerFeeBps(nextFeeBps);
      await loadAdmins();
    } catch (cause) {
      setError(getErrorMessage(cause));
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="app-shell">
      <AppHeader />
      <main className="route-shell">
        <div className="route-heading">
          <h1>{t("Administrator control")}</h1>
        </div>

        {!wallet && (
          <div className="access-card">
            {t("Connect your wallet to continue.")}
          </div>
        )}

        {wallet && roleLoading && (
          <div className="access-card">{t("Checking protocol role…")}</div>
        )}

        {wallet && !roleLoading && role === "uninitialized" && (
          <section className="access-card">
            <h2>{t("Initialize protocol governance")}</h2>
            <p>
              {t(
                "Only the program upgrade authority can initialize governance.",
              )}
            </p>
            <button
              className="primary-button"
              type="button"
              disabled={pending !== null}
              onClick={() => void initializeProtocol()}
            >
              {pending === "initialize"
                ? t("Initializing…")
                : t("Initialize protocol")}
            </button>
          </section>
        )}

        {wallet &&
          !roleLoading &&
          !roleError &&
          role !== "super-admin" &&
          role !== "uninitialized" && (
            <div className="access-card access-denied">
              {t("This route requires the active super-admin wallet.")}
            </div>
          )}

        {wallet && !roleLoading && role === "super-admin" && (
          <div className="admin-layout">
            <section className="admin-card">
              <div className="card-label">{t("Trading fees")}</div>
              <h2>{t("Global taker fee")}</h2>
              <p>
                {t("Current rate: {value0} bps{value1}", {
                  value0: takerFeeBps ?? "—",
                  value1:
                    takerFeeBps === null
                      ? ""
                      : ` (${(takerFeeBps / 100).toFixed(2)}%)`,
                })}
              </p>
              <form className="admin-form" onSubmit={updateTakerFee}>
                <label>
                  {t("Basis points (0–1,000)")}
                  <input
                    inputMode="numeric"
                    value={feeRateInput}
                    onChange={(event) => setFeeRateInput(event.target.value)}
                    autoComplete="off"
                  />
                </label>
                <button
                  className="primary-button"
                  type="submit"
                  disabled={pending !== null}
                >
                  {pending === "set-fee" ? t("Updating…") : t("Update fee")}
                </button>
              </form>
            </section>

            <section className="admin-card">
              <div className="card-label">{t("Add administrator")}</div>
              <form
                className="admin-form"
                onSubmit={(event) => void submitNewAdmin(event)}
              >
                <label>
                  {t("Wallet address")}
                  <input
                    value={newAdmin}
                    onChange={(event) => setNewAdmin(event.target.value)}
                    placeholder={t("Administrator public key")}
                    autoComplete="off"
                  />
                </label>
                <button
                  className="primary-button"
                  type="submit"
                  disabled={!newAdmin.trim() || pending !== null}
                >
                  {pending?.startsWith("add:") ? t("Adding…") : t("Add admin")}
                </button>
              </form>
            </section>

            <section className="admin-card admin-list-card">
              <div className="admin-list-heading">
                <div>
                  <div className="card-label">{t("On-chain records")}</div>
                  <h2>{t("Administrators")}</h2>
                </div>
                <button
                  className="text-button"
                  type="button"
                  disabled={loadingAdmins}
                  onClick={() => void loadAdmins()}
                >
                  {loadingAdmins ? t("Refreshing…") : t("Refresh")}
                </button>
              </div>

              <div className="admin-list">
                {!loadingAdmins && admins.length === 0 && (
                  <p>{t("No admin records found.")}</p>
                )}
                {admins.map((admin) => {
                  const isSuperAdmin = admin.authority.equals(wallet.publicKey);
                  const actionKey = `${admin.status === "active" ? "disable" : "enable"}:${admin.authority.toBase58()}`;

                  return (
                    <article
                      className="admin-row"
                      key={admin.address.toBase58()}
                    >
                      <div>
                        <strong>{shortAddress(admin.authority)}</strong>
                        <span className={`role-badge role-${admin.status}`}>
                          {isSuperAdmin ? t("Super admin") : admin.status}
                        </span>
                        <p>
                          {t("Added by {value0}", {
                            value0: shortAddress(admin.addedBy),
                          })}
                        </p>
                      </div>
                      {!isSuperAdmin && (
                        <div className="admin-actions">
                          <button
                            className="admin-action-button"
                            type="button"
                            disabled={pending !== null}
                            onClick={() =>
                              void runAdminAction(
                                admin.status === "active"
                                  ? "disable"
                                  : "enable",
                                admin.authority,
                              )
                            }
                          >
                            {pending === actionKey
                              ? t("Submitting…")
                              : admin.status === "active"
                                ? t("Disable")
                                : t("Enable")}
                          </button>
                          <button
                            className="danger-button"
                            type="button"
                            disabled={
                              admin.status !== "disabled" || pending !== null
                            }
                            onClick={() =>
                              void runAdminAction("remove", admin.authority)
                            }
                          >
                            {pending === `remove:${admin.authority.toBase58()}`
                              ? t("Removing…")
                              : t("Remove")}
                          </button>
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            </section>
          </div>
        )}

        {(roleError || error) && (
          <div className="transaction-message transaction-error">
            {roleError || error}
          </div>
        )}
        {signature && (
          <div className="transaction-message transaction-success">
            {t("Transaction confirmed.")}{" "}
            <a
              href={transactionExplorerUrl(signature)}
              target="_blank"
              rel="noreferrer"
            >
              {t("View on Explorer ↗")}
            </a>
          </div>
        )}
      </main>
    </div>
  );
}
