import type { Metadata } from "next";
import { FaucetPage } from "../../components/faucet-page";

export const metadata: Metadata = { title: "Faucet | Outcomia" };
export default function Faucet() {
  return <FaucetPage />;
}
