import { MultiOutcomeDetail } from "../../../../components/multi-outcome/detail";
export default async function Page({
  params,
}: {
  params: Promise<{ address: string }>;
}) {
  const { address } = await params;
  return <MultiOutcomeDetail address={address} />;
}
