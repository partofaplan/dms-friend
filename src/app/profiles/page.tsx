import type { Metadata } from "next";

import { ProfilesScreen } from "@/components/profiles-screen";
import { APP_NAME } from "@/lib/pwa/constants";

export const metadata: Metadata = {
  title: `Profiles · ${APP_NAME}`,
};

export default function ProfilesPage() {
  return (
    <main className="profiles-shell">
      <header className="profiles-shell__header">
        <h1>Profiles</h1>
      </header>
      <ProfilesScreen />
    </main>
  );
}
