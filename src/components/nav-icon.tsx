import type { NavIconName } from "@/components/nav-items";

const PATHS: Record<NavIconName, string> = {
  home: "M3 4h18M6 4v4m12-4v4M4 8h16v13H4V8Zm5 13v-7h6v7m-5-10h4",
  roster: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m18 0v-2a4 4 0 0 0-3-3.87M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm8-7.87a4 4 0 0 1 0 7.75",
  monsters: "m5 3 4 5h6l4-5v11l-3 6h-8l-3-6V3Zm3 9 2 1m6-1-2 1m-4 4h4",
  chat: "M20 4H4a1 1 0 0 0-1 1v16l5-4h12a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1ZM7 9h10M7 13h6",
  scan: "M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M8 7h8v10H8V7Zm-3 5h14",
};

/** Decorative nav glyph; the surrounding link carries the accessible name. */
export function NavIcon({ name, className }: { name: NavIconName; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
