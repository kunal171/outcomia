"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { AnchorProvider } from "@anchor-lang/core";
import { PublicKey, Transaction } from "@solana/web3.js";
import { getMint } from "@solana/spl-token";
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
    lock = useRef(false);
  live.current = owner;
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
      getMint(connection, market.collateralMint),
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
  const refresh = useCallback(async () => {
    if (!MULTI_OUTCOME_ENABLED) return;
    const request = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const value = await load();
      if (request === generation.current)
        setData({ ...value, identity: owner, address });
    } catch (e) {
      if (request === generation.current) {
        setData(null);
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, [load, owner, address]);
  useEffect(() => {
    setData(null);
    setSignature("");
    void refresh();
    return () => {
      ++generation.current;
    };
  }, [refresh]);
  const send = async (build: () => Promise<Transaction>) => {
    if (lock.current) return;
    if (!MULTI_OUTCOME_ENABLED || !wallet || !signed) {
      setError("Connect a wallet to a verified multi-outcome deployment.");
      return;
    }
    lock.current = true;
    setBusy(true);
    setError("");
    setSignature("");
    const expected = owner;
    try {
      const tx = await build();
      transactionBytes(tx, wallet.publicKey);
      if (live.current !== expected)
        throw new Error("Wallet changed. Refresh before signing.");
      const result = await (signed.provider as AnchorProvider).sendAndConfirm(
        tx,
      );
      if (live.current === expected) {
        setSignature(result);
        await refresh();
      }
    } catch (e) {
      if (live.current === expected)
        setError(e instanceof Error ? e.message : String(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
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
