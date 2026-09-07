import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CVG Diagnostics Hub",
  description: "Central operacional de exames diagnósticos",
  icons: { icon: [{ url: "/icon.svg", type: "image/svg+xml" }] },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR" data-scroll-behavior="smooth">
      <body>{children}</body>
    </html>
  );
}
