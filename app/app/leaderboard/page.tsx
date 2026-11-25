import type { Metadata } from "next";
import { LeaderboardPage } from "../../components/social/leaderboard-page";

export const metadata: Metadata = { title: "Leaderboard | Outcomia" };
export default function Leaderboard() {
  return <LeaderboardPage />;
}
