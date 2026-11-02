import { useSyncExternalStore } from "react";

import type { MonsterStatBlock } from "@/lib/monsters/types";

/*
 * Remembers the last monster stat block the DM opened, so the chat assistant
 * can ground answers in it. A module-level store (survives client-side
 * navigation) mirrored to sessionStorage (survives a reload in the same tab).
 */

export const LAST_MONSTER_STORAGE_KEY = "dm-friend:last-monster";

let current: MonsterStatBlock | null | undefined;
const listeners = new Set<() => void>();

function storage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.sessionStorage;
  } catch {
    return undefined; // Storage can throw when disabled (e.g. privacy settings).
  }
}

function readStored(): MonsterStatBlock | null {
  try {
    const raw = storage()?.getItem(LAST_MONSTER_STORAGE_KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    // Our own data; a light shape check guards against stale/foreign values.
    const ok =
      typeof value === "object" &&
      value !== null &&
      typeof (value as MonsterStatBlock).name === "string" &&
      Array.isArray((value as MonsterStatBlock).actions);
    return ok ? (value as MonsterStatBlock) : null;
  } catch {
    return null;
  }
}

export function getLastViewedMonster(): MonsterStatBlock | null {
  if (current === undefined) current = readStored();
  return current;
}

/** Records (or with null, forgets) the last-viewed monster. */
export function setLastViewedMonster(monster: MonsterStatBlock | null): void {
  current = monster;
  try {
    if (monster) storage()?.setItem(LAST_MONSTER_STORAGE_KEY, JSON.stringify(monster));
    else storage()?.removeItem(LAST_MONSTER_STORAGE_KEY);
  } catch {
    // Quota or disabled storage: the in-memory value still works this session.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The last-viewed monster; re-renders when it changes. Null during SSR. */
export function useLastViewedMonster(): MonsterStatBlock | null {
  return useSyncExternalStore(subscribe, getLastViewedMonster, () => null);
}
