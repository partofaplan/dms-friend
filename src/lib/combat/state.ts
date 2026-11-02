import {
  combatantName,
  repository as defaultRepository,
  type Combatant,
  type Condition,
  type AppRepository,
  type HitPoints,
} from "@/lib/db";
import { activePartyScope } from "@/lib/profiles/active-profile";
import { clip, TRUNCATION_MARK } from "@/lib/text/clip";

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

/** Every combatant in the active party's stable with live HP and conditions, in the order added. */
export async function getCombatState(
  repo: AppRepository = defaultRepository,
): Promise<CombatantSummary[]> {
  const scope = await activePartyScope(repo);
  return (await scope.combatants.getAll()).map(summarizeCombatant);
}

/** Combatants described in full; the rest are only counted. */
export const MAX_COMBATANTS_LISTED = 12;
/** Characters kept per combatant name, monster name, or challenge rating. */
export const MAX_COMBATANT_NAME_LENGTH = 60;
/** Characters kept for a combatant's condition list. */
export const MAX_CONDITIONS_LENGTH = 120;
/** Hard cap on the whole combat-state text. */
export const MAX_COMBAT_STATE_LENGTH = 1_500;

/** "Goblin 2 (Goblin, CR 1/4) — AC 15; HP 4/7 (+3 temp); conditions: prone", every field capped. */
export function describeCombatant(c: CombatantSummary): string {
  const short = (value: string) => clip(value, MAX_COMBATANT_NAME_LENGTH);
  const name = short(c.name);
  const monsterName = short(c.monsterName);
  const identity = [name !== monsterName && monsterName, c.challengeRating && `CR ${short(c.challengeRating)}`]
    .filter(Boolean)
    .join(", ");
  const { current, max, temporary } = c.hitPoints;
  const parts = [
    ...(c.armorClass === null ? [] : [`AC ${c.armorClass}`]),
    `HP ${current}/${max}${temporary > 0 ? ` (+${temporary} temp)` : ""}${c.down ? " (down)" : ""}`,
  ];
  if (c.conditions.length > 0) {
    parts.push(`conditions: ${clip(c.conditions.join(", "), MAX_CONDITIONS_LENGTH)}`);
  }
  return `${name}${identity ? ` (${identity})` : ""} — ${parts.join("; ")}`;
}

/**
 * "Monsters in combat (N):" then one "- <describeCombatant>" line each. At
 * most MAX_COMBATANTS_LISTED are described and the text never exceeds
 * MAX_COMBAT_STATE_LENGTH; whatever is left out is counted in a closing
 * "- …and N more not listed." line.
 */
export function formatCombatState(combatants: readonly CombatantSummary[]): string {
  if (combatants.length === 0) return "Monsters in combat: none.";
  const header = `Monsters in combat (${combatants.length}):`;
  const more = (hidden: number) => `- ${TRUNCATION_MARK}and ${hidden} more not listed.`;
  // Leave room for the header and the longest possible "more" line.
  const budget = MAX_COMBAT_STATE_LENGTH - header.length - more(combatants.length).length - 2;

  const lines: string[] = [];
  let length = 0;
  for (const combatant of combatants.slice(0, MAX_COMBATANTS_LISTED)) {
    const line = `- ${describeCombatant(combatant)}`;
    if (length + line.length + 1 > budget) break;
    lines.push(line);
    length += line.length + 1;
  }
  const hidden = combatants.length - lines.length;
  if (hidden > 0) lines.push(more(hidden));
  return [header, ...lines].join("\n");
}
