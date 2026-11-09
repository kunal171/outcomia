import type { Metadata } from "next";
import { CreateMarket } from "../../../../components/create-market";

export const metadata: Metadata = { title: "Create spot market · Outcomia" };

export default function CreateSpotMarketPage() {
  return <CreateMarket />;
}
