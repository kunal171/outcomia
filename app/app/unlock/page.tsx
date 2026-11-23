import type { Metadata } from "next";
import { UnlockForm } from "../../components/landing/unlock";
import { safeNext } from "../../lib/gate";

export const metadata: Metadata = {
  title: "Outcomia | Early access",
  robots: { index: false },
};

export default async function UnlockPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;
  return (
    <UnlockForm
      next={safeNext(next)}
      error={error === "1" || error === "unset" ? error : undefined}
    />
  );
}
