import type { Metadata } from "next";
import Link from "next/link";

import { MonsterSearch } from "@/components/monster-search";
import { APP_NAME } from "@/lib/pwa/constants";

export const metadata: Metadata = {
  title: `Monsters · ${APP_NAME}`,
};

export default function MonstersPage() {
  return (
    <main className="monsters-shell">
      <header className="monsters-shell__header">
        <Link href="/" className="monsters-shell__back">
          ← Home
        </Link>
        <h1>Monsters</h1>
      </header>
      <MonsterSearch />
    </main>
  );
}
