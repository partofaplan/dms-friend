import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { z } from "zod";

import {
  DEFAULT_PARTY_NAME,
  RecordNotFoundError,
  repository as defaultRepository,
  type AppRepository,
  type PartyProfile,
  type PartyScopedRepository,
  type UserProfile,
} from "@/lib/db";

/*
 * Which user profile and party profile the app is acting on. A module-level
 * store (shared by every screen, survives client-side navigation) mirrored to
 * localStorage (survives a reload or relaunch). The ids are only a hint:
 * resolveActiveProfile() checks them against the repository and self-heals
 * when they point at deleted profiles, so there is always a valid active
 * user + party once it has run. Client only; SSR sees "loading".
 */

export const ACTIVE_PROFILE_STORAGE_KEY = "dm-friend:active-profile";

export interface ActiveProfileIds {
  userId: string;
  partyProfileId: string;
}

interface StoreState {
  active: ActiveProfileIds | null;
  /** Each user's last active party, so switching back to a user returns to it. */
  lastPartyByUser: Readonly<Record<string, string>>;
  /** Bumped by refreshActiveProfile() so hooks re-read renamed records. */
  revision: number;
}

const storedSchema = z.object({
  active: z.object({ userId: z.string(), partyProfileId: z.string() }).nullable(),
  lastPartyByUser: z.record(z.string(), z.string()),
});

const EMPTY: StoreState = { active: null, lastPartyByUser: {}, revision: 0 };

let state: StoreState | undefined;
const listeners = new Set<() => void>();

function storage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined; // Storage can throw when disabled (e.g. privacy settings).
  }
}

function readStored(): StoreState {
  try {
    const raw = storage()?.getItem(ACTIVE_PROFILE_STORAGE_KEY);
    if (!raw) return EMPTY;
    // User-editable and possibly stale: anything malformed counts as unset.
    const result = storedSchema.safeParse(JSON.parse(raw));
    return result.success ? { ...result.data, revision: 0 } : EMPTY;
  } catch {
    return EMPTY;
  }
}

function getState(): StoreState {
  if (state === undefined) state = readStored();
  return state;
}

function getServerState(): StoreState {
  return EMPTY;
}

function writeState(next: StoreState): void {
  state = next;
  try {
    const { active, lastPartyByUser } = next;
    storage()?.setItem(ACTIVE_PROFILE_STORAGE_KEY, JSON.stringify({ active, lastPartyByUser }));
  } catch {
    // Quota or disabled storage: the in-memory value still works this session.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The stored active ids, unverified (may be null or point at deleted profiles). */
export function getActiveProfileIds(): ActiveProfileIds | null {
  return getState().active;
}

function activate(user: UserProfile, partyProfile: PartyProfile): void {
  const current = getState();
  if (
    current.active?.userId === user.id &&
    current.active.partyProfileId === partyProfile.id &&
    current.lastPartyByUser[user.id] === partyProfile.id
  ) {
    return;
  }
  writeState({
    ...current,
    active: { userId: user.id, partyProfileId: partyProfile.id },
    lastPartyByUser: { ...current.lastPartyByUser, [user.id]: partyProfile.id },
  });
}

/**
 * Every change to the active selection runs one at a time, so concurrent
 * callers (several screens mounting at once) never heal over each other.
 */
let queue: Promise<unknown> = Promise.resolve();
function exclusive<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

/** The user's remembered party, else their first by name, else a new "Default Party". */
async function partyFor(repo: AppRepository, userId: string): Promise<PartyProfile> {
  const parties = await repo.partyProfiles.listByUser(userId);
  const remembered = getState().lastPartyByUser[userId];
  return (
    parties.find((party) => party.id === remembered) ??
    parties[0] ??
    (await repo.partyProfiles.create(userId, DEFAULT_PARTY_NAME))
  );
}

export interface ResolvedProfile {
  user: UserProfile;
  partyProfile: PartyProfile;
}

/**
 * The active user + party, verified against `repo`. Self-heals stale ids: a
 * missing party falls back to another of the same user's parties (creating
 * one if they have none); a missing user to the oldest user via
 * ensureDefaultProfile (which creates the defaults on a fresh install).
 */
export function resolveActiveProfile(
  repo: AppRepository = defaultRepository,
): Promise<ResolvedProfile> {
  return exclusive(async () => {
    const ids = getState().active;
    let [user, partyProfile] = ids
      ? await Promise.all([
          repo.users.getById(ids.userId),
          repo.partyProfiles.getById(ids.partyProfileId),
        ])
      : [undefined, undefined];
    if (partyProfile && partyProfile.userId !== user?.id) {
      // The party is the more specific choice; follow it to its owner.
      user = await repo.users.getById(partyProfile.userId);
      if (!user) partyProfile = undefined;
    }
    if (user && !partyProfile) partyProfile = await partyFor(repo, user.id);
    if (!user || !partyProfile) ({ user, partyProfile } = await repo.ensureDefaultProfile());
    activate(user, partyProfile);
    return { user, partyProfile };
  });
}

/** The active party's scoped repository, resolving (and healing) the selection first. */
export async function activePartyScope(
  repo: AppRepository = defaultRepository,
): Promise<PartyScopedRepository> {
  const { partyProfile } = await resolveActiveProfile(repo);
  return repo.forParty(partyProfile.id);
}

/**
 * Makes `userId` active along with their last active party (else their first,
 * else a new one). Throws RecordNotFoundError if the user doesn't exist.
 */
export function setActiveUser(
  userId: string,
  repo: AppRepository = defaultRepository,
): Promise<ResolvedProfile> {
  return exclusive(async () => {
    const user = await repo.users.getById(userId);
    if (!user) throw new RecordNotFoundError("user profile", userId);
    const partyProfile = await partyFor(repo, user.id);
    activate(user, partyProfile);
    return { user, partyProfile };
  });
}

/**
 * Makes `partyProfileId` active, along with the user who owns it. Throws
 * RecordNotFoundError if the party profile doesn't exist.
 */
export function setActiveParty(
  partyProfileId: string,
  repo: AppRepository = defaultRepository,
): Promise<ResolvedProfile> {
  return exclusive(async () => {
    const partyProfile = await repo.partyProfiles.getById(partyProfileId);
    if (!partyProfile) throw new RecordNotFoundError("party profile", partyProfileId);
    const user = await repo.users.getById(partyProfile.userId);
    if (!user) throw new RecordNotFoundError("user profile", partyProfile.userId);
    activate(user, partyProfile);
    return { user, partyProfile };
  });
}

/**
 * Re-reads the active profile in every mounted hook — call after creating,
 * renaming or deleting profiles. Resolves once the selection is healed (e.g.
 * moved off a party or user that was just deleted).
 */
export async function refreshActiveProfile(
  repo: AppRepository = defaultRepository,
): Promise<ResolvedProfile> {
  const resolved = await resolveActiveProfile(repo);
  const current = getState();
  writeState({ ...current, revision: current.revision + 1 });
  return resolved;
}

/** Forgets the active selection (in memory and in storage). For tests. */
export function resetActiveProfileStore(): void {
  state = undefined;
  try {
    storage()?.removeItem(ACTIVE_PROFILE_STORAGE_KEY);
  } catch {
    // Nothing stored.
  }
  for (const listener of listeners) listener();
}

export type ActiveProfile =
  | { status: "loading"; user: null; partyProfile: null; scope: null; error: null }
  | {
      status: "ready";
      user: UserProfile;
      partyProfile: PartyProfile;
      /** The active party's characters, stable and chat. Stable across renders. */
      scope: PartyScopedRepository;
      error: null;
    }
  | { status: "error"; user: null; partyProfile: null; scope: null; error: string };

const LOADING: ActiveProfile = {
  status: "loading",
  user: null,
  partyProfile: null,
  scope: null,
  error: null,
};

type Resolution = { repo: AppRepository } & (
  | { profile: ResolvedProfile; error: null }
  | { profile: null; error: string }
);

/** The stored active ids, without touching the repository; null during SSR. */
export function useActiveProfileIds(): ActiveProfileIds | null {
  return useSyncExternalStore(subscribe, getState, getServerState).active;
}

/**
 * The active user + party (resolved and healed against `repo`), re-rendering
 * whenever the selection changes or is refreshed. "loading" until resolved,
 * and again briefly while switching.
 */
export function useActiveProfile(repo: AppRepository = defaultRepository): ActiveProfile {
  const current = useSyncExternalStore(subscribe, getState, getServerState);
  const [resolution, setResolution] = useState<Resolution | null>(null);

  useEffect(() => {
    let cancelled = false;
    resolveActiveProfile(repo).then(
      (profile) => {
        if (!cancelled) setResolution({ repo, profile, error: null });
      },
      () => {
        if (!cancelled) setResolution({ repo, profile: null, error: "Could not load your profile." });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [repo, current]);

  const profile =
    resolution?.repo === repo &&
    resolution.profile?.partyProfile.id === current.active?.partyProfileId
      ? resolution.profile
      : null;
  const partyId = profile?.partyProfile.id ?? null;
  const scope = useMemo(() => (partyId ? repo.forParty(partyId) : null), [repo, partyId]);

  if (resolution?.repo === repo && resolution.error !== null) {
    return { status: "error", user: null, partyProfile: null, scope: null, error: resolution.error };
  }
  if (!profile || !scope) return LOADING;
  return { status: "ready", user: profile.user, partyProfile: profile.partyProfile, scope, error: null };
}

/** The active user profile, or null until resolved. */
export function useActiveUser(repo: AppRepository = defaultRepository): UserProfile | null {
  return useActiveProfile(repo).user;
}

/** The active party profile with its scoped repository, or null until resolved. */
export function useActiveParty(
  repo: AppRepository = defaultRepository,
): { partyProfile: PartyProfile; scope: PartyScopedRepository } | null {
  const { partyProfile, scope } = useActiveProfile(repo);
  return partyProfile && scope ? { partyProfile, scope } : null;
}
