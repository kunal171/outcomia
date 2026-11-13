import { Balances } from "../../../components/canton/trading-ui";
import { CantonWallet } from "../../../components/canton/wallet";

export default function CantonWalletPage() {
  return (
    <>
      <CantonWallet />
      <Balances />
    </>
  );
}
