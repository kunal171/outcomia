import { PredictionMarkets } from "../../../components/prediction-markets";

export default async function PredictionDetailPage({
  params,
}: {
  params: Promise<{ address: string }>;
}) {
  const { address } = await params;
  return <PredictionMarkets address={address} />;
}
