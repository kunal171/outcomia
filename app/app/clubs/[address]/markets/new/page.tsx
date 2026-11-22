import { CreatePredictionMarket } from "../../../../../components/create-prediction-market";

export default async function NewClubMarketPage({
  params,
}: {
  params: Promise<{ address: string }>;
}) {
  const { address } = await params;
  return <CreatePredictionMarket club={address} />;
}
