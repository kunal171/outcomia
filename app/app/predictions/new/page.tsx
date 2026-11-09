import type { Metadata } from "next";
import { CreatePredictionMarket } from "../../../components/create-prediction-market";

export const metadata: Metadata = {
  title: "Create prediction market · Outcomia",
};

export default function CreatePredictionMarketPage() {
  return <CreatePredictionMarket />;
}
