import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { cookies } from "next/headers";
import { isLocale, isTheme } from "../i18n/config";
import { PreferencesProvider } from "../components/preferences-provider";
import "@solana/wallet-adapter-react-ui/styles.css";
import "./globals.css";
import "./landing.css";
import "./navigation.css";
import "./prediction-detail.css";
import "./theme.css";
import "./design.css";
import { SolanaProvider } from "@/components/solana-provider";
import { CantonWalletProvider } from "@/components/canton-wallet-provider";
import { NetworkWalletProvider } from "@/components/network-wallet-provider";
import { NetworkBoundary } from "@/components/network-workspace";
import "./network.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist" });
const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
});

export const metadata: Metadata = {
  title: "Outcomia | Every Outcome Has a Market.",
  description:
    "Prediction markets on Solana and Canton. Connect your wallet to choose your network.",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const preferences = await cookies();
  const savedLocale =
    preferences.get("outcomia_locale")?.value ??
    preferences.get("tidebook_locale")?.value;
  const savedTheme =
    preferences.get("outcomia_theme")?.value ??
    preferences.get("tidebook_theme")?.value;
  const locale = isLocale(savedLocale) ? savedLocale : "en";
  const theme = isTheme(savedTheme) ? savedTheme : "dark";
  return (
    <html
      lang={locale}
      data-theme={theme}
      className={`${geist.variable} ${geistMono.variable}`}
    >
      <body>
        <PreferencesProvider initialLocale={locale} initialTheme={theme}>
          <SolanaProvider>
            <CantonWalletProvider>
              <NetworkWalletProvider>
                <NetworkBoundary>{children}</NetworkBoundary>
              </NetworkWalletProvider>
            </CantonWalletProvider>
          </SolanaProvider>
        </PreferencesProvider>
      </body>
    </html>
  );
}
