import { MarketDetail } from "../../../../components/canton/trading-ui";
export default async function Page({
  params,
}: {
  params: Promise<{ marketId: string }>;
}) {
  const { marketId } = await params;
  return <MarketDetail marketId={marketId} />;
}
