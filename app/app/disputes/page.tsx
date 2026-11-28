import type { Metadata } from "next";
import { DisputeQueue } from "../../components/dispute-queue";

export const metadata: Metadata = {
  title: "Disputes · Outcomia",
};

export default function DisputesPage() {
  return <DisputeQueue />;
}
