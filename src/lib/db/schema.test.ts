import {
  characterInputSchema,
  characterSchema,
  partyInputSchema,
  partySchema,
  type CharacterInput,
} from "./schema";

const NOW = "2026-01-01T00:00:00.000Z";
const ID = "4f9c2b1e-8a3d-4c6e-9b2a-1d5e7f8a9b0c";

function validInput(): CharacterInput {
  return {
    name: "Thia Brightwater",
    race: "Half-Elf",
    className: "Cleric",
    level: 5,
    armorClass: 18,
    hitPoints: { max: 38, current: 30, temporary: 5 },
    abilityScores: {
      strength: 10,
      dexterity: 12,
      constitution: 14,
      intelligence: 10,
      wisdom: 18,
      charisma: 13,
    },
    savingThrowProficiencies: ["wisdom", "charisma"],
    skillProficiencies: ["insight", "medicine", "perception"],
    passivePerception: 17,
    conditions: ["poisoned"],
    notes: "Carries a holy symbol of Lathander.",
    rawScan: null,
  };
}

describe("character schema", () => {
  it("accepts a complete valid character", () => {
    const stored = characterSchema.parse({
      ...validInput(),
      id: ID,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(stored.name).toBe("Thia Brightwater");
    expect(stored.id).toBe(ID);
  });

  it("applies defaults for optional collections and temp HP", () => {
    const parsed = characterInputSchema.parse({
      name: "Grok",
      className: "Barbarian",
      level: 1,
      armorClass: 14,
      hitPoints: { max: 14, current: 14 },
      abilityScores: validInput().abilityScores,
    });
    expect(parsed.hitPoints.temporary).toBe(0);
    expect(parsed.conditions).toEqual([]);
    expect(parsed.skillProficiencies).toEqual([]);
    expect(parsed.savingThrowProficiencies).toEqual([]);
  });

  it("allows current HP of 0", () => {
    const input = { ...validInput(), hitPoints: { max: 10, current: 0 } };
    expect(characterInputSchema.safeParse(input).success).toBe(true);
  });

  it.each<[string, (c: CharacterInput) => unknown]>([
    ["empty name", (c) => ({ ...c, name: "" })],
    ["whitespace name", (c) => ({ ...c, name: "   " })],
    ["level 0", (c) => ({ ...c, level: 0 })],
    ["level 21", (c) => ({ ...c, level: 21 })],
    ["fractional level", (c) => ({ ...c, level: 2.5 })],
    ["negative AC", (c) => ({ ...c, armorClass: -1 })],
    ["max HP 0", (c) => ({ ...c, hitPoints: { max: 0, current: 0 } })],
    ["negative current HP", (c) => ({ ...c, hitPoints: { max: 10, current: -1 } })],
    ["current HP above max", (c) => ({ ...c, hitPoints: { max: 10, current: 11 } })],
    [
      "negative temp HP",
      (c) => ({ ...c, hitPoints: { max: 10, current: 10, temporary: -1 } }),
    ],
    [
      "ability score 0",
      (c) => ({ ...c, abilityScores: { ...c.abilityScores, strength: 0 } }),
    ],
    [
      "ability score 31",
      (c) => ({ ...c, abilityScores: { ...c.abilityScores, charisma: 31 } }),
    ],
    [
      "missing ability score",
      (c) => {
        const { wisdom: _omit, ...rest } = c.abilityScores;
        void _omit;
        return { ...c, abilityScores: rest };
      },
    ],
    ["unknown condition", (c) => ({ ...c, conditions: ["sleepy"] })],
    ["duplicate condition", (c) => ({ ...c, conditions: ["prone", "prone"] })],
    ["unknown skill", (c) => ({ ...c, skillProficiencies: ["juggling"] })],
    ["unknown saving throw", (c) => ({ ...c, savingThrowProficiencies: ["luck"] })],
  ])("rejects %s", (_label, mutate) => {
    expect(characterInputSchema.safeParse(mutate(validInput())).success).toBe(
      false,
    );
  });

  it("rejects a stored character with a non-uuid id or bad timestamp", () => {
    const base = { ...validInput(), id: ID, createdAt: NOW, updatedAt: NOW };
    expect(characterSchema.safeParse({ ...base, id: "abc" }).success).toBe(false);
    expect(
      characterSchema.safeParse({ ...base, updatedAt: "yesterday" }).success,
    ).toBe(false);
  });
});

describe("party schema", () => {
  it("accepts a valid party and defaults characterIds", () => {
    expect(partyInputSchema.parse({ name: "The Wanderers" })).toEqual({
      name: "The Wanderers",
      characterIds: [],
    });
    const stored = partySchema.parse({
      name: "The Wanderers",
      characterIds: [ID],
      id: ID,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(stored.characterIds).toEqual([ID]);
  });

  it.each([
    ["empty name", { name: "" }],
    ["non-uuid character id", { name: "P", characterIds: ["nope"] }],
    ["duplicate character ids", { name: "P", characterIds: [ID, ID] }],
  ])("rejects %s", (_label, input) => {
    expect(partyInputSchema.safeParse(input).success).toBe(false);
  });
});
