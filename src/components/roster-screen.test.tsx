import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

import type { DexieRepository } from "@/lib/db";
import { characterInput, createTestRepository } from "@/test-utils/repository";

import { RosterScreen } from "./roster-screen";

let repo: DexieRepository;

beforeEach(() => {
  repo = createTestRepository();
});

afterEach(() => {
  repo.db.close();
});

async function seed() {
  const brakka = await repo.characters.create(
    characterInput({ race: "Half-Orc", hitPoints: { max: 28, current: 20 } }),
  );
  const ilsa = await repo.characters.create(
    characterInput({
      name: "Ilsa",
      className: "Wizard",
      level: 5,
      armorClass: 12,
      hitPoints: { max: 22, current: 22 },
    }),
  );
  return { brakka, ilsa };
}

function row(name: string) {
  return screen.getByRole("article", { name });
}

describe("RosterScreen", () => {
  it("renders the empty state when there are no characters", async () => {
    render(<RosterScreen repo={repo} />);

    expect(await screen.findByText("No characters yet.")).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("lists characters with class, level, AC, and HP", async () => {
    await seed();
    render(<RosterScreen repo={repo} />);

    const brakka = await screen.findByRole("article", { name: "Brakka" });
    expect(brakka).toHaveTextContent("Half-Orc · Fighter 3");
    expect(brakka).toHaveTextContent("AC16");
    expect(brakka).toHaveTextContent("HP20 / 28");
    expect(row("Ilsa")).toHaveTextContent("Wizard 5");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("adds a character through the form and shows it in the list", async () => {
    render(<RosterScreen repo={repo} />);
    await screen.findByText("No characters yet.");

    fireEvent.click(screen.getByRole("button", { name: "Add character" }));
    for (const [label, value] of [
      ["Name", "Pip"],
      ["Class", "Rogue"],
      ["Armor Class", "14"],
      ["Max HP", "9"],
      ["Current HP", "9"],
    ]) {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    }
    fireEvent.click(
      within(screen.getByRole("form")).getByRole("button", {
        name: "Add character",
      }),
    );

    expect(await screen.findByRole("article", { name: "Pip" })).toHaveTextContent(
      "Rogue 1",
    );
    expect(await repo.characters.getAll()).toHaveLength(1);
  });

  it("edit populates the form and saves changes back to the list", async () => {
    await seed();
    render(<RosterScreen repo={repo} />);
    await screen.findByRole("article", { name: "Ilsa" });

    fireEvent.click(screen.getByRole("button", { name: "Edit Ilsa" }));

    expect(
      screen.getByRole("heading", { name: "Edit Ilsa" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("Ilsa");
    expect(screen.getByLabelText("Class")).toHaveValue("Wizard");
    expect(screen.getByLabelText("Level")).toHaveValue(5);
    expect(screen.getByLabelText("Current HP")).toHaveValue(22);

    fireEvent.change(screen.getByLabelText("Level"), {
      target: { value: "6" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(row("Ilsa")).toHaveTextContent("Wizard 6"));
  });

  it("cancelling the form returns to the list without saving", async () => {
    await seed();
    render(<RosterScreen repo={repo} />);
    await screen.findByRole("article", { name: "Ilsa" });

    fireEvent.click(screen.getByRole("button", { name: "Edit Ilsa" }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Changed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(row("Ilsa")).toBeInTheDocument();
    expect((await repo.characters.getAll()).map((c) => c.name)).toEqual([
      "Brakka",
      "Ilsa",
    ]);
  });

  it("deletes a character only after confirmation", async () => {
    const { brakka } = await seed();
    render(<RosterScreen repo={repo} />);
    await screen.findByRole("article", { name: "Brakka" });

    fireEvent.click(screen.getByRole("button", { name: "Delete Brakka" }));
    const confirm = within(row("Brakka")).getByRole("button", {
      name: "Confirm delete",
    });
    expect(confirm).toHaveFocus();

    // Cancelling keeps the character.
    fireEvent.click(within(row("Brakka")).getByRole("button", { name: "Cancel" }));
    expect(await repo.characters.getById(brakka.id)).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Delete Brakka" }));
    fireEvent.click(
      within(row("Brakka")).getByRole("button", { name: "Confirm delete" }),
    );

    await waitFor(() =>
      expect(
        screen.queryByRole("article", { name: "Brakka" }),
      ).not.toBeInTheDocument(),
    );
    expect(row("Ilsa")).toBeInTheDocument();
    expect(await repo.characters.getById(brakka.id)).toBeUndefined();
  });

  it("adjusts current HP from the row and persists it", async () => {
    const { brakka } = await seed();
    render(<RosterScreen repo={repo} />);
    await screen.findByRole("article", { name: "Brakka" });

    fireEvent.click(
      screen.getByRole("button", { name: "Increase HP for Brakka" }),
    );
    await waitFor(() => expect(row("Brakka")).toHaveTextContent("HP21 / 28"));

    fireEvent.click(
      screen.getByRole("button", { name: "Decrease HP for Brakka" }),
    );
    await waitFor(() => expect(row("Brakka")).toHaveTextContent("HP20 / 28"));
    expect((await repo.characters.getById(brakka.id))?.hitPoints.current).toBe(
      20,
    );
    // Ilsa is at full HP, so increasing is disabled.
    expect(
      screen.getByRole("button", { name: "Increase HP for Ilsa" }),
    ).toBeDisabled();
  });
});
