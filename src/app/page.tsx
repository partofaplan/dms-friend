import Link from "next/link";

import { NAV_ITEMS } from "@/components/nav-items";
import { APP_NAME } from "@/lib/pwa/constants";

const featureIcons = [
  <path key="roster" d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m18 0v-2a4 4 0 0 0-3-3.87M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm8-7.87a4 4 0 0 1 0 7.75" />,
  <path key="monsters" d="m5 3 4 5h6l4-5v11l-3 6h-8l-3-6V3Zm3 9 2 1m6-1-2 1m-4 4h4" />,
  <path key="chat" d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5A8.5 8.5 0 0 1 10.5 3h2a8.5 8.5 0 0 1 8.5 8.5ZM7 10h9M7 14h6" />,
  <path key="scan" d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M8 7h8v10H8V7Zm-3 5h14" />,
];

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

      <section className="toolkit" aria-labelledby="toolkit-title">
        <div className="section-heading">
          <h2 id="toolkit-title">At your fingertips</h2>
          <span aria-hidden="true">I — IV</span>
        </div>
        <nav aria-label="Main">
          <ul className="nav-list">
            {NAV_ITEMS.map((item, index) => (
              <li key={item.href}>
                <Link href={item.href} className="feature-card">
                  <span className="feature-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">{featureIcons[index]}</svg>
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
        </nav>
      </section>
      <footer className="app-footer"><span aria-hidden="true">✦</span> Less searching. More storytelling.</footer>
    </main>
  );
}
