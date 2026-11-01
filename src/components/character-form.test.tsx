import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { DexieRepository } from "@/lib/db";
import { characterInput, createTestRepository } from "@/test-utils/repository";

import { CharacterForm } from "./character-form";

let repo: DexieRepository;

beforeEach(() => {
  repo = createTestRepository();
});

afterEach(() => {
  repo.db.close();
});

// Ability names label both a score input and a saving-throw checkbox, so query inputs by role.
function field(label: string) {
  return (
    screen.queryByRole("spinbutton", { name: label }) ??
    screen.getByRole("textbox", { name: label })
  );
}

function type(label: string, value: string) {
  fireEvent.change(field(label), { target: { value } });
}

function submit() {
  fireEvent.click(screen.getByRole("button", { name: "Add character" }));
}

function fillValid() {
  type("Name", "Brakka");
  type("Class", "Fighter");
  type("Level", "3");
  type("Armor Class", "16");
  type("Max HP", "28");
  type("Current HP", "20");
}

describe("CharacterForm", () => {
  it("surfaces required-field errors and does not create a record", async () => {
    const create = vi.spyOn(repo.characters, "create");
    const onSaved = vi.fn();
    render(<CharacterForm repo={repo} onSaved={onSaved} />);

    submit();

    expect(await screen.findByRole("alert")).toHaveTextContent(/Please fix/);
    const name = screen.getByLabelText("Name");
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(name).toHaveAccessibleDescription("Name is required");
    expect(screen.getByLabelText("Max HP")).toHaveAccessibleDescription(
      "Required",
    );
    expect(name).toHaveFocus();
    expect(create).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(await repo.characters.getAll()).toEqual([]);
  });

  it("reports out-of-range values from the schema", async () => {
    const create = vi.spyOn(repo.characters, "create");
    render(<CharacterForm repo={repo} />);

    fillValid();
    type("Level", "21");
    type("Strength", "31");
    type("Dexterity", "0");
    type("Current HP", "40");
    submit();

    expect(screen.getByLabelText("Level")).toHaveAccessibleDescription(
      "Must be at most 20",
    );
    expect(field("Strength")).toHaveAccessibleDescription(
      "Must be at most 30",
    );
    expect(field("Dexterity")).toHaveAccessibleDescription(
      "Must be at least 1",
    );
    expect(screen.getByLabelText("Current HP")).toHaveAccessibleDescription(
      "Current hit points cannot exceed max",
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("clears an error once the field is fixed", () => {
    render(<CharacterForm repo={repo} />);
    fillValid();
    type("Level", "0");
    submit();
    expect(screen.getByLabelText("Level")).toHaveAttribute("aria-invalid");

    type("Level", "5");

    expect(screen.getByLabelText("Level")).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("creates a character from valid input and calls onSaved", async () => {
    const onSaved = vi.fn();
    render(<CharacterForm repo={repo} onSaved={onSaved} />);

    fillValid();
    type("Race", "Half-Orc");
    fireEvent.click(screen.getByRole("checkbox", { name: "Athletics" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Poisoned" }));
    submit();

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    const saved = onSaved.mock.calls[0][0];
    expect(saved).toMatchObject({
      name: "Brakka",
      race: "Half-Orc",
      className: "Fighter",
      level: 3,
      armorClass: 16,
      hitPoints: { max: 28, current: 20, temporary: 0 },
      skillProficiencies: ["athletics"],
      conditions: ["poisoned"],
    });
    expect(await repo.characters.getAll()).toEqual([saved]);
  });

  it("pre-fills from initial values and updates the existing record", async () => {
    const existing = await repo.characters.create(
      characterInput({ race: "Dwarf", notes: "Grumpy", rawScan: "scan-1" }),
    );
    const onSaved = vi.fn();
    render(
      <CharacterForm
        repo={repo}
        characterId={existing.id}
        initialValues={existing}
        onSaved={onSaved}
      />,
    );

    expect(screen.getByLabelText("Name")).toHaveValue("Brakka");
    expect(field("Strength")).toHaveValue(16);
    type("Name", "Brakka the Bold");
    type("Race", "");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    const stored = await repo.characters.getById(existing.id);
    expect(stored?.name).toBe("Brakka the Bold");
    expect(stored?.race).toBeUndefined();
    expect(stored?.notes).toBe("Grumpy");
    expect(stored?.rawScan).toBe("scan-1");
    expect(await repo.characters.getAll()).toHaveLength(1);
  });
});
