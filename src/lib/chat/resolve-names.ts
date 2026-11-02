import { describeCombatant, summarizeCombatant } from "@/lib/combat/state";
import { combatantName, type Character, type Combatant } from "@/lib/db/schema";
import { clip } from "@/lib/text/clip";

import { MAX_USER_MESSAGE_LENGTH } from "./context";
import {
  describeCharacter,
  isCommonWordName,
  isCommonWordPhrase,
  isUsableHandle,
  MAX_NAME_LENGTH,
  MAX_SHORT_FIELD_LENGTH,
  nameHandle,
  nameTokens,
  nameWords,
  type NameWord,
} from "./describe";

/*
 * Deterministic name resolution for the chat: which party members and
 * combatants a DM's message names, so their stats can be pinned into that
 * turn's system prompt. Exact matching only — full names, first-name handles
 * ("Thorin" for "Thorin Oakenshield"), labels ("Goblin 2"), and monster names
 * ("the goblin"), case- and accent-insensitive, on whole words. Anything
 * fuzzier is left to the model, which sees the whole party and stable. Pure.
 *
 * A character name made only of everyday words ("Will", "The Bard") is prose
 * unless the message marks it as a name: a possessive ("Will's sword"), a
 * capitalized common word mid-sentence ("How is Bard doing"), or a capitalized
 * one addressed at the start of a clause ("Bard, make a check"). A bare one
 * opening a sentence ("Will attacks", "May I cast twice") is not pinned — it is
 * usually a verb there, and the model still sees the whole party. So "can a
 * bard heal?" and "Will the door open" pin nobody. A full name with any
 * uncommon word ("Will Turner") matches as usual.
 *
 * Names and messages compare as sequences of letter/digit words, so
 * punctuation inside a name is not significant: "C++ Wizard" also matches
 * "C Wizard", and "a.*b" matches "a b".
 */

/** Entities pinned for one message, in the order the message first names them. */
export const MAX_RESOLVED_REFERENCES = 6;
/** Other possible entities listed on an ambiguous reference. */
export const MAX_ALTERNATIVES = 3;

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
  /** Made only of everyday words ("will", "the bard"): characters need a name signal. */
  common: boolean;
}

/** Stored names are capped before any normalizing, so a huge one stays cheap. */
const bounded = (name: string) => name.slice(0, MAX_NAME_LENGTH);

function entitiesOf({ party, combatants = [] }: ResolveReferencesInput) {
  const characters = party.map((character): [Entity, string[]] => {
    const name = bounded(character.name);
    return [
      {
        kind: "character",
        id: character.id,
        name: clip(name, MAX_SHORT_FIELD_LENGTH),
        summary: () => describeCharacter(character),
      },
      [name],
    ];
  });
  const monsters = combatants.map((combatant): [Entity, string[]] => {
    const name = bounded(combatantName(combatant));
    return [
      {
        kind: "combatant",
        id: combatant.id,
        name: clip(name, MAX_SHORT_FIELD_LENGTH),
        summary: () => describeCombatant(summarizeCombatant(combatant)),
      },
      [name, bounded(combatant.monster.name)],
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
    const tokens = nameTokens(text);
    // A one-word name must itself be usable as a handle ("The" never matches).
    if (tokens.length === 0 || (tokens.length === 1 && !isUsableHandle(tokens[0]))) return;
    const key = tokens.join(" ");
    let phrase = phrases.get(key);
    if (!phrase) {
      phrase = { tokens, display, entities: [], common: isCommonWordPhrase(tokens) };
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

/** "Bard", not "bard" or "BARD" (an all-caps message says nothing about names). */
const isTitleCase = (text: string) => /^\p{Lu}/u.test(text) && text !== text.toUpperCase();

/**
 * Whether the words at [start, start + length) are marked as a name rather
 * than prose: followed by a possessive "'s", or containing a capitalized
 * common word that is mid-clause ("How is Bard doing"), or opening a clause
 * capitalized and directly addressed ("Bard, ..."). A capitalized word that
 * opens a sentence or follows a comma ("Will the door open", "Okay, Will it
 * hold") is no signal: there it is usually a verb, with or without a "?".
 */
function nameSignals(normalized: string, words: readonly NameWord[]) {
  const gapAfter = (k: number) => normalized.slice(words[k].end, words[k + 1]?.start ?? normalized.length);
  const opensClause = (k: number) => k === 0 || /[.!?:;,\n"“(]/.test(gapAfter(k - 1));
  const capitalized = (k: number) => isCommonWordName(words[k].token) && isTitleCase(words[k].text);

  return (start: number, length: number): boolean => {
    const last = start + length - 1;
    if (words[last + 1]?.token === "s" && /^['’]$/.test(gapAfter(last))) return true;
    if (capitalized(start) && opensClause(start) && /^\s*,/.test(gapAfter(last))) return true;
    for (let k = start; k <= last; k += 1) {
      if (capitalized(k) && !opensClause(k)) return true;
    }
    return false;
  };
}

/**
 * The party members and combatants `message` names, at most
 * MAX_RESOLVED_REFERENCES, in order of first mention. Words that name several
 * entities (two "Thorin"s, a "Goblin" and a "Goblin 2", a character and a
 * combatant sharing a name) return them all, marked ambiguous — unless
 * another, unambiguous mention in the same message singles one out. A
 * character named only with everyday words needs a name signal (see top).
 */
export function resolveReferences(message: string, input: ResolveReferencesInput): ResolvedReference[] {
  const index = indexPhrases(input);
  if (index.size === 0) return [];
  const { normalized, words } = nameWords(message.slice(0, MAX_USER_MESSAGE_LENGTH));
  const marksName = nameSignals(normalized, words);

  const resolved = new Map<string, ResolvedReference>();
  for (let i = 0; i < words.length; ) {
    let phrase: Phrase | undefined;
    let entities: Entity[] = [];
    for (const candidate of index.get(words[i].token) ?? []) {
      if (!candidate.tokens.every((token, offset) => words[i + offset]?.token === token)) continue;
      entities =
        candidate.common && !marksName(i, candidate.tokens.length)
          ? candidate.entities.filter((entity) => entity.kind === "combatant")
          : candidate.entities;
      if (entities.length > 0) {
        phrase = candidate;
        break;
      }
    }
    if (!phrase) {
      i += 1;
      continue;
    }
    i += phrase.tokens.length;

    const ambiguous = entities.length > 1;
    for (const entity of entities) {
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
        alternatives: entities
          .filter((other) => other !== entity)
          .slice(0, MAX_ALTERNATIVES)
          .map((other) => other.name),
      });
    }
  }
  return [...resolved.values()];
}
