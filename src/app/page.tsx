import Link from "next/link";

import { NavIcon } from "@/components/nav-icon";
import { NAV_ITEMS } from "@/components/nav-items";
import { APP_NAME } from "@/lib/pwa/constants";

export default function Home() {
  return (
    <main className="home-shell">
      <header className="app-header">
        <div className="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 64 64" fill="none"><path d="m32 5 24 14v27L32 59 8 46V19L32 5Z" /><path d="m32 5-13 34h26L32 5ZM8 19l11 20-11 7m48-27L45 39l11 7M19 39l13 20 13-20M8 19h48" /></svg>
        </div>
        <span className="brand-caption">THE DUNGEON MASTER’S COMPANION</span>
        <h1>{APP_NAME}</h1>
        <p>Your story. Your table.<br />A little help behind the screen.</p>
      </header>

      {/* A landing grid, not a second nav landmark: the bottom nav is the primary navigation. */}
      <section className="toolkit" aria-labelledby="toolkit-title">
        <div className="section-heading">
          <h2 id="toolkit-title">At your fingertips</h2>
          <span aria-hidden="true">I — IV</span>
        </div>
        <ul className="nav-list">
          {NAV_ITEMS.map((item) => (
            <li key={item.href}>
              <Link href={item.href} className="feature-card">
                <span className="feature-icon" aria-hidden="true">
                  <NavIcon name={item.icon} />
                </span>
                <span className="feature-copy">
                  <span className="feature-label">{item.label}</span>
                  <span className="feature-description">{item.description}</span>
                </span>
                <span className="card-arrow" aria-hidden="true">↗</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
      <footer className="app-footer"><span aria-hidden="true">✦</span> Less searching. More storytelling.</footer>
    </main>
  );
}
