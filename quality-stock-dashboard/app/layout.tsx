import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Quality — Stock Research",
  description: "Explore stock prices, cash generation and company quality with financial metrics inspired by Terry Smith.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
