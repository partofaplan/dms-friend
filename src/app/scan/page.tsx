import type { Metadata } from "next";

import { ScanScreen } from "@/components/scan-screen";
import { APP_NAME } from "@/lib/pwa/constants";

export const metadata: Metadata = {
  title: `Scan · ${APP_NAME}`,
};

export default function ScanPage() {
  return (
    <main className="scan-shell">
      <header className="scan-shell__header">
        <h1>Scan</h1>
      </header>
      <ScanScreen />
    </main>
  );
}
