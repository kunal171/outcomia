import type { Metadata } from "next";
import { CreateMarketChooser } from "../../../components/create-market-chooser";

export const metadata: Metadata = {
  title: "Create market · Outcomia",
};

export default function CreateMarketPage() {
  return <CreateMarketChooser />;
}
