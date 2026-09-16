import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Value — Investment Research",
  description: "Research business quality, cash generation, scenario valuations and margin of safety with transparent financial assumptions.",
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
