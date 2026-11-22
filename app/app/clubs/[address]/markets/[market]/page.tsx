import { ClubMarket } from "../../../../../components/clubs/club-market";

export default async function ClubMarketPage({
  params,
}: {
  params: Promise<{ address: string; market: string }>;
}) {
  const { address, market } = await params;
  return <ClubMarket clubAddress={address} marketAddress={market} />;
}
