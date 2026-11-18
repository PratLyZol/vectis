import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Geist_Mono, Host_Grotesk } from "next/font/google";
import { Providers } from "@/components/Providers";
import { Nav } from "@/components/Nav";
import { contracts, isMock } from "@/config/contracts";
import "./globals.css";

const hostGrotesk = Host_Grotesk({ subsets: ["latin"], weight: ["300", "400", "500", "600"], variable: "--font-host-grotesk", display: "swap" });
const geistMono = Geist_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-geist-mono", display: "swap" });

// The browser chrome colour has to be a literal here; it is the `ground` token from globals.css.
const GROUND = "#000000";
const EXPLORER = "https://explorer.testnet.arc.io";

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
          <footer className="over-field border-t border-border bg-ground">
            <div className="wrap flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-6 text-[13px] text-muted">
              <p>Vectis is a hackathon build on Arc testnet. Testnet USDC has no value.</p>
              {isMock ? null : (
                <p>
                  <a className="link link-tap" href={`${EXPLORER}/address/${contracts.marginManager}`} target="_blank" rel="noreferrer">
                    Margin contract on the Arc explorer
                  </a>
                </p>
              )}
              <p>
                Market data from{" "}
                <a className="link link-tap" href="https://www.gemini.com/prediction-markets" target="_blank" rel="noreferrer">
                  Gemini prediction markets
                </a>
              </p>
            </div>
          </footer>
        </Providers>
      </body>
    </html>
  );
}
