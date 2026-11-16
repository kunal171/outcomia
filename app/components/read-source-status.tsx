"use client";
import { useSyncExternalStore } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { hasRpcFallback, subscribeReadSource } from "../lib/read-source";

export function ReadSourceStatus() {
  const { publicKey } = useWallet();
  const fallback = useSyncExternalStore(
    subscribeReadSource,
    () => hasRpcFallback(publicKey?.toBase58()),
    () => false,
  );
  return (
    <small
      className="indexed-commitment"
      title={fallback
        ? "Live reads are using Solana RPC. GraphQL is retried automatically. Historical charts require indexed executions."
        : "Books and balances use confirmed indexed data. Charts show finalized executions."}
    >
      {fallback ? "RPC fallback · confirmed" : "GraphQL live · confirmed"}
    </small>
  );
}
