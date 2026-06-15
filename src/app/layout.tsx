import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AgriAI Precision Platform",
  description: "Precision irrigation, pest detection, and IoT automation platform"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ar" dir="rtl">
      <body>{children}</body>
    </html>
  );
}
