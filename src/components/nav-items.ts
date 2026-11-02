export type NavIconName = "home" | "roster" | "monsters" | "chat" | "scan";

export type NavItem = {
  href: string;
  label: string;
  description: string;
  icon: NavIconName;
  /** The screen's main action needs the network (AI or monster API). */
  requiresNetwork: boolean;
};

export const HOME_NAV_ITEM: NavItem = {
  href: "/",
  label: "Home",
  description: "Start here",
  icon: "home",
  requiresNetwork: false,
};

/** The feature screens, in the order the home grid lists them. */
export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/roster", label: "Roster", description: "Track your party", icon: "roster", requiresNetwork: false },
  { href: "/monsters", label: "Monsters", description: "Look up stat blocks", icon: "monsters", requiresNetwork: true },
  { href: "/chat", label: "Chat", description: "Ask the AI assistant", icon: "chat", requiresNetwork: true },
  { href: "/scan", label: "Scan", description: "Import a character sheet", icon: "scan", requiresNetwork: true },
];

/** Bottom navigation tabs: Home followed by every feature screen. */
export const PRIMARY_NAV_ITEMS: readonly NavItem[] = [HOME_NAV_ITEM, ...NAV_ITEMS];

/** Every top-level route; public/sw.js precaches the same list (keep in sync). */
export const APP_ROUTES: readonly string[] = PRIMARY_NAV_ITEMS.map((item) => item.href);

/** Whether `href` is the active tab for `pathname` (Home only on an exact match). */
export function isActiveRoute(href: string, pathname: string | null): boolean {
  if (!pathname) return false;
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
