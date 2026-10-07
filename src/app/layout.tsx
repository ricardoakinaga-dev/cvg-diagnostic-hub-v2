import type { Metadata } from "next";
import { connection } from "next/server";
import "./globals.css";
import "./plane.css";

export const metadata: Metadata = {
  title: "CVG Diagnostics Hub",
  description: "Central operacional de exames diagnósticos",
  icons: { icon: [{ url: "/icon.svg", type: "image/svg+xml" }] },
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // The CSP nonce is generated per request by src/proxy.ts; static prerendering
  // would ship scripts without it and 'strict-dynamic' would block them.
  await connection();
  return (
    <html lang="pt-BR" data-scroll-behavior="smooth">
      <body>{children}</body>
    </html>
  );
}
