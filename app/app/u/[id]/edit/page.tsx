import type { Metadata } from "next";
import { ProfileEditPage } from "../../../../components/social/profile-edit-page";

export const metadata: Metadata = { title: "Edit profile | Outcomia" };
export default async function EditProfile({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return <ProfileEditPage id={(await params).id} />;
}
