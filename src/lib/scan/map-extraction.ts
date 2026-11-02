import { formatLabel, type CharacterDraft } from "@/lib/character-form-values";
import {
  ABILITIES,
  CONDITIONS,
  SKILLS,
  characterInputSchema,
} from "@/lib/db/schema";

/*
 * Turns the AI's best-effort extraction (`ExtractResponseBody.data`, which is
 * NOT validated) into a draft for the character form. The goal is to keep
 * everything usable and drop only what can't fit:
 *  - numbers that arrived as numeric strings are coerced; nothing is clamped —
 *    range checks are left to the schema/form so the user sees them
 *  - list entries outside the enums are dropped individually, never fatal
 *  - unreadable/missing values are left undefined so the user fills them in
 *  - the source image data URL is kept as `rawScan`
 */

type Draft = CharacterDraft;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const NUMERIC_STRING = /^[+-]?\d+(?:\.\d+)?$/;

/** A finite number, or a numeric string; anything else → undefined. */
function toNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return NUMERIC_STRING.test(trimmed) ? Number(trimmed) : undefined;
  }
  return undefined;
}

/** A non-blank string (trimmed); anything else → undefined. */
function toText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** "Sleight of Hand" / "sleight_of_hand" / "SLEIGHTOFHAND" → "sleightofhand". */
function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z]/g, "");
}

/** Keeps entries that match an allowed value (case/spacing-insensitive), deduped, in input order. */
function toEnumList<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const lookup = new Map(allowed.map((item) => [normalizeKey(item), item]));
  const result: T[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const match = lookup.get(normalizeKey(entry));
    if (match && !result.includes(match)) result.push(match);
  }
  return result;
}

/** Drops undefined values; returns undefined if nothing is left. */
function compact<T extends Record<string, unknown>>(object: T): Partial<T> | undefined {
  const entries = Object.entries(object).filter(([, v]) => v !== undefined);
  return entries.length > 0 ? (Object.fromEntries(entries) as Partial<T>) : undefined;
}

/** Maps raw extraction data (plus the source image) into a form draft. */
export function mapExtraction(data: unknown, imageDataUrl?: string): Draft {
  const source = isRecord(data) ? data : {};
  const hp = isRecord(source.hitPoints) ? source.hitPoints : {};
  const scores = isRecord(source.abilityScores) ? source.abilityScores : {};

  const draft: Draft = {
    name: toText(source.name),
    race: toText(source.race),
    className: toText(source.className),
    level: toNumber(source.level),
    armorClass: toNumber(source.armorClass),
    hitPoints: compact({
      max: toNumber(hp.max),
      current: toNumber(hp.current),
      temporary: toNumber(hp.temporary),
    }),
    abilityScores: compact(
      Object.fromEntries(
        ABILITIES.map((ability) => [ability, toNumber(scores[ability])]),
      ),
    ),
    savingThrowProficiencies: toEnumList(source.savingThrowProficiencies, ABILITIES),
    skillProficiencies: toEnumList(source.skillProficiencies, SKILLS),
    passivePerception: toNumber(source.passivePerception),
    conditions: toEnumList(source.conditions, CONDITIONS),
    notes: toText(source.notes),
    rawScan: imageDataUrl,
  };

  return compact(draft) ?? {};
}

const FIELD_LABELS: Record<string, string> = {
  className: "Class",
  armorClass: "Armor Class",
  "hitPoints.max": "Max HP",
  "hitPoints.current": "Current HP",
  "hitPoints.temporary": "Temporary HP",
};

/** Form label for a schema field path ("abilityScores.strength" → "Strength"). */
export function fieldLabel(path: string): string {
  if (FIELD_LABELS[path]) return FIELD_LABELS[path];
  const last = path.split(".").pop() ?? path;
  return formatLabel(last);
}

export type DraftAssessment = {
  valid: boolean;
  /** Field paths (e.g. "hitPoints.max") that are missing or fail the schema, in schema order. */
  needsAttention: string[];
};

/**
 * Safe-parses a draft against the character schema to report which fields the
 * user should check. Never throws and never blocks — the form re-validates on submit.
 */
export function assessDraft(draft: Draft): DraftAssessment {
  const result = characterInputSchema.safeParse(draft);
  if (result.success) return { valid: true, needsAttention: [] };
  const paths = result.error.issues.map((issue) =>
    issue.path.length > 0 ? issue.path.join(".") : "form",
  );
  return { valid: false, needsAttention: [...new Set(paths)] };
}
