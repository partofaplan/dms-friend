import { render, screen, within } from "@testing-library/react";

import Home from "./page";

describe("Home shell", () => {
  it("renders the app title", () => {
    render(<Home />);

    expect(
      screen.getByRole("heading", { level: 1, name: "DM Friend" }),
    ).toBeInTheDocument();
  });

  it("renders a landing card for each feature", () => {
    render(<Home />);

    // The bottom nav (in the layout) is the only navigation landmark.
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    const nav = screen.getByRole("region", { name: "At your fingertips" });
    for (const [label, href] of [
      ["Roster", "/roster"],
      ["Monsters", "/monsters"],
      ["Stable", "/stable"],
      ["Chat", "/chat"],
      ["Scan", "/scan"],
    ]) {
      expect(
        within(nav).getByRole("link", { name: new RegExp(`^${label}`) }),
      ).toHaveAttribute("href", href);
    }
  });
});
