import { CantonClub } from "../../../../components/canton/clubs";
export default async function Page({
  params,
}: {
  params: Promise<{ clubId: string }>;
}) {
  const { clubId } = await params;
  return <CantonClub clubId={clubId} />;
}
