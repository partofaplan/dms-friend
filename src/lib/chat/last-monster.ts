import { useCallback, useSyncExternalStore } from "react";

import { monsterStatBlockSchema, type MonsterStatBlock } from "@/lib/monsters/types";

/*
 * Remembers the last monster stat block the DM opened, per party profile, so
 * the chat assistant can ground answers in it without one campaign's monster
 * leaking into another's. A module-level store (survives client-side
 * navigation) mirrored to sessionStorage (survives a reload in the same tab),
 * one slot per party.
 */

/** Prefix of every party's slot; see lastMonsterStorageKey. */
export const LAST_MONSTER_STORAGE_KEY = "dm-friend:last-monster";

export function lastMonsterStorageKey(partyProfileId: string): string {
  return `${LAST_MONSTER_STORAGE_KEY}:${partyProfileId}`;
}

const current = new Map<string, MonsterStatBlock | null>();
const listeners = new Set<() => void>();

function storage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.sessionStorage;
  } catch {
    return undefined; // Storage can throw when disabled (e.g. privacy settings).
  }
}

function readStored(partyProfileId: string): MonsterStatBlock | null {
  try {
    const raw = storage()?.getItem(lastMonsterStorageKey(partyProfileId));
    if (!raw) return null;
    // Storage is user-editable and can be stale: anything that isn't a
    // complete stat block counts as no monster, so it can't break the chat.
    const result = monsterStatBlockSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** The party's last-viewed monster, or null. */
export function getLastViewedMonster(partyProfileId: string): MonsterStatBlock | null {
  if (!current.has(partyProfileId)) current.set(partyProfileId, readStored(partyProfileId));
  return current.get(partyProfileId) ?? null;
}

/**
 * Records (or with null, forgets) the party's last-viewed monster. A value
 * that isn't a complete stat block is treated as null.
 */
export function setLastViewedMonster(
  partyProfileId: string,
  monster: MonsterStatBlock | null,
): void {
  if (monster && !monsterStatBlockSchema.safeParse(monster).success) monster = null;
  current.set(partyProfileId, monster);
  try {
    const key = lastMonsterStorageKey(partyProfileId);
    if (monster) storage()?.setItem(key, JSON.stringify(monster));
    else storage()?.removeItem(key);
  } catch {
    // Quota or disabled storage: the in-memory value still works this session.
  }
  for (const listener of listeners) listener();
}

/** Forgets every party's monster in memory (storage is left alone). For tests. */
export function resetLastViewedMonsters(): void {
  current.clear();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The party's last-viewed monster; re-renders when it changes. Null during
 * SSR or without a party.
 */
export function useLastViewedMonster(partyProfileId: string | null): MonsterStatBlock | null {
  const read = useCallback(
    () => (partyProfileId ? getLastViewedMonster(partyProfileId) : null),
    [partyProfileId],
  );
  return useSyncExternalStore(subscribe, read, () => null);
}
