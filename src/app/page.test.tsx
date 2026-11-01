import { render, screen, within } from "@testing-library/react";

import Home from "./page";

describe("Home shell", () => {
  it("renders the app title", () => {
    render(<Home />);

    expect(
      screen.getByRole("heading", { level: 1, name: "DM Friend" }),
    ).toBeInTheDocument();
  });

  it("renders navigation entries for each feature", () => {
    render(<Home />);

    const nav = screen.getByRole("navigation", { name: "Main" });
    for (const [label, href] of [
      ["Roster", "/roster"],
      ["Monsters", "/monsters"],
      ["Chat", "/chat"],
      ["Scan", "/scan"],
    ]) {
      expect(
        within(nav).getByRole("link", { name: new RegExp(`^${label}`) }),
      ).toHaveAttribute("href", href);
    }
  });
});
