import type { Metadata } from "next";

import { RosterScreen } from "@/components/roster-screen";
import { APP_NAME } from "@/lib/pwa/constants";

export const metadata: Metadata = {
  title: `Roster · ${APP_NAME}`,
};

export default function RosterPage() {
  return (
    <main className="roster-shell">
      <header className="roster-shell__header">
        <h1>Roster</h1>
      </header>
      <RosterScreen />
    </main>
  );
}
