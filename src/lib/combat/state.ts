import {
  combatantName,
  repository as defaultRepository,
  type Combatant,
  type Condition,
  type HitPoints,
  type Repository,
} from "@/lib/db";

/*
 * Read side of the monster stable, for grounding the chat assistant in the
 * live fight. Nothing here writes; the stable screen owns mutations. Client
 * only (reads IndexedDB through the repository).
 */

/** One monster in the current fight, with its live state. */
export interface CombatantSummary {
  id: string;
  /** Label if set, else the monster's name ("Goblin 2"). */
  name: string;
  /** The underlying monster's name and slug ("Goblin", "goblin"). */
  monsterName: string;
  slug: string;
  armorClass: number | null;
  challengeRating: string | null;
  hitPoints: HitPoints;
  conditions: Condition[];
  /** Current HP is 0. */
  down: boolean;
}

export function summarizeCombatant(combatant: Combatant): CombatantSummary {
  const { monster, hitPoints, conditions } = combatant;
  return {
    id: combatant.id,
    name: combatantName(combatant),
    monsterName: monster.name,
    slug: monster.slug,
    armorClass: monster.armorClass,
    challengeRating: monster.challengeRating,
    hitPoints,
    conditions,
    down: hitPoints.current === 0,
  };
}

/** Every combatant in the stable with live HP and conditions, in the order added. */
export async function getCombatState(
  repo: Repository = defaultRepository,
): Promise<CombatantSummary[]> {
  return (await repo.combatants.getAll()).map(summarizeCombatant);
}

/** "- Goblin 2 (Goblin, CR 1/4) — AC 15; HP 4/7 (+3 temp); conditions: prone" per line. */
export function formatCombatState(combatants: readonly CombatantSummary[]): string {
  if (combatants.length === 0) return "Monsters in combat: none.";
  const lines = combatants.map((c) => {
    const identity = [c.name !== c.monsterName && c.monsterName, c.challengeRating && `CR ${c.challengeRating}`]
      .filter(Boolean)
      .join(", ");
    const { current, max, temporary } = c.hitPoints;
    const parts = [
      ...(c.armorClass === null ? [] : [`AC ${c.armorClass}`]),
      `HP ${current}/${max}${temporary > 0 ? ` (+${temporary} temp)` : ""}${c.down ? " (down)" : ""}`,
    ];
    if (c.conditions.length > 0) parts.push(`conditions: ${c.conditions.join(", ")}`);
    return `- ${c.name}${identity ? ` (${identity})` : ""} — ${parts.join("; ")}`;
  });
  return [`Monsters in combat (${combatants.length}):`, ...lines].join("\n");
}
