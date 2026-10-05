import { AntdRegistry } from "@ant-design/nextjs-registry";
import type { Metadata } from "next";
import { Source_Sans_3, Source_Serif_4 } from "next/font/google";
import { AppShell } from "@/components/ui/app-shell";
import { Providers } from "@/components/ui/providers";
import "./globals.css";

// Downloaded at build time and served from the app, so pages make no font request to Google.
const sans = Source_Sans_3({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const serif = Source_Serif_4({ subsets: ["latin"], variable: "--font-serif", display: "swap", weight: ["600", "700"] });

export const metadata: Metadata = {
  title: "Tradeflow",
  description: "A small stock portfolio ledger on synthetic data: transactions, holdings, P/L and the owner's own rules.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en-GB" className={`${sans.variable} ${serif.variable}`}>
      <body>
        <AntdRegistry>
          <Providers>
            <AppShell>{children}</AppShell>
          </Providers>
        </AntdRegistry>
      </body>
    </html>
  );
}
