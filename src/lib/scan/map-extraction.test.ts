import { characterInputSchema } from "@/lib/db/schema";

import { assessDraft, fieldLabel, mapExtraction } from "./map-extraction";

const IMAGE = "data:image/png;base64,iVBORw0KGgo=";

function fullExtraction() {
  return {
    name: "Ilsa Brightwater",
    race: "High Elf",
    className: "Wizard",
    level: 5,
    armorClass: 12,
    hitPoints: { max: 22, current: 18, temporary: 0 },
    abilityScores: {
      strength: 8,
      dexterity: 14,
      constitution: 12,
      intelligence: 18,
      wisdom: 13,
      charisma: 10,
    },
    savingThrowProficiencies: ["intelligence", "wisdom"],
    skillProficiencies: ["arcana", "history"],
    passivePerception: 11,
    conditions: [],
    notes: "Speaks Elvish and Draconic.",
  };
}

describe("mapExtraction", () => {
  it("maps a fully populated extraction to a schema-valid character input", () => {
    const draft = mapExtraction(fullExtraction(), IMAGE);

    const parsed = characterInputSchema.safeParse(draft);
    expect(parsed.success).toBe(true);
    expect(draft).toEqual({ ...fullExtraction(), rawScan: IMAGE });
    expect(assessDraft(draft)).toEqual({ valid: true, needsAttention: [] });
  });

  it("coerces numeric strings to numbers without clamping", () => {
    const draft = mapExtraction({
      level: " 3 ",
      armorClass: "16",
      hitPoints: { max: "28", current: "+20", temporary: "0" },
      abilityScores: { strength: "17", dexterity: "45" },
      passivePerception: "12",
    });

    expect(draft.level).toBe(3);
    expect(draft.armorClass).toBe(16);
    expect(draft.hitPoints).toEqual({ max: 28, current: 20, temporary: 0 });
    // Out of range values are kept for the form/schema to flag.
    expect(draft.abilityScores).toEqual({ strength: 17, dexterity: 45 });
    expect(draft.passivePerception).toBe(12);
  });

  it("leaves non-numeric values empty instead of guessing", () => {
    const draft = mapExtraction({
      level: "third",
      armorClass: "16 (+shield)",
      hitPoints: { max: "", current: null },
    });

    expect(draft.level).toBeUndefined();
    expect(draft.armorClass).toBeUndefined();
    expect(draft.hitPoints).toBeUndefined();
  });

  it("leaves numeric strings that overflow to Infinity empty", () => {
    const draft = mapExtraction({
      level: "9".repeat(400),
      armorClass: "1e999",
      hitPoints: { max: `-${"9".repeat(400)}` },
      passivePerception: Infinity,
    });

    expect(draft.level).toBeUndefined();
    expect(draft.armorClass).toBeUndefined();
    expect(draft.hitPoints).toBeUndefined();
    expect(draft.passivePerception).toBeUndefined();
  });

  it("drops unknown enum values without failing, and normalizes known ones", () => {
    const draft = mapExtraction({
      ...fullExtraction(),
      savingThrowProficiencies: ["Intelligence", "luck", "wisdom", "WISDOM"],
      skillProficiencies: ["Sleight of Hand", "animal_handling", "basket weaving", 7],
      conditions: ["poisoned", "cursed", "Prone"],
    });

    expect(draft.savingThrowProficiencies).toEqual(["intelligence", "wisdom"]);
    expect(draft.skillProficiencies).toEqual(["sleightOfHand", "animalHandling"]);
    expect(draft.conditions).toEqual(["poisoned", "prone"]);
    expect(characterInputSchema.safeParse(draft).success).toBe(true);
  });

  it("leaves missing or null fields empty", () => {
    const draft = mapExtraction(
      {
        name: "  Brakka ",
        race: null,
        className: "",
        level: null,
        hitPoints: { max: 28, current: null, temporary: null },
        abilityScores: { strength: 16, dexterity: null },
        notes: "   ",
      },
      IMAGE,
    );

    expect(draft).toEqual({
      name: "Brakka",
      hitPoints: { max: 28 },
      abilityScores: { strength: 16 },
      rawScan: IMAGE,
    });
  });

  it("tolerates non-object data", () => {
    expect(mapExtraction(null)).toEqual({});
    expect(mapExtraction(["nope"], IMAGE)).toEqual({ rawScan: IMAGE });
  });

  it("stores the source image as rawScan", () => {
    expect(mapExtraction(fullExtraction(), IMAGE).rawScan).toBe(IMAGE);
    expect(mapExtraction(fullExtraction())).not.toHaveProperty("rawScan");
  });
});

describe("assessDraft", () => {
  it("lists fields that are missing or invalid without throwing", () => {
    const draft = mapExtraction({
      ...fullExtraction(),
      className: null,
      level: 25,
      hitPoints: { max: 22, current: null, temporary: 0 },
      abilityScores: { ...fullExtraction().abilityScores, charisma: null },
    });

    const { valid, needsAttention } = assessDraft(draft);

    expect(valid).toBe(false);
    expect(needsAttention).toEqual(
      expect.arrayContaining([
        "className",
        "level",
        "hitPoints.current",
        "abilityScores.charisma",
      ]),
    );
    expect(needsAttention.map(fieldLabel)).toEqual(
      expect.arrayContaining(["Class", "Level", "Current HP", "Charisma"]),
    );
  });
});
