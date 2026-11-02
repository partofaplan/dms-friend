import { describeCombatant, summarizeCombatant } from "@/lib/combat/state";
import { combatantName, type Character, type Combatant } from "@/lib/db/schema";
import { clip } from "@/lib/text/clip";

import { MAX_USER_MESSAGE_LENGTH } from "./context";
import {
  describeCharacter,
  isUsableHandle,
  MAX_SHORT_FIELD_LENGTH,
  nameHandle,
  nameTokens,
} from "./describe";

/*
 * Deterministic name resolution for the chat: which party members and
 * combatants a DM's message names, so their stats can be pinned into that
 * turn's system prompt. Exact matching only — full names, first-name handles
 * ("Thorin" for "Thorin Oakenshield"), labels ("Goblin 2"), and monster names
 * ("the goblin"), case- and accent-insensitive, on whole words. Anything
 * fuzzier is left to the model, which sees the whole party and stable. Pure.
 */

/** Entities pinned for one message, in the order the message first names them. */
export const MAX_RESOLVED_REFERENCES = 6;
/** Other possible entities listed on an ambiguous reference. */
export const MAX_ALTERNATIVES = 3;
/** Characters of a name considered when matching (names are rarely near this). */
const MAX_MATCHED_NAME_LENGTH = 200;

export interface ResolvedReference {
  kind: "character" | "combatant";
  id: string;
  /** Display name: the character's name or the combatant's label/monster name. */
  name: string;
  /** Compact stat line (the same one the party/combat summaries use). */
  summary: string;
  /** The name as the roster/stable spells it that the message used: "Thorin", "Goblin 2". */
  matched: string;
  /** The words matched more than one entity; all of them are returned. */
  ambiguous: boolean;
  /** Up to MAX_ALTERNATIVES other entities those words could mean. */
  alternatives: string[];
}

export interface ResolveReferencesInput {
  party: readonly Character[];
  combatants?: readonly Combatant[];
}

interface Entity {
  kind: ResolvedReference["kind"];
  id: string;
  name: string;
  summary: () => string;
}

/** A name (or handle) as words, and every entity it can stand for. */
interface Phrase {
  tokens: string[];
  display: string;
  entities: Entity[];
}

function entitiesOf({ party, combatants = [] }: ResolveReferencesInput) {
  const characters = party.map(
    (character): [Entity, string[]] => [
      {
        kind: "character",
        id: character.id,
        name: clip(character.name, MAX_SHORT_FIELD_LENGTH),
        summary: () => describeCharacter(character),
      },
      [character.name],
    ],
  );
  const monsters = combatants.map((combatant): [Entity, string[]] => {
    const name = combatantName(combatant);
    return [
      {
        kind: "combatant",
        id: combatant.id,
        name: clip(name, MAX_SHORT_FIELD_LENGTH),
        summary: () => describeCombatant(summarizeCombatant(combatant)),
      },
      [name, combatant.monster.name],
    ];
  });
  return [...characters, ...monsters];
}

/**
 * Index of every name and handle by its first word, longest phrase first so
 * "Goblin 2" wins over "Goblin" at the same spot.
 */
function indexPhrases(input: ResolveReferencesInput): Map<string, Phrase[]> {
  const phrases = new Map<string, Phrase>();
  const add = (text: string, entity: Entity) => {
    const display = clip(text, MAX_SHORT_FIELD_LENGTH);
    const tokens = nameTokens(text.slice(0, MAX_MATCHED_NAME_LENGTH));
    // A one-word name must itself be usable as a handle ("The" never matches).
    if (tokens.length === 0 || (tokens.length === 1 && !isUsableHandle(tokens[0]))) return;
    const key = tokens.join(" ");
    let phrase = phrases.get(key);
    if (!phrase) {
      phrase = { tokens, display, entities: [] };
      phrases.set(key, phrase);
    }
    if (!phrase.entities.includes(entity)) phrase.entities.push(entity);
  };
  for (const [entity, names] of entitiesOf(input)) {
    for (const name of names) {
      add(name, entity);
      const handle = nameHandle(name);
      if (handle) add(handle, entity);
    }
  }

  const byFirstWord = new Map<string, Phrase[]>();
  for (const phrase of phrases.values()) {
    const list = byFirstWord.get(phrase.tokens[0]) ?? [];
    list.push(phrase);
    byFirstWord.set(phrase.tokens[0], list);
  }
  for (const list of byFirstWord.values()) list.sort((a, b) => b.tokens.length - a.tokens.length);
  return byFirstWord;
}

/**
 * The party members and combatants `message` names, at most
 * MAX_RESOLVED_REFERENCES, in order of first mention. Words that name several
 * entities (two "Thorin"s, a "Goblin" and a "Goblin 2", a character and a
 * combatant sharing a name) return them all, marked ambiguous — unless
 * another, unambiguous mention in the same message singles one out.
 */
export function resolveReferences(message: string, input: ResolveReferencesInput): ResolvedReference[] {
  const index = indexPhrases(input);
  if (index.size === 0) return [];
  const words = nameTokens(message.slice(0, MAX_USER_MESSAGE_LENGTH));

  const resolved = new Map<string, ResolvedReference>();
  for (let i = 0; i < words.length; ) {
    const phrase = index
      .get(words[i])
      ?.find((p) => p.tokens.every((token, offset) => words[i + offset] === token));
    if (!phrase) {
      i += 1;
      continue;
    }
    i += phrase.tokens.length;

    const ambiguous = phrase.entities.length > 1;
    for (const entity of phrase.entities) {
      const key = `${entity.kind}:${entity.id}`;
      const existing = resolved.get(key);
      if (existing) {
        if (!ambiguous && existing.ambiguous) {
          resolved.set(key, { ...existing, matched: phrase.display, ambiguous: false, alternatives: [] });
        }
        continue;
      }
      if (resolved.size >= MAX_RESOLVED_REFERENCES) continue;
      resolved.set(key, {
        kind: entity.kind,
        id: entity.id,
        name: entity.name,
        summary: entity.summary(),
        matched: phrase.display,
        ambiguous,
        alternatives: phrase.entities
          .filter((other) => other !== entity)
          .slice(0, MAX_ALTERNATIVES)
          .map((other) => other.name),
      });
    }
  }
  return [...resolved.values()];
}
