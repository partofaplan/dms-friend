import { normalizeMonster } from "@/lib/monsters/types";
import { goblinRaw } from "@/test-utils/open5e-fixtures";

import {
  characterInputSchema,
  characterSchema,
  combatantInputSchema,
  combatantName,
  combatantSchema,
  chatMessageInputSchema,
  chatMessageRecordSchema,
  partyInputSchema,
  partyProfileInputSchema,
  partyProfileSchema,
  partySchema,
  userProfileInputSchema,
  userProfileSchema,
  type CharacterInput,
  type CombatantInput,
} from "./schema";

const NOW = "2026-01-01T00:00:00.000Z";
const ID = "4f9c2b1e-8a3d-4c6e-9b2a-1d5e7f8a9b0c";
const PARTY_ID = "0b6f3c2d-1e4a-4b5c-8d9e-0f1a2b3c4d5e";

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
      partyProfileId: PARTY_ID,
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
    const base = {
      ...validInput(),
      id: ID,
      partyProfileId: PARTY_ID,
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(characterSchema.safeParse(base).success).toBe(true);
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

describe("combatant schema", () => {
  const goblin = normalizeMonster(goblinRaw)!;

  function validCombatant(): CombatantInput {
    return {
      monster: goblin,
      label: "Goblin 2",
      hitPoints: { max: 7, current: 4, temporary: 3 },
      conditions: ["prone", "poisoned"],
      notes: "Hiding behind the cart",
    };
  }

  it("accepts a valid combatant and applies defaults", () => {
    expect(combatantInputSchema.parse(validCombatant())).toEqual(validCombatant());
    const minimal = combatantInputSchema.parse({
      monster: goblin,
      hitPoints: { max: 7, current: 7 },
    });
    expect(minimal.conditions).toEqual([]);
    expect(minimal.hitPoints.temporary).toBe(0);
    expect(minimal.label).toBeUndefined();

    const stored = combatantSchema.parse({
      ...validCombatant(),
      id: ID,
      partyProfileId: PARTY_ID,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(stored.id).toBe(ID);
    expect(combatantName(stored)).toBe("Goblin 2");
    expect(combatantName({ ...stored, label: undefined })).toBe("Goblin");
  });

  it.each<[string, (input: CombatantInput) => unknown]>([
    ["negative current HP", (c) => ({ ...c, hitPoints: { max: 7, current: -1 } })],
    ["current HP above max", (c) => ({ ...c, hitPoints: { max: 7, current: 8 } })],
    ["zero max HP", (c) => ({ ...c, hitPoints: { max: 0, current: 0 } })],
    ["negative temporary HP", (c) => ({ ...c, hitPoints: { max: 7, current: 7, temporary: -2 } })],
    ["an unknown condition", (c) => ({ ...c, conditions: ["sleepy"] })],
    ["duplicate conditions", (c) => ({ ...c, conditions: ["prone", "prone"] })],
    ["a blank label", (c) => ({ ...c, label: "   " })],
    ["a monster with an empty name", (c) => ({ ...c, monster: { ...goblin, name: "  " } })],
    ["an incomplete stat block", (c) => ({ ...c, monster: { ...goblin, actions: undefined } })],
    ["a missing monster", (c) => ({ ...c, monster: undefined })],
  ])("rejects %s", (_label, mutate) => {
    expect(combatantInputSchema.safeParse(mutate(validCombatant())).success).toBe(false);
  });

  it("requires a uuid party profile on a stored combatant", () => {
    const base = { ...validCombatant(), id: ID, createdAt: NOW, updatedAt: NOW };
    expect(combatantSchema.safeParse(base).success).toBe(false);
    expect(
      combatantSchema.safeParse({ ...base, partyProfileId: "nope" }).success,
    ).toBe(false);
  });
});

describe("character party scope", () => {
  it("keeps partyProfileId out of the input schema and requires it when stored", () => {
    expect(
      characterInputSchema.parse({ ...validInput(), partyProfileId: PARTY_ID }),
    ).not.toHaveProperty("partyProfileId");
    const base = { ...validInput(), id: ID, createdAt: NOW, updatedAt: NOW };
    expect(characterSchema.safeParse(base).success).toBe(false);
  });
});

describe("profile schemas", () => {
  it("trims user and party profile names", () => {
    expect(userProfileInputSchema.parse({ name: "  Zach  " })).toEqual({
      name: "Zach",
    });
    expect(
      partyProfileInputSchema.parse({ userId: ID, name: " Curse of Strahd " }),
    ).toEqual({ userId: ID, name: "Curse of Strahd" });
  });

  it.each([
    ["blank user name", () => userProfileInputSchema.safeParse({ name: "   " })],
    [
      "blank party name",
      () => partyProfileInputSchema.safeParse({ userId: ID, name: "" }),
    ],
    [
      "non-uuid owner",
      () => partyProfileInputSchema.safeParse({ userId: "me", name: "P" }),
    ],
    [
      "stored user without id",
      () =>
        userProfileSchema.safeParse({ name: "Z", createdAt: NOW, updatedAt: NOW }),
    ],
    [
      "stored party with a bad timestamp",
      () =>
        partyProfileSchema.safeParse({
          id: ID,
          userId: ID,
          name: "P",
          createdAt: "today",
          updatedAt: NOW,
        }),
    ],
  ])("rejects a %s", (_label, parse) => {
    expect(parse().success).toBe(false);
  });
});

describe("chat message schema", () => {
  it("accepts a stored turn and keeps content verbatim", () => {
    const stored = chatMessageRecordSchema.parse({
      role: "assistant",
      content: "  **Roll** a d20  ",
      id: ID,
      partyProfileId: PARTY_ID,
      sequence: 0,
      createdAt: NOW,
    });
    expect(stored.content).toBe("  **Roll** a d20  ");
  });

  it.each([
    ["an unknown role", { role: "system", content: "x" }],
    ["empty content", { role: "user", content: "" }],
  ])("rejects %s", (_label, input) => {
    expect(chatMessageInputSchema.safeParse(input).success).toBe(false);
  });

  it("rejects a negative or fractional sequence", () => {
    const base = {
      role: "user",
      content: "hi",
      id: ID,
      partyProfileId: PARTY_ID,
      createdAt: NOW,
    };
    expect(chatMessageRecordSchema.safeParse({ ...base, sequence: -1 }).success).toBe(false);
    expect(chatMessageRecordSchema.safeParse({ ...base, sequence: 1.5 }).success).toBe(false);
  });
});
