import type { Metadata } from "next";
import { IBM_Plex_Sans_Arabic, Inter } from "next/font/google";
import "./globals.css";

// Latin UI font. Variable, so one load covers every weight we use.
const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sans",
  fallback: ["system-ui", "-apple-system", "Segoe UI", "Helvetica Neue", "sans-serif"],
});

// Arabic companion. Inter has no Arabic glyphs, so the browser falls through to
// this for Arabic text - that is why both are listed in --font-stack.
const plexArabic = IBM_Plex_Sans_Arabic({
  weight: ["400", "500", "600"],
  subsets: ["arabic"],
  display: "swap",
  variable: "--font-arabic",
  fallback: ["Segoe UI", "Tahoma", "sans-serif"],
});

export const metadata: Metadata = {
  title: "Support Assistant",
  description: "Ask about an order, returns, shipping or warranty.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${inter.variable} ${plexArabic.variable}`}>
      <body>{children}</body>
    </html>
  );
}
