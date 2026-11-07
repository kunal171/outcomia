import type { Metadata } from "next";
import { cookies } from "next/headers";
import { isLocale, isTheme } from "../i18n/config";
import { PreferencesProvider } from "../components/preferences-provider";
import "@solana/wallet-adapter-react-ui/styles.css";
import "./globals.css";
import "./landing.css";
import "./navigation.css";
import "./prediction-detail.css";
import "./theme.css";
import { SolanaProvider } from "@/components/solana-provider";

export const metadata: Metadata = {
  title: "Tidebook | Prediction markets on Solana",
  description:
    "Explore YES/NO prediction markets on Solana, with limit orders and transparent market rules. Spot trading also available.",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const preferences = await cookies();
  const savedLocale = preferences.get("tidebook_locale")?.value;
  const savedTheme = preferences.get("tidebook_theme")?.value;
  const locale = isLocale(savedLocale) ? savedLocale : "en";
  const theme = isTheme(savedTheme) ? savedTheme : "system";
  return (
    <html lang={locale} data-theme={theme}>
      <body>
        <PreferencesProvider initialLocale={locale} initialTheme={theme}>
          <SolanaProvider>{children}</SolanaProvider>
        </PreferencesProvider>
      </body>
    </html>
  );
}
