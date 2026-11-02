import type { Metadata } from "next";
import "@solana/wallet-adapter-react-ui/styles.css";
import "./globals.css";
import { SolanaProvider } from "@/components/solana-provider";

export const metadata: Metadata = {
  title: "Tidebook | On-chain limit order book",
  description:
    "A working central limit order book on Solana with FIFO matching and atomic settlement.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <SolanaProvider>{children}</SolanaProvider>
      </body>
    </html>
  );
}
