import { CONDITIONS } from "@/lib/db/schema";
import { normalizeMonster } from "@/lib/monsters/types";
import { goblinRaw, guardianRaw } from "@/test-utils/open5e-fixtures";
import { createTestRepository } from "@/test-utils/repository";

import {
  describeCombatant,
  formatCombatState,
  getCombatState,
  MAX_COMBAT_STATE_LENGTH,
  MAX_COMBATANT_NAME_LENGTH,
  MAX_COMBATANTS_LISTED,
  MAX_CONDITIONS_LENGTH,
  type CombatantSummary,
} from "./state";

const goblin = normalizeMonster(goblinRaw)!;
const guardian = normalizeMonster(guardianRaw)!;

describe("combat state", () => {
  it("reads the stable's live HP and conditions in one call", async () => {
    const repo = createTestRepository();
    try {
      expect(await getCombatState(repo)).toEqual([]);
      expect(formatCombatState([])).toBe("Monsters in combat: none.");

      const first = await repo.combatants.addFromMonster(goblin);
      const second = await repo.combatants.addFromMonster(goblin);
      await repo.combatants.addFromMonster(guardian);
      await repo.combatants.update(second.id, {
        hitPoints: { max: 7, current: 4, temporary: 3 },
        conditions: ["prone", "poisoned"],
      });
      await repo.combatants.update(first.id, { hitPoints: { max: 7, current: 0 } });

      const state = await getCombatState(repo);
      const goblin2 = state.find((c) => c.id === second.id);
      expect(goblin2).toMatchObject({
        name: "Goblin 2",
        monsterName: "Goblin",
        slug: "goblin",
        armorClass: 15,
        challengeRating: "1/4",
        hitPoints: { max: 7, current: 4, temporary: 3 },
        conditions: ["prone", "poisoned"],
        down: false,
      });
      expect(state.find((c) => c.id === first.id)?.down).toBe(true);

      const text = formatCombatState(state);
      expect(text).toContain("Monsters in combat (3):");
      expect(text).toContain("- Goblin (CR 1/4) — AC 15; HP 0/7 (down)");
      expect(text).toContain(
        "- Goblin 2 (Goblin, CR 1/4) — AC 15; HP 4/7 (+3 temp); conditions: prone, poisoned",
      );
      expect(text).toContain("- Vault Guardian (CR 11) — AC 18; HP 178/178");
    } finally {
      repo.db.close();
    }
  });
});

describe("formatCombatState bounds", () => {
  function summary(overrides: Partial<CombatantSummary> = {}): CombatantSummary {
    return {
      id: crypto.randomUUID(),
      name: "Goblin",
      monsterName: "Goblin",
      slug: "goblin",
      armorClass: 15,
      challengeRating: "1/4",
      hitPoints: { max: 7, current: 7, temporary: 0 },
      conditions: [],
      down: false,
      ...overrides,
    };
  }

  it("lists at most MAX_COMBATANTS_LISTED and counts the rest", () => {
    const stable = Array.from({ length: 50 }, (_, i) => summary({ name: `Goblin ${i + 1}` }));
    const text = formatCombatState(stable);
    expect(text).toContain("Monsters in combat (50):");
    expect(text).toContain(`- Goblin ${MAX_COMBATANTS_LISTED} (Goblin, CR 1/4)`);
    expect(text).not.toContain(`- Goblin ${MAX_COMBATANTS_LISTED + 1} `);
    expect(text.split("\n").at(-1)).toBe(`- …and ${50 - MAX_COMBATANTS_LISTED} more not listed.`);
    expect(text.length).toBeLessThanOrEqual(MAX_COMBAT_STATE_LENGTH);
  });

  it("clips long names and condition lists and never exceeds the hard cap", () => {
    const stable = Array.from({ length: 200 }, () =>
      summary({
        name: "L".repeat(5_000),
        monsterName: "M\n".repeat(5_000),
        challengeRating: "9".repeat(500),
        conditions: [...CONDITIONS],
      }),
    );
    const text = formatCombatState(stable);
    expect(text.length).toBeLessThanOrEqual(MAX_COMBAT_STATE_LENGTH);
    const first = text.split("\n")[1];
    expect(first.startsWith(`- ${"L".repeat(MAX_COMBATANT_NAME_LENGTH - 1)}… (`)).toBe(true);
    const conditions = /conditions: (.*)$/.exec(first)![1];
    expect(conditions.length).toBeLessThanOrEqual(MAX_CONDITIONS_LENGTH);
    expect(conditions.endsWith("…")).toBe(true);
    // Fewer than the listing cap fit in the length budget; the rest are counted.
    const listed = text.split("\n").filter((line) => line.startsWith(`- ${"L"}`)).length;
    expect(listed).toBeLessThan(MAX_COMBATANTS_LISTED);
    expect(text).toMatch(new RegExp(`- …and ${200 - listed} more not listed\\.$`));
  });

  it("describes one combatant on a single line", () => {
    expect(describeCombatant(summary({ name: "Boss", monsterName: "Goblin", down: true, hitPoints: { max: 7, current: 0, temporary: 0 } }))).toBe(
      "Boss (Goblin, CR 1/4) — AC 15; HP 0/7 (down)",
    );
  });
});
