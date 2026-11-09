import type { Metadata } from "next";
import { AdminManagement } from "../../components/admin-management";

export const metadata: Metadata = {
  title: "Manage administrators · Outcomia",
};

export default function AdminPage() {
  return <AdminManagement />;
}
