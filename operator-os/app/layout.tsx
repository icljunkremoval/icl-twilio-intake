import type { Metadata } from "next";
import type { Viewport } from "next";
import { IBM_Plex_Mono } from "next/font/google";
import { AppBootstrap } from "@/components/AppBootstrap";
import "./globals.css";

const ibmPlexMono = IBM_Plex_Mono({
  weight: ["400", "500", "600", "700"],
  variable: "--font-ibm-plex-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Operator OS",
  description: "Personal command center for daily discipline, momentum, and mission execution.",
  manifest: "/manifest.json",
  applicationName: "Operator OS",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Operator OS",
  },
};

export const viewport: Viewport = {
  themeColor: "#060610",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${ibmPlexMono.variable} antialiased`}>
        <AppBootstrap />
        {children}
      </body>
    </html>
  );
}
