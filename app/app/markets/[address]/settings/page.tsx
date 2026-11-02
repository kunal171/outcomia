import { MarketSettings } from "../../../../components/market-settings";

export default async function MarketSettingsPage({
  params,
}: {
  params: Promise<{ address: string }>;
}) {
  const { address } = await params;
  return <MarketSettings address={address} />;
}
