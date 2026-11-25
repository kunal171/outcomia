import type { Metadata } from "next";
import { ProfilePage } from "../../../components/social/profile-page";

export const metadata: Metadata = { title: "Profile | Outcomia" };
export default async function Profile({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return <ProfilePage id={(await params).id} />;
}
