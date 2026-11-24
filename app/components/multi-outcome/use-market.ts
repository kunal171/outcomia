"use client";
import { useIndexerUpdates } from "../use-indexer-updates";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { AnchorProvider } from "@anchor-lang/core";
import { PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { unpackMint, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { accountInfos } from "../../lib/indexed-accounts";
import {
  getOutcomiaAccounts,
  getOutcomiaProgram,
  getOutcomiaReadProgram,
  deriveProtocolConfigPda,
} from "../../lib/outcomia";
import { sharedAccounts, assetBalancePda } from "../../lib/shared";
import {
  MULTI_OUTCOME_ENABLED,
  multiAccounts,
  multiMarketPda,
  multiPositionPda,
  readMultiBook,
  transactionBytes,
} from "../../lib/multi-outcome";

export function useMultiMarket(address: string) {
  const { connection } = useConnection(),
    wallet = useAnchorWallet();
  const reader = useMemo(
    () => getOutcomiaReadProgram(connection),
    [connection],
  );
  const signed = useMemo(
    () => (wallet ? getOutcomiaProgram(connection, wallet) : null),
    [connection, wallet],
  );
  const owner = wallet?.publicKey.toBase58() ?? "",
    generation = useRef(0),
    live = useRef(owner),
    lock = useRef(false),
    mounted = useRef(false);
  live.current = owner;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [data, setData] = useState<
    | (Awaited<ReturnType<typeof load>> & { identity: string; address: string })
    | null
  >(null);
  const [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [signature, setSignature] = useState("");
  const load = useCallback(async () => {
    const key = new PublicKey(address),
      a = multiAccounts(reader),
      market = await a.multiOutcomeMarket.fetchNullable(key);
    if (!market)
      throw new Error("Multi-outcome market not found on this network.");
    if (!multiMarketPda(Uint8Array.from(market.marketId)).equals(key))
      throw new Error("Invalid market identity.");
    const [metadata, book, mint, position, cash, config] = await Promise.all([
      getOutcomiaAccounts(reader).marketMetadata.fetchNullable(market.metadata),
      readMultiBook(reader, key),
      accountInfos(connection, [market.collateralMint]).then((infos) =>
        unpackMint(market.collateralMint, infos[0], TOKEN_PROGRAM_ID),
      ),
      wallet
        ? a.multiOutcomePosition.fetchNullable(
            multiPositionPda(key, wallet.publicKey),
          )
        : Promise.resolve(null),
      wallet
        ? sharedAccounts(reader).assetBalance.fetchNullable(
            assetBalancePda(wallet.publicKey, market.collateralMint),
          )
        : Promise.resolve(null),
      getOutcomiaAccounts(reader).protocolConfig.fetchNullable(
        deriveProtocolConfigPda(),
      ),
    ]);
    if (metadata && !metadata.market.equals(key))
      throw new Error("Invalid market metadata.");
    if (!config) throw new Error("Protocol configuration is unavailable.");
    return {
      key,
      market,
      metadata,
      book,
      decimals: mint.decimals,
      position,
      cash,
      feeBps: config.takerFeeBps,
    };
  }, [reader, connection, wallet, address]);
  /** `quiet` (live updates) keeps the current data visible while reloading. */
  const refresh = useCallback(
    async (quiet = false) => {
      if (!MULTI_OUTCOME_ENABLED) return;
      const request = ++generation.current;
      // A background refresh must not wipe a message the user is reading
      // (e.g. a rejected signature), and a transient failure keeps the current
      // data on screen; the next update retries. Manual refreshes report errors.
      if (!quiet) {
        setLoading(true);
        setError("");
      }
      try {
        const value = await load();
        if (request === generation.current)
          setData({ ...value, identity: owner, address });
      } catch (e) {
        if (request === generation.current && !quiet) {
          setData(null);
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (request === generation.current) setLoading(false);
      }
    },
    [load, owner, address],
  );
  useEffect(() => {
    setData(null);
    setSignature("");
    void refresh();
    return () => {
      ++generation.current;
    };
  }, [refresh]);
  const send = async (
    build: () => Promise<Transaction | VersionedTransaction>,
  ) => {
    if (lock.current) return false;
    if (!MULTI_OUTCOME_ENABLED || !wallet || !signed) {
      setError("Connect a wallet to a verified multi-outcome deployment.");
      return false;
    }
    lock.current = true;
    setBusy(true);
    setError("");
    setSignature("");
    const expected = owner;
    try {
      const tx = await build();
      // v0 serialization does not enforce the packet limit; check it here.
      if (tx instanceof VersionedTransaction) {
        if (tx.serialize().length > 1232)
          throw new Error(
            "Transaction exceeds 1,232 bytes. Submit a smaller quantity.",
          );
      } else transactionBytes(tx, wallet.publicKey);
      if (!mounted.current || live.current !== expected)
        throw new Error("Wallet changed. Refresh before signing.");
      const result = await (signed.provider as AnchorProvider).sendAndConfirm(
        tx,
      );
      if (mounted.current && live.current === expected) {
        setSignature(result);
        await refresh();
        return mounted.current && live.current === expected;
      }
      return false;
    } catch (e) {
      if (mounted.current && live.current === expected)
        setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  useIndexerUpdates(() => {
    if (!lock.current) void refresh(true);
  }, [address, owner]);
  return {
    data: data?.identity === owner && data.address === address ? data : null,
    reader,
    signed,
    wallet,
    loading,
    busy,
    error,
    signature,
    refresh,
    send,
  };
}
export type MultiSession = ReturnType<typeof useMultiMarket>;
