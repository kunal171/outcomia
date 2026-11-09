import type { Metadata } from "next";
import { WalletWorkspace } from "../../components/wallet-workspace";
import "./wallet.css";

export const metadata: Metadata = { title: "Wallet | Outcomia" };
export default function WalletPage() {
  return <WalletWorkspace />;
}
