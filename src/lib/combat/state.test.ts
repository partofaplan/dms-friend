import { normalizeMonster } from "@/lib/monsters/types";
import { goblinRaw, guardianRaw } from "@/test-utils/open5e-fixtures";
import { createTestRepository } from "@/test-utils/repository";

import { formatCombatState, getCombatState } from "./state";

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
