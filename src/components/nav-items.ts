export type NavItem = {
  href: string;
  label: string;
  description: string;
};

export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/roster", label: "Roster", description: "Track your party" },
  { href: "/monsters", label: "Monsters", description: "Look up stat blocks" },
  { href: "/chat", label: "Chat", description: "Ask the AI assistant" },
  { href: "/scan", label: "Scan", description: "Import a character sheet" },
];
