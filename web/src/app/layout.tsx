import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Geist_Mono, Host_Grotesk } from "next/font/google";
import { Providers } from "@/components/Providers";
import { Nav } from "@/components/Nav";
import "./globals.css";

const hostGrotesk = Host_Grotesk({ subsets: ["latin"], weight: ["300", "400", "500", "600"], variable: "--font-host-grotesk", display: "swap" });
const geistMono = Geist_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-geist-mono", display: "swap" });

// The browser chrome colour has to be a literal here; it is the `ground` token from globals.css.
const GROUND = "#000000";

export const metadata: Metadata = {
  title: { default: "Vectis: leveraged prediction markets", template: "%s | Vectis" },
  description:
    "Trade Gemini prediction markets with up to 5x leverage. Margin and lending are in USDC and settle on Arc testnet.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: GROUND,
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${hostGrotesk.variable} ${geistMono.variable}`}>
      <body>
        <Providers>
          <Nav />
          <main id="top" className="wrap pb-24 pt-8 md:pt-12">
            {children}
          </main>
        </Providers>
      </body>
    </html>
  );
}
