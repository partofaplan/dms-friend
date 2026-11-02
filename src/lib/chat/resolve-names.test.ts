import {
  characterSchema,
  combatantSchema,
  type Character,
  type CharacterInput,
  type Combatant,
  type CombatantInput,
} from "@/lib/db/schema";
import { normalizeMonster } from "@/lib/monsters/types";
import { goblinRaw, guardianRaw } from "@/test-utils/open5e-fixtures";
import { characterInput } from "@/test-utils/repository";

import { nameHandle } from "./describe";
import { MAX_ALTERNATIVES, MAX_RESOLVED_REFERENCES, resolveReferences } from "./resolve-names";

const stamps = {
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function character(overrides: Partial<CharacterInput> = {}): Character {
  return characterSchema.parse({ ...characterInput(overrides), id: crypto.randomUUID(), ...stamps });
}

const goblinMonster = normalizeMonster(goblinRaw)!;
const guardianMonster = normalizeMonster(guardianRaw)!;

function combatant(overrides: Partial<CombatantInput> = {}): Combatant {
  return combatantSchema.parse({
    monster: goblinMonster,
    hitPoints: { max: 7, current: 7 },
    ...overrides,
    id: crypto.randomUUID(),
    ...stamps,
  });
}

const thorin = character({
  name: "Thorin Oakenshield",
  race: "Dwarf",
  level: 5,
  armorClass: 18,
  hitPoints: { max: 44, current: 9 },
  conditions: ["prone"],
});
const ilsa = character({ name: "Ilsa", className: "Wizard", level: 5, armorClass: 12 });
const al = character({ name: "Al" });

const names = (refs: ReturnType<typeof resolveReferences>) => refs.map((r) => r.name);

describe("resolveReferences", () => {
  it("matches a character by full name, with a compact stat summary", () => {
    const [ref, ...rest] = resolveReferences("Is Thorin Oakenshield still standing?", {
      party: [thorin, ilsa],
    });
    expect(rest).toEqual([]);
    expect(ref).toEqual({
      kind: "character",
      id: thorin.id,
      name: "Thorin Oakenshield",
      summary: "Thorin (Thorin Oakenshield) — Dwarf Fighter 5; AC 18; HP 9/44; conditions: prone",
      matched: "Thorin Oakenshield",
      ambiguous: false,
      alternatives: [],
    });
  });

  it("matches a character by first name", () => {
    const refs = resolveReferences("how badly is Thorin hurt?", { party: [ilsa, thorin] });
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ name: "Thorin Oakenshield", matched: "Thorin", ambiguous: false });
  });

  it("is case- and accent-insensitive and ignores possessives and punctuation", () => {
    const eowyn = character({ name: "Éowyn of Rohan" });
    expect(names(resolveReferences("THORIN's axe vs eowyn, ILSA!", { party: [thorin, eowyn, ilsa] }))).toEqual([
      "Thorin Oakenshield",
      "Éowyn of Rohan",
      "Ilsa",
    ]);
  });

  it("matches whole words only", () => {
    const party = [al, thorin, ilsa];
    expect(resolveReferences("I always cast Thorinsbane at the Ilsanian guard", { party })).toEqual([]);
    expect(names(resolveReferences("Can Al dodge?", { party }))).toEqual(["Al"]);
  });

  it("returns every member a shared first name could mean, marked ambiguous", () => {
    const stonefist = character({ name: "Thorin Stonefist" });
    const refs = resolveReferences("Thorin attacks", { party: [thorin, stonefist, ilsa] });
    expect(refs).toEqual([
      expect.objectContaining({ name: "Thorin Oakenshield", ambiguous: true, alternatives: ["Thorin Stonefist"] }),
      expect.objectContaining({ name: "Thorin Stonefist", ambiguous: true, alternatives: ["Thorin Oakenshield"] }),
    ]);
  });

  it("drops the ambiguity when the message also names one of them in full", () => {
    const stonefist = character({ name: "Thorin Stonefist" });
    const refs = resolveReferences("Thorin hits — I mean Thorin Stonefist", { party: [thorin, stonefist] });
    expect(refs.find((r) => r.name === "Thorin Stonefist")).toMatchObject({ ambiguous: false, alternatives: [] });
    expect(refs.find((r) => r.name === "Thorin Oakenshield")).toMatchObject({ ambiguous: true });
  });

  it("matches a combatant by its label, preferring the longest name", () => {
    const first = combatant();
    const second = combatant({ label: "Goblin 2", hitPoints: { max: 7, current: 3 } });
    const refs = resolveReferences("Does goblin 2 flee?", { party: [], combatants: [first, second] });
    expect(refs).toEqual([
      expect.objectContaining({
        kind: "combatant",
        id: second.id,
        name: "Goblin 2",
        summary: "Goblin 2 (Goblin, CR 1/4) — AC 15; HP 3/7",
        ambiguous: false,
      }),
    ]);
  });

  it("matches a combatant by its monster name, ambiguous across duplicates", () => {
    const stable = [combatant(), combatant({ label: "Goblin 2" }), combatant({ monster: guardianMonster })];
    const refs = resolveReferences("Can the goblin hide?", { party: [], combatants: stable });
    expect(names(refs)).toEqual(["Goblin", "Goblin 2"]);
    expect(refs.every((r) => r.ambiguous)).toBe(true);

    const boss = combatant({ label: "Boss", monster: guardianMonster });
    expect(names(resolveReferences("the vault guardian and the boss", { party: [], combatants: [boss] }))).toEqual([
      "Boss",
    ]);
  });

  it("returns both a character and a combatant sharing a name", () => {
    const grik = character({ name: "Grik" });
    const grikMonster = combatant({ label: "Grik" });
    const refs = resolveReferences("Grik moves", { party: [grik], combatants: [grikMonster] });
    expect(refs.map((r) => [r.kind, r.ambiguous])).toEqual([
      ["character", true],
      ["combatant", true],
    ]);
  });

  it("pins at most MAX_RESOLVED_REFERENCES, in order of mention, with capped alternatives", () => {
    const party = Array.from({ length: 20 }, (_, i) => character({ name: `Hero${i}` }));
    const message = party.map((c) => c.name).reverse().join(" and ");
    const refs = resolveReferences(message, { party });
    expect(names(refs)).toEqual(["Hero19", "Hero18", "Hero17", "Hero16", "Hero15", "Hero14"].slice(0, MAX_RESOLVED_REFERENCES));

    const goblins = Array.from({ length: 30 }, (_, i) => combatant({ label: `Goblin ${i + 1}` }));
    const ambiguous = resolveReferences("the goblin", { party: [], combatants: goblins });
    expect(ambiguous).toHaveLength(MAX_RESOLVED_REFERENCES);
    expect(ambiguous[0].alternatives).toHaveLength(MAX_ALTERNATIVES);
  });

  it("does not match titles or common words as first names", () => {
    const party = [character({ name: "The Bard" }), character({ name: "Sir Gareth Brightblade" })];
    expect(resolveReferences("the orc grabs sir nobody", { party })).toEqual([]);
    expect(names(resolveReferences("Gareth parries", { party }))).toEqual(["Sir Gareth Brightblade"]);
    expect(nameHandle("The Bard")).toBe("Bard");
    expect(nameHandle("Ilsa")).toBeNull();
  });

  it("returns nothing for an empty roster or a message with no names", () => {
    expect(resolveReferences("Thorin?", { party: [] })).toEqual([]);
    expect(resolveReferences("How does grappling work?", { party: [thorin, ilsa], combatants: [combatant()] })).toEqual([]);
  });
});
