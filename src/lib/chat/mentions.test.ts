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

import {
  buildMentionables,
  filterMentionables,
  findActiveMention,
  insertMention,
  MAX_MENTION_OPTIONS,
  MAX_PINNED_MENTIONS,
  pinMentions,
  untagMention,
  type ChosenMention,
} from "./mentions";

const stamps = { createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };

function character(overrides: Partial<CharacterInput> = {}): Character {
  return characterSchema.parse({ ...characterInput(overrides), id: crypto.randomUUID(), ...stamps });
}

const goblin = normalizeMonster(goblinRaw)!;
const guardian = normalizeMonster(guardianRaw)!;

function combatant(overrides: Partial<CombatantInput> = {}): Combatant {
  return combatantSchema.parse({
    monster: goblin,
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
const bard = character({ name: "Bard", className: "Bard", level: 4 });

describe("buildMentionables", () => {
  it("lists party members then combatants with ids, kinds, names, hints, and stat summaries", () => {
    const hurt = combatant({ label: "Goblin 2", hitPoints: { max: 7, current: 0 }, conditions: ["prone"] });
    const list = buildMentionables([thorin], [hurt]);
    expect(list).toEqual([
      {
        kind: "character",
        id: thorin.id,
        name: "Thorin Oakenshield",
        token: "Thorin Oakenshield",
        hint: "PC · Fighter 5 · HP 9/44",
        summary: "Thorin (Thorin Oakenshield) — Dwarf Fighter 5; AC 18; HP 9/44; conditions: prone",
        aliases: [],
      },
      {
        kind: "combatant",
        id: hurt.id,
        name: "Goblin 2",
        token: "Goblin 2",
        hint: "CR 1/4 · HP 0/7 (down)",
        summary: "Goblin 2 (Goblin, CR 1/4) — AC 15; HP 0/7 (down); conditions: prone",
        aliases: ["Goblin"],
      },
    ]);
  });

  it("gives same-named entities distinct tokens so each tag means exactly one", () => {
    const first = combatant();
    const second = combatant({ label: "goblin" });
    const pc = character({ name: "Goblin" });
    const list = buildMentionables([pc], [first, second]);
    expect(list.map((m) => [m.id, m.token])).toEqual([
      [pc.id, "Goblin"],
      [first.id, "Goblin (2)"],
      [second.id, "goblin (3)"],
    ]);
  });

  it("flattens whitespace and caps long names in tokens", () => {
    const [m] = buildMentionables([character({ name: `Ann\n  ${"e".repeat(200)}` })], []);
    expect(m.token).toMatch(/^Ann e+$/);
    expect(m.token.length).toBe(60);
  });
});

describe("findActiveMention", () => {
  it("finds the @word the caret is in, running to the end of the word", () => {
    expect(findActiveMention("how hurt is @tho", 16)).toEqual({ start: 12, end: 16, query: "tho" });
    expect(findActiveMention("@thorin now", 3)).toEqual({ start: 0, end: 7, query: "th" });
    expect(findActiveMention("hi @", 4)).toEqual({ start: 3, end: 4, query: "" });
  });

  it("ignores text without an active tag, emails, and finished words", () => {
    expect(findActiveMention("can a bard heal?", 10)).toBeNull();
    expect(findActiveMention("dm@example.com", 14)).toBeNull();
    expect(findActiveMention("@thorin is hurt", 15)).toBeNull();
  });
});

describe("filterMentionables", () => {
  const ilsa = character({ name: "Ilsa" });
  const snag = combatant({ label: "Snaggletooth" });
  const list = buildMentionables([thorin, ilsa, bard], [combatant(), snag]);
  const names = (query: string, limit?: number) =>
    filterMentionables(list, query, limit).map((m) => m.token);

  it("matches name prefixes case-insensitively, then later words, then substrings", () => {
    expect(names("THO")).toEqual(["Thorin Oakenshield"]);
    expect(names("oak")).toEqual(["Thorin Oakenshield"]);
    expect(names("ls")).toEqual(["Ilsa"]);
    // A combatant's monster name matches too, after direct name matches.
    expect(names("gob")).toEqual(["Goblin", "Snaggletooth"]);
  });

  it("lists everything for a bare @, bounded", () => {
    expect(names("")).toEqual(["Thorin Oakenshield", "Ilsa", "Bard", "Goblin", "Snaggletooth"]);
    expect(names("", 2)).toHaveLength(2);
    const many = buildMentionables(
      Array.from({ length: 20 }, (_, i) => character({ name: `Hero ${i}` })),
      [],
    );
    expect(filterMentionables(many, "her")).toHaveLength(MAX_MENTION_OPTIONS);
  });

  it("returns nothing for no match", () => {
    expect(names("zzz")).toEqual([]);
  });
});

describe("insertMention", () => {
  it("replaces the partial tag with the token and records the pick", () => {
    const [m] = buildMentionables([thorin], []);
    const text = "how hurt is @tho?";
    const result = insertMention(text, findActiveMention(text, 16)!, m);
    expect(result.text).toBe("how hurt is @Thorin Oakenshield ");
    expect(result.caret).toBe(result.text.length);
    expect(result.chosen).toEqual({ id: thorin.id, token: "Thorin Oakenshield" });
  });

  it("doesn't double a following space", () => {
    const [m] = buildMentionables([thorin], []);
    const result = insertMention("@th now", { start: 0, end: 3, query: "th" }, m);
    expect(result.text).toBe("@Thorin Oakenshield now");
    expect(result.caret).toBe("@Thorin Oakenshield ".length);
  });
});

describe("pinMentions", () => {
  it("pins tagged entities with their stats, in order, ignoring untagged names", () => {
    const g2 = combatant({ label: "Goblin 2", hitPoints: { max: 7, current: 3 } });
    const list = buildMentionables([thorin, bard], [combatant(), g2]);
    const pinned = pinMentions("Can @goblin 2 reach @Thorin Oakenshield? Thorin, the bard, Bard.", [], list);
    expect(pinned).toEqual([
      expect.objectContaining({
        kind: "combatant",
        id: g2.id,
        name: "Goblin 2",
        summary: "Goblin 2 (Goblin, CR 1/4) — AC 15; HP 3/7",
      }),
      expect.objectContaining({ kind: "character", id: thorin.id, name: "Thorin Oakenshield" }),
    ]);
  });

  it("pins nothing for untagged prose, emails, or partial tags", () => {
    const list = buildMentionables([thorin, bard], [combatant()]);
    expect(pinMentions("can a bard heal? Will Bard help?", [], list)).toEqual([]);
    expect(pinMentions("mail bard@example.com", [], list)).toEqual([]);
    expect(pinMentions("@Thorin attacks @Bardic", [], list)).toEqual([]);
  });

  it("uses the picked id for duplicates, even after the stable renumbers", () => {
    const first = combatant();
    const second = combatant();
    const before = buildMentionables([], [first, second]);
    const pick: ChosenMention = { id: second.id, token: before[1].token };
    expect(pick.token).toBe("Goblin (2)");
    expect(pinMentions("hit @Goblin (2)", [pick], before).map((p) => p.id)).toEqual([second.id]);
    expect(pinMentions("hit @Goblin", [pick], before).map((p) => p.id)).toEqual([first.id]);

    // A third goblin added ahead of it would otherwise take "Goblin (2)".
    const third = combatant();
    const after = buildMentionables([], [first, third, second]);
    expect(pinMentions("hit @Goblin (2)", [pick], after).map((p) => p.id)).toEqual([second.id]);
  });

  it("drops a pick whose entity was removed", () => {
    const gone = combatant({ monster: guardian, label: "Warden" });
    const list = buildMentionables([thorin], []);
    expect(pinMentions("is @Warden down?", [{ id: gone.id, token: "Warden" }], list)).toEqual([]);
  });

  it("drops a duplicate's removed pick rather than falling back to the shorter token", () => {
    const first = combatant();
    const second = combatant();
    const pick: ChosenMention = { id: second.id, token: buildMentionables([], [first, second])[1].token };
    expect(pick.token).toBe("Goblin (2)");
    const remaining = buildMentionables([], [first]);
    expect(pinMentions("hit @Goblin (2)", [pick], remaining)).toEqual([]);
    expect(untagMention("hit @Goblin (2)", first.id, [pick], remaining)).toBe("hit @Goblin (2)");
    // A separate hand-typed "@Goblin" still tags the first goblin.
    expect(pinMentions("@Goblin (2) and @Goblin", [pick], remaining).map((p) => p.id)).toEqual([first.id]);
  });

  it("drops a removed pick even when another entity has inherited its token", () => {
    const first = combatant();
    const second = combatant();
    const third = combatant();
    const pick: ChosenMention = { id: second.id, token: buildMentionables([], [first, second, third])[1].token };
    expect(pick.token).toBe("Goblin (2)");
    const renumbered = buildMentionables([], [first, third]);
    expect(renumbered[1]).toMatchObject({ id: third.id, token: "Goblin (2)" });
    expect(pinMentions("hit @Goblin (2)", [pick], renumbered)).toEqual([]);
    // Without the pick, a hand-typed "@Goblin (2)" tags whoever holds it now.
    expect(pinMentions("hit @Goblin (2)", [], renumbered).map((p) => p.id)).toEqual([third.id]);
    // Re-picking the inheritor makes that the latest pick for the token.
    const repick: ChosenMention = { id: third.id, token: "Goblin (2)" };
    expect(pinMentions("hit @Goblin (2)", [pick, repick], renumbered).map((p) => p.id)).toEqual([third.id]);
  });

  it("pins each entity once and at most MAX_PINNED_MENTIONS", () => {
    const party = Array.from({ length: 10 }, (_, i) => character({ name: `Hero${i}` }));
    const list = buildMentionables(party, []);
    const text = ["@Hero0 @hero0", ...party.map((p) => `@${p.name}`)].join(" ");
    const pinned = pinMentions(text, [], list);
    expect(pinned).toHaveLength(MAX_PINNED_MENTIONS);
    expect(pinned.map((p) => p.name)).toEqual(["Hero0", "Hero1", "Hero2", "Hero3", "Hero4", "Hero5"]);
  });
});

describe("untagMention", () => {
  it("turns only that entity's tags back into plain words", () => {
    const list = buildMentionables([thorin], [combatant()]);
    expect(untagMention("@Thorin Oakenshield hits @Goblin, @Thorin Oakenshield!", thorin.id, [], list)).toBe(
      "Thorin Oakenshield hits @Goblin, Thorin Oakenshield!",
    );
  });
});
