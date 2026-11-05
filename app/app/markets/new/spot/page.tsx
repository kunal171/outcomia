import type { Metadata } from "next";
import { CreateMarket } from "../../../../components/create-market";

export const metadata: Metadata = { title: "Create spot market · Tidebook" };

export default function CreateSpotMarketPage() {
  return <CreateMarket />;
}
