import Link from "next/link";

import { NavIcon } from "@/components/nav-icon";
import { NAV_ITEMS } from "@/components/nav-items";
import { ProfileIntroNudge } from "@/components/profile-intro-nudge";
import { APP_NAME } from "@/lib/pwa/constants";

export default function Home() {
  return (
    <main className="home-shell">
      <header className="app-header">
        <div className="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 360 210" fill="none" focusable="false">
            <path d="M73 8v30M287 8v30" stroke="#a58450" strokeWidth="5" />
            <path d="M180 23c-40 0-49 22-85 22H23v130h72c36 0 45 20 85 20s49-20 85-20h72V45h-72c-36 0-45-22-85-22Z" fill="#38291e" stroke="#e6bc75" strokeWidth="2" />
            <path d="M180 31c-40 0-49 22-85 22H31v114h64c36 0 45 20 85 20s49-20 85-20h64V53h-64c-36 0-45-22-85-22Z" stroke="#947958" />
            <path d="M40 76h70m140 0h70M40 151h55m170 0h55" stroke="#a58450" />
            <g stroke="#e6bc75" strokeWidth="1.5" strokeLinejoin="round">
              <path d="m180 43 22 13v25l-22 13-22-13V56Z" fill="#211812" />
              <path d="m180 43-12 32h24l-12-32Zm-22 13 10 19-10 6m44-25-10 19 10 6m-34-6 12 19 12-19" />
            </g>
            <text x="180" y="135" textAnchor="middle" fill="#f5ead5" fontFamily="Georgia, serif" fontWeight="bold" fontSize="39" letterSpacing="-1">DM’s Friend</text>
            <path d="M118 157h45m34 0h45m-62-6 6 6-6 6-6-6Z" stroke="#e6bc75" />
            <g fill="#e6bc75"><circle cx="42" cy="64" r="2" /><circle cx="318" cy="64" r="2" /><circle cx="42" cy="157" r="2" /><circle cx="318" cy="157" r="2" /></g>
          </svg>
        </div>
        <span className="brand-caption">THE DUNGEON MASTER’S COMPANION</span>
        <h1>{APP_NAME}</h1>
        <p>Your story. Your table.<br />A little help behind the screen.</p>
      </header>

      <ProfileIntroNudge />

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
