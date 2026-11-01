import { ABILITIES, CONDITIONS, SKILLS } from "@/lib/db/schema";

/*
 * Prompt and JSON Schema for extracting a character from a sheet photo.
 * Field names mirror characterInputSchema in src/lib/db/schema.ts so the
 * result maps straight onto it. The schema is written for OpenAI Structured
 * Outputs strict mode: every property is required and unreadable values are
 * represented as null rather than omitted.
 */

const nullableInteger = (description: string) => ({
  type: ["integer", "null"],
  description,
});

const nullableString = (description: string) => ({
  type: ["string", "null"],
  description,
});

const enumList = (values: readonly string[], description: string) => ({
  type: "array",
  items: { type: "string", enum: [...values] },
  description,
});

export const CHARACTER_EXTRACTION_SCHEMA_NAME = "character_sheet";

export const characterExtractionJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "name",
    "race",
    "className",
    "level",
    "armorClass",
    "hitPoints",
    "abilityScores",
    "savingThrowProficiencies",
    "skillProficiencies",
    "passivePerception",
    "conditions",
    "notes",
  ],
  properties: {
    name: nullableString("Character name."),
    race: nullableString("Race or species, e.g. 'Half-Elf'."),
    className: nullableString(
      "Class, e.g. 'Fighter'. For multiclass characters list all, e.g. 'Fighter 3 / Wizard 2'.",
    ),
    level: nullableInteger("Total character level, 1-20."),
    armorClass: nullableInteger("Armor Class."),
    hitPoints: {
      type: "object",
      additionalProperties: false,
      required: ["max", "current", "temporary"],
      properties: {
        max: nullableInteger("Hit point maximum."),
        current: nullableInteger("Current hit points; null if not written."),
        temporary: nullableInteger("Temporary hit points; null if not written."),
      },
    },
    abilityScores: {
      type: "object",
      additionalProperties: false,
      required: [...ABILITIES],
      properties: Object.fromEntries(
        ABILITIES.map((ability) => [
          ability,
          nullableInteger(`${ability} score (1-30), not the modifier.`),
        ]),
      ),
    },
    savingThrowProficiencies: enumList(
      ABILITIES,
      "Abilities whose saving throw is marked proficient.",
    ),
    skillProficiencies: enumList(SKILLS, "Skills marked proficient (or expertise)."),
    passivePerception: nullableInteger("Passive Wisdom (Perception)."),
    conditions: enumList(CONDITIONS, "Conditions currently noted on the sheet, usually none."),
    notes: nullableString(
      "Short free-text notes worth keeping that do not fit other fields (e.g. key features, languages). Null if none.",
    ),
  },
} as const;

export const CHARACTER_EXTRACTION_SYSTEM_PROMPT = [
  "You read photos of Dungeons & Dragons 5th edition character sheets and transcribe them into JSON.",
  "Only report what is legible on the sheet. If a value is missing or unreadable, use null (or an empty list) — never guess.",
  "Ability scores are the large score values (1-30), not the +/- modifiers.",
  `Use these exact identifiers. Abilities: ${ABILITIES.join(", ")}.`,
  `Skills: ${SKILLS.join(", ")}.`,
  `Conditions: ${CONDITIONS.join(", ")}.`,
  "Respond with JSON matching the provided schema and nothing else.",
].join("\n");

export const CHARACTER_EXTRACTION_USER_PROMPT =
  "Extract the character from this character sheet image.";
