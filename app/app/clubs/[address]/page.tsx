import { ClubDetail } from "../../../components/clubs/club-detail";

export default async function ClubPage({
  params,
}: {
  params: Promise<{ address: string }>;
}) {
  const { address } = await params;
  return <ClubDetail address={address} />;
}
