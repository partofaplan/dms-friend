import type { Metadata, Viewport } from "next";

import { ActiveScopeBar } from "@/components/active-scope-bar";
import { BottomNav } from "@/components/bottom-nav";
import { OfflineBanner } from "@/components/offline-status";
import { ServiceWorkerRegistration } from "@/components/service-worker-registration";
import { APP_DESCRIPTION, APP_NAME, THEME_COLOR } from "@/lib/pwa/constants";

import "./globals.css";

export const metadata: Metadata = {
  title: APP_NAME,
  description: APP_DESCRIPTION,
  applicationName: APP_NAME,
  appleWebApp: {
    capable: true,
    title: APP_NAME,
    statusBarStyle: "default",
  },
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon.svg", type: "image/svg+xml" },
    ],
    apple: [{ url: "/icons/icon-192.png", sizes: "192x192" }],
  },
};

export const viewport: Viewport = {
  themeColor: THEME_COLOR,
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="app-body min-h-dvh antialiased">
        <OfflineBanner />
        <ActiveScopeBar />
        {/* Leaves room for the fixed bottom nav (see .app-content in globals.css). */}
        <div className="app-content">{children}</div>
        <BottomNav />
        <ServiceWorkerRegistration />
      </body>
    </html>
  );
}
