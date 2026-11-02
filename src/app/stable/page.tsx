import type { Metadata } from "next";

import { StableScreen } from "@/components/stable-screen";
import { APP_NAME } from "@/lib/pwa/constants";

export const metadata: Metadata = {
  title: `Stable · ${APP_NAME}`,
};

export default function StablePage() {
  return (
    <main className="stable-shell">
      <header className="stable-shell__header">
        <h1>Stable</h1>
      </header>
      <StableScreen />
    </main>
  );
}
