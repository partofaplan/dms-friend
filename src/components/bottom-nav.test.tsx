import { act, render, screen, within } from "@testing-library/react";

import { BottomNav } from "./bottom-nav";
import { isActiveRoute } from "./nav-items";
import { OfflineBanner } from "./offline-status";

let pathname = "/";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));

function setOnline(online: boolean) {
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(online);
  act(() => {
    window.dispatchEvent(new Event(online ? "online" : "offline"));
  });
}

afterEach(() => {
  pathname = "/";
  vi.restoreAllMocks();
});

function primaryNav() {
  return screen.getByRole("navigation", { name: "Primary" });
}

const TABS = [
  ["Home", "/"],
  ["Roster", "/roster"],
  ["Monsters", "/monsters"],
  ["Scan", "/scan"],
  ["Chat", "/chat"],
] as const;

describe("BottomNav", () => {
  it("is a labeled nav landmark with a list of links to every screen", () => {
    render(<BottomNav />);

    const nav = primaryNav();
    const links = within(within(nav).getByRole("list")).getAllByRole("link");
    expect(links).toHaveLength(TABS.length);
    for (const [label, href] of TABS) {
      expect(within(nav).getByRole("link", { name: label })).toHaveAttribute("href", href);
    }
  });

  it.each([
    ["/", "Home"],
    ["/roster", "Roster"],
    ["/monsters", "Monsters"],
    ["/scan", "Scan"],
    ["/chat", "Chat"],
    ["/roster/abc", "Roster"],
  ])("marks only the active tab with aria-current on %s", (path, active) => {
    pathname = path;
    render(<BottomNav />);

    for (const [label] of TABS) {
      const link = within(primaryNav()).getByRole("link", { name: new RegExp(`^${label}`) });
      if (label === active) expect(link).toHaveAttribute("aria-current", "page");
      else expect(link).not.toHaveAttribute("aria-current");
    }
  });

  it("updates the active tab when the route changes", () => {
    const { rerender } = render(<BottomNav />);
    expect(screen.getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");

    pathname = "/chat";
    rerender(<BottomNav />);
    expect(screen.getByRole("link", { name: "Home" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: "Chat" })).toHaveAttribute("aria-current", "page");
  });

  it("tags network-only tabs with a visible Offline label while offline", () => {
    render(<BottomNav />);
    setOnline(false);

    const nav = primaryNav();
    for (const label of ["Monsters", "Scan", "Chat"]) {
      expect(within(nav).getByRole("link", { name: `${label} Offline` })).toBeInTheDocument();
    }
    expect(within(nav).getByRole("link", { name: "Home" })).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: "Roster" })).toBeInTheDocument();

    setOnline(true);
    expect(within(nav).getByRole("link", { name: "Chat" })).toBeInTheDocument();
  });
});

describe("OfflineBanner", () => {
  it("announces going offline and clears when back online", () => {
    render(<OfflineBanner />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toBeEmptyDOMElement();

    setOnline(false);
    expect(status).toHaveTextContent(/You're offline\. Your roster still works/);

    setOnline(true);
    expect(status).toBeEmptyDOMElement();
  });
});

describe("isActiveRoute", () => {
  it("matches Home exactly and other tabs by path segment", () => {
    expect(isActiveRoute("/", "/")).toBe(true);
    expect(isActiveRoute("/", "/roster")).toBe(false);
    expect(isActiveRoute("/roster", "/roster/1")).toBe(true);
    expect(isActiveRoute("/roster", "/rosters")).toBe(false);
    expect(isActiveRoute("/roster", null)).toBe(false);
  });
});
