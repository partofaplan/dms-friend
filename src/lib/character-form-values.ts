import type { z } from "zod";

import {
  ABILITIES,
  characterInputSchema,
  type Ability,
  type CharacterInput,
  type Condition,
  type Skill,
} from "@/lib/db/schema";

/*
 * Bridges the character form (which holds raw strings from inputs) and the
 * Zod character schema. Validation rules live only in the schema; this module
 * just converts form values into schema input and turns Zod issues into
 * human-readable, per-field messages keyed by dotted path ("hitPoints.max").
 */

export type CharacterFormValues = {
  name: string;
  race: string;
  className: string;
  level: string;
  armorClass: string;
  hitPoints: { max: string; current: string; temporary: string };
  abilityScores: Record<Ability, string>;
  savingThrowProficiencies: Ability[];
  skillProficiencies: Skill[];
  passivePerception: string;
  conditions: Condition[];
  notes: string;
};

/** Field path (e.g. "abilityScores.strength") → first error message. */
export type CharacterFormErrors = Partial<Record<string, string>>;

export type CharacterInputOutput = z.output<typeof characterInputSchema>;

export type ValidationResult =
  | { success: true; data: CharacterInputOutput; errors: CharacterFormErrors }
  | { success: false; errors: CharacterFormErrors };

const DEFAULT_ABILITY_SCORE = 10;

function numberToString(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

/** Builds form values from (possibly partial) character data, e.g. an existing record or scan output. */
export function toFormValues(
  initial: Partial<CharacterInput> = {},
): CharacterFormValues {
  const scores = initial.abilityScores;
  return {
    name: initial.name ?? "",
    race: initial.race ?? "",
    className: initial.className ?? "",
    level: numberToString(initial.level ?? 1),
    armorClass: numberToString(initial.armorClass),
    hitPoints: {
      max: numberToString(initial.hitPoints?.max),
      current: numberToString(initial.hitPoints?.current),
      temporary: numberToString(initial.hitPoints?.temporary ?? 0),
    },
    abilityScores: Object.fromEntries(
      ABILITIES.map((ability) => [
        ability,
        numberToString(scores?.[ability] ?? DEFAULT_ABILITY_SCORE),
      ]),
    ) as Record<Ability, string>,
    savingThrowProficiencies: [...(initial.savingThrowProficiencies ?? [])],
    skillProficiencies: [...(initial.skillProficiencies ?? [])],
    passivePerception: numberToString(initial.passivePerception),
    conditions: [...(initial.conditions ?? [])],
    notes: initial.notes ?? "",
  };
}

/** Empty → undefined (so the schema reports "required" or treats it as omitted); otherwise Number(). */
function parseNumber(value: string): number | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : Number(trimmed);
}

function optionalText(value: string): string | undefined {
  return value.trim() === "" ? undefined : value;
}

/** Converts raw form values into unvalidated schema input. */
export function toCharacterInput(values: CharacterFormValues): unknown {
  return {
    name: values.name,
    race: optionalText(values.race),
    className: values.className,
    level: parseNumber(values.level),
    armorClass: parseNumber(values.armorClass),
    hitPoints: {
      max: parseNumber(values.hitPoints.max),
      current: parseNumber(values.hitPoints.current),
      temporary: parseNumber(values.hitPoints.temporary),
    },
    abilityScores: Object.fromEntries(
      ABILITIES.map((ability) => [
        ability,
        parseNumber(values.abilityScores[ability]),
      ]),
    ),
    savingThrowProficiencies: values.savingThrowProficiencies,
    skillProficiencies: values.skillProficiencies,
    passivePerception: parseNumber(values.passivePerception),
    conditions: values.conditions,
    notes: optionalText(values.notes),
  };
}

/*
 * Per-parse error map: rewords Zod's generic messages for form users. Messages
 * defined on the schema itself (e.g. "name is required") take precedence.
 */
function friendlyMessage(issue: z.core.$ZodRawIssue): string | undefined {
  switch (issue.code) {
    case "invalid_type":
      if (issue.input === undefined) return "Required";
      if (issue.expected === "int") return "Must be a whole number";
      if (issue.expected === "number") return "Must be a number";
      return undefined;
    case "too_small":
      if (issue.origin === "number") {
        return issue.inclusive === false
          ? `Must be greater than ${issue.minimum}`
          : `Must be at least ${issue.minimum}`;
      }
      return undefined;
    case "too_big":
      if (issue.origin === "number") {
        return issue.inclusive === false
          ? `Must be less than ${issue.maximum}`
          : `Must be at most ${issue.maximum}`;
      }
      return undefined;
    default:
      return undefined;
  }
}

function capitalize(message: string): string {
  return message.charAt(0).toUpperCase() + message.slice(1);
}

/** Validates form values against the character schema, returning parsed data or field errors. */
export function validateCharacterForm(
  values: CharacterFormValues,
): ValidationResult {
  const result = characterInputSchema.safeParse(toCharacterInput(values), {
    error: friendlyMessage,
  });
  if (result.success) return { success: true, data: result.data, errors: {} };

  const errors: CharacterFormErrors = {};
  for (const issue of result.error.issues) {
    const key = issue.path.length > 0 ? issue.path.join(".") : "form";
    errors[key] ??= capitalize(issue.message);
  }
  return { success: false, errors };
}

/** "animalHandling" → "Animal Handling". */
export function formatLabel(key: string): string {
  return capitalize(key.replace(/([A-Z])/g, " $1"));
}
