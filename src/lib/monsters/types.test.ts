import { goblinRaw, guardianRaw } from "@/test-utils/open5e-fixtures";

import {
  abilityModifier,
  formatAbilityScore,
  formatChallengeRating,
  formatSpeed,
  MAX_BONUS_ENTRIES,
  MAX_DESC_LENGTH,
  MAX_FIELD_LENGTH,
  MAX_SECTION_ENTRIES,
  monsterQuerySchema,
  normalizeMonster,
  normalizeMonsterSummary,
  parseChallengeRating,
} from "./types";

describe("abilityModifier", () => {
  it.each([
    [1, -5],
    [8, -1],
    [9, -1],
    [10, 0],
    [11, 0],
    [16, 3],
    [23, 6],
    [30, 10],
  ])("score %i → %i", (score, modifier) => {
    expect(abilityModifier(score)).toBe(modifier);
  });

  it("formats score with signed modifier", () => {
    expect(formatAbilityScore(16)).toBe("16 (+3)");
    expect(formatAbilityScore(10)).toBe("10 (+0)");
    expect(formatAbilityScore(8)).toBe("8 (-1)");
  });
});

describe("challenge rating", () => {
  it("parses fractional and whole CR strings", () => {
    expect(parseChallengeRating("1/8")).toBe(0.125);
    expect(parseChallengeRating("1/4")).toBe(0.25);
    expect(parseChallengeRating("1/2")).toBe(0.5);
    expect(parseChallengeRating("11")).toBe(11);
    expect(parseChallengeRating("??")).toBeNull();
  });

  it.each(["toString", "constructor", "__proto__", "hasOwnProperty", "valueOf", "1/3"])(
    "never matches inherited or unknown keys: %s",
    (value) => {
      expect(parseChallengeRating(value)).toBeNull();
    },
  );

  it("formats numeric CRs", () => {
    expect(formatChallengeRating(0.25)).toBe("1/4");
    expect(formatChallengeRating(0)).toBe("0");
    expect(formatChallengeRating(11)).toBe("11");
  });

  it("derives the number from the string when cr is missing", () => {
    const raw = { ...goblinRaw, cr: undefined };
    expect(normalizeMonsterSummary(raw)).toMatchObject({ cr: 0.25, challengeRating: "1/4" });
  });

  it("derives the string from the number when challenge_rating is missing", () => {
    const raw = { ...guardianRaw, challenge_rating: null, cr: 0.5 };
    expect(normalizeMonsterSummary(raw)).toMatchObject({ cr: 0.5, challengeRating: "1/2" });
  });

  it("is null when neither is present", () => {
    expect(normalizeMonsterSummary({ slug: "x", name: "X" })).toMatchObject({
      cr: null,
      challengeRating: null,
    });
  });
});

describe("normalizeMonster", () => {
  it("maps the goblin, dropping null and empty sections", () => {
    expect(normalizeMonster(goblinRaw)).toEqual({
      slug: "goblin",
      name: "Goblin",
      size: "Small",
      type: "humanoid",
      subtype: "goblinoid",
      alignment: "neutral evil",
      cr: 0.25,
      challengeRating: "1/4",
      armorClass: 15,
      armorDesc: "leather armor, shield",
      hitPoints: 7,
      hitDice: "2d6",
      speed: [{ mode: "walk", feet: 30 }],
      hover: false,
      abilities: {
        strength: 8,
        dexterity: 14,
        constitution: 10,
        intelligence: 10,
        wisdom: 8,
        charisma: 8,
      },
      savingThrows: [],
      skills: [{ name: "Stealth", bonus: 6 }],
      damageVulnerabilities: "",
      damageResistances: "",
      damageImmunities: "",
      conditionImmunities: "",
      senses: "darkvision 60 ft., passive Perception 9",
      languages: "Common, Goblin",
      specialAbilities: [goblinRaw.special_abilities[0]],
      actions: goblinRaw.actions,
      bonusActions: [],
      reactions: [],
      legendaryDesc: "",
      legendaryActions: [],
    });
  });

  it("maps saves, skills, speeds, and every optional section", () => {
    const monster = normalizeMonster(guardianRaw)!;
    expect(monster.savingThrows).toEqual([
      { name: "STR", bonus: 11 },
      { name: "CON", bonus: 10 },
      { name: "WIS", bonus: 5 },
    ]);
    expect(monster.skills).toEqual([
      { name: "Perception", bonus: 5 },
      { name: "Athletics", bonus: 11 },
    ]);
    expect(monster.speed).toEqual([
      { mode: "walk", feet: 40 },
      { mode: "fly", feet: 60 },
    ]);
    expect(monster.hover).toBe(true);
    expect(formatSpeed(monster.speed, monster.hover)).toBe("40 ft., fly 60 ft. (hover)");
    expect(monster.bonusActions).toHaveLength(1);
    expect(monster.reactions).toHaveLength(1);
    expect(monster.legendaryActions).toHaveLength(2);
    expect(monster.legendaryDesc).toMatch(/3 legendary actions/);
    expect(monster).toMatchObject({ cr: 11, challengeRating: "11", subtype: "" });
  });

  it("tolerates missing, null, and mistyped fields", () => {
    const monster = normalizeMonster({
      slug: "odd",
      name: "  Odd Thing ",
      armor_class: "12",
      hit_points: null,
      speed: "30 ft.",
      strength: "not a number",
      dexterity: 12,
      skills: null,
      actions: [null, { name: "Bite" }, { desc: "Unnamed." }, { name: "", desc: "" }, "junk"],
      special_abilities: {},
      reactions: undefined,
      senses: 42,
    })!;
    expect(monster.name).toBe("Odd Thing");
    expect(monster.armorClass).toBe(12);
    expect(monster.hitPoints).toBeNull();
    expect(monster.speed).toEqual([]);
    expect(monster.abilities.strength).toBeNull();
    expect(monster.abilities.dexterity).toBe(12);
    expect(monster.abilities.charisma).toBeNull();
    expect(monster.skills).toEqual([]);
    expect(monster.actions).toEqual([
      { name: "Bite", desc: "" },
      { name: "", desc: "Unnamed." },
    ]);
    expect(monster.specialAbilities).toEqual([]);
    expect(monster.reactions).toEqual([]);
    expect(monster.senses).toBe("");
  });

  it("rejects payloads without a slug or name", () => {
    expect(normalizeMonster(null)).toBeNull();
    expect(normalizeMonster([])).toBeNull();
    expect(normalizeMonster({ name: "No Slug" })).toBeNull();
    expect(normalizeMonster({ slug: "no-name", name: "  " })).toBeNull();
  });

  it("bounds section counts and string lengths from a pathological payload", () => {
    const huge = "x".repeat(MAX_DESC_LENGTH * 3);
    const many = Array.from({ length: MAX_SECTION_ENTRIES * 20 }, (_, i) => ({
      name: `${huge}${i}`,
      desc: huge,
    }));
    const monster = normalizeMonster({
      slug: "big",
      name: huge,
      senses: huge,
      legendary_desc: huge,
      actions: many,
      special_abilities: many,
      legendary_actions: many,
      skills: Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`skill${i}`, i])),
      speed: Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`mode${i}`, i])),
    })!;

    expect(monster.name).toHaveLength(MAX_FIELD_LENGTH);
    expect(monster.senses).toHaveLength(MAX_FIELD_LENGTH);
    expect(monster.legendaryDesc).toHaveLength(MAX_DESC_LENGTH);
    for (const section of [monster.actions, monster.specialAbilities, monster.legendaryActions]) {
      expect(section).toHaveLength(MAX_SECTION_ENTRIES);
      expect(section[0].name).toHaveLength(MAX_FIELD_LENGTH);
      expect(section[0].desc).toHaveLength(MAX_DESC_LENGTH);
    }
    expect(monster.skills).toHaveLength(MAX_BONUS_ENTRIES);
    expect(monster.speed).toHaveLength(MAX_BONUS_ENTRIES);
  });
});

describe("monsterQuerySchema", () => {
  it("accepts a search or a slug", () => {
    expect(monsterQuerySchema.parse({ search: "  goblin " })).toEqual({ mode: "search", search: "goblin" });
    expect(monsterQuerySchema.parse({ slug: "Adult-Red-Dragon" })).toEqual({
      mode: "slug",
      slug: "adult-red-dragon",
    });
  });

  it.each([
    [{}],
    [{ search: "   " }],
    [{ slug: "" }],
    [{ search: "goblin", slug: "goblin" }],
    [{ search: "", slug: "goblin" }],
    [{ search: "goblin", slug: "   " }],
    [{ search: "", slug: "" }],
    [{ slug: "../etc/passwd" }],
    [{ search: "x".repeat(101) }],
  ])("rejects %j", (input) => {
    expect(monsterQuerySchema.safeParse(input).success).toBe(false);
  });
});
