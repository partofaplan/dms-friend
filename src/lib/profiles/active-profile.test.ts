import { act, renderHook, waitFor } from "@testing-library/react";

import { DEFAULT_PARTY_NAME, DEFAULT_USER_NAME, RecordNotFoundError, type DexieRepository } from "@/lib/db";
import { createTestRepository } from "@/test-utils/repository";

import {
  ACTIVE_PROFILE_STORAGE_KEY,
  activePartyScope,
  getActiveProfileIds,
  refreshActiveProfile,
  resetActiveProfileStore,
  resolveActiveProfile,
  setActiveParty,
  setActiveUser,
  useActiveParty,
  useActiveProfile,
  useActiveUser,
} from "./active-profile";

let repo: DexieRepository;

beforeEach(() => {
  repo = createTestRepository();
});

afterEach(() => {
  repo.db.close();
});

function stored() {
  return JSON.parse(localStorage.getItem(ACTIVE_PROFILE_STORAGE_KEY) ?? "null");
}

/** Zach with "Strahd" and "Waterdeep"; Ana with "Tomb". */
async function seedProfiles() {
  const zach = await repo.users.create("Zach");
  const strahd = await repo.partyProfiles.create(zach.id, "Strahd");
  const waterdeep = await repo.partyProfiles.create(zach.id, "Waterdeep");
  const ana = await repo.users.create("Ana");
  const tomb = await repo.partyProfiles.create(ana.id, "Tomb");
  return { zach, strahd, waterdeep, ana, tomb };
}

describe("active profile store", () => {
  it("creates and activates the default profile on first use", async () => {
    expect(getActiveProfileIds()).toBeNull();
    const { user, partyProfile } = await resolveActiveProfile(repo);

    expect(user.name).toBe(DEFAULT_USER_NAME);
    expect(partyProfile).toMatchObject({ name: DEFAULT_PARTY_NAME, userId: user.id });
    expect(getActiveProfileIds()).toEqual({ userId: user.id, partyProfileId: partyProfile.id });
    expect(stored().active).toEqual({ userId: user.id, partyProfileId: partyProfile.id });

    // Idempotent: nothing new is created.
    await resolveActiveProfile(repo);
    expect(await repo.users.getAll()).toHaveLength(1);
  });

  it("heals concurrent first uses into a single default profile", async () => {
    const [first, second, scope] = await Promise.all([
      resolveActiveProfile(repo),
      resolveActiveProfile(repo),
      activePartyScope(repo),
    ]);
    expect(second.partyProfile.id).toBe(first.partyProfile.id);
    expect(scope.partyProfileId).toBe(first.partyProfile.id);
    expect(await repo.users.getAll()).toHaveLength(1);
  });

  it("restores the persisted selection after a reload", async () => {
    const { ana, tomb } = await seedProfiles();
    await setActiveParty(tomb.id, repo);

    // A reload: fresh modules read the same storage.
    vi.resetModules();
    const fresh = await import("./active-profile");
    expect(fresh.getActiveProfileIds()).toEqual({ userId: ana.id, partyProfileId: tomb.id });
    expect(stored().lastPartyByUser).toEqual({ [ana.id]: tomb.id });
    expect((await resolveActiveProfile(repo)).partyProfile.id).toBe(tomb.id);
  });

  it("ignores malformed storage", async () => {
    localStorage.setItem(ACTIVE_PROFILE_STORAGE_KEY, "{not json");
    expect(getActiveProfileIds()).toBeNull();
    resetActiveProfileStore();
    localStorage.setItem(ACTIVE_PROFILE_STORAGE_KEY, JSON.stringify({ active: 42 }));
    expect(getActiveProfileIds()).toBeNull();
  });

  it("self-heals when the stored ids point at deleted profiles", async () => {
    const { zach, strahd, waterdeep } = await seedProfiles();
    await setActiveParty(strahd.id, repo);

    // Party gone: another of the same user's parties.
    await repo.partyProfiles.delete(strahd.id);
    expect(await resolveActiveProfile(repo)).toMatchObject({
      user: { id: zach.id },
      partyProfile: { id: waterdeep.id },
    });

    // The user's last party gone: a new one is made for that user.
    await repo.partyProfiles.delete(waterdeep.id);
    const healed = await resolveActiveProfile(repo);
    expect(healed.user.id).toBe(zach.id);
    expect(healed.partyProfile).toMatchObject({ userId: zach.id, name: DEFAULT_PARTY_NAME });

    // User gone: the oldest remaining user (Ana) via ensureDefaultProfile.
    await repo.users.delete(zach.id);
    const other = await resolveActiveProfile(repo);
    expect(other.user.name).toBe("Ana");
    expect(other.partyProfile.name).toBe("Tomb");
  });

  it("follows a stored party to its real owner when the ids disagree", async () => {
    const { zach, tomb, ana } = await seedProfiles();
    localStorage.setItem(
      ACTIVE_PROFILE_STORAGE_KEY,
      JSON.stringify({ active: { userId: zach.id, partyProfileId: tomb.id }, lastPartyByUser: {} }),
    );
    expect((await resolveActiveProfile(repo)).user.id).toBe(ana.id);
  });

  it("setActiveUser switches to that user's last active party, else their first", async () => {
    const { zach, waterdeep, ana, tomb } = await seedProfiles();
    // First visit: the first party by name.
    expect((await setActiveUser(zach.id, repo)).partyProfile.name).toBe("Strahd");

    await setActiveParty(waterdeep.id, repo);
    await setActiveUser(ana.id, repo);
    expect(getActiveProfileIds()).toEqual({ userId: ana.id, partyProfileId: tomb.id });

    // Back to Zach: remembered.
    expect((await setActiveUser(zach.id, repo)).partyProfile.id).toBe(waterdeep.id);
  });

  it("setActiveUser gives a user with no parties a new one", async () => {
    const solo = await repo.users.create("Solo");
    const { partyProfile } = await setActiveUser(solo.id, repo);
    expect(partyProfile).toMatchObject({ userId: solo.id, name: DEFAULT_PARTY_NAME });
  });

  it("setActiveParty also activates the party's owner; unknown ids throw", async () => {
    const { ana, tomb } = await seedProfiles();
    await setActiveParty(tomb.id, repo);
    expect(getActiveProfileIds()).toEqual({ userId: ana.id, partyProfileId: tomb.id });

    await expect(setActiveParty("missing", repo)).rejects.toBeInstanceOf(RecordNotFoundError);
    await expect(setActiveUser("missing", repo)).rejects.toBeInstanceOf(RecordNotFoundError);
    expect(getActiveProfileIds()).toEqual({ userId: ana.id, partyProfileId: tomb.id });
  });

  it("refreshActiveProfile moves off a just-deleted active party or user", async () => {
    const { zach, strahd, waterdeep, ana } = await seedProfiles();
    await setActiveParty(strahd.id, repo);

    await repo.partyProfiles.delete(strahd.id);
    expect((await refreshActiveProfile(repo)).partyProfile.id).toBe(waterdeep.id);

    await repo.users.delete(zach.id);
    expect((await refreshActiveProfile(repo)).user.id).toBe(ana.id);
  });
});

describe("useActiveProfile", () => {
  it("is loading, then ready with the active records and a stable scope", async () => {
    const { result, rerender } = renderHook(() => useActiveProfile(repo));
    expect(result.current.status).toBe("loading");

    await waitFor(() => expect(result.current.status).toBe("ready"));
    const { user, partyProfile, scope } = result.current;
    expect(user?.name).toBe(DEFAULT_USER_NAME);
    expect(scope?.partyProfileId).toBe(partyProfile?.id);

    rerender();
    expect(result.current.scope).toBe(scope);
  });

  it("re-renders on a switch and on refresh (renames)", async () => {
    const { zach, strahd, tomb } = await seedProfiles();
    await setActiveParty(strahd.id, repo);
    const { result } = renderHook(() => ({
      profile: useActiveProfile(repo),
      user: useActiveUser(repo),
      party: useActiveParty(repo),
    }));
    await waitFor(() => expect(result.current.party?.partyProfile.name).toBe("Strahd"));
    expect(result.current.user?.id).toBe(zach.id);

    await act(() => setActiveParty(tomb.id, repo));
    await waitFor(() => expect(result.current.party?.partyProfile.name).toBe("Tomb"));
    expect(result.current.user?.name).toBe("Ana");
    expect(result.current.party?.scope.partyProfileId).toBe(tomb.id);

    await repo.partyProfiles.rename(tomb.id, "Tomb of Annihilation");
    await act(() => refreshActiveProfile(repo));
    await waitFor(() =>
      expect(result.current.profile.partyProfile?.name).toBe("Tomb of Annihilation"),
    );
  });

  it("reports an error when the profile can't be resolved", async () => {
    vi.spyOn(repo, "ensureDefaultProfile").mockRejectedValue(new Error("blocked"));
    const { result } = renderHook(() => useActiveProfile(repo));
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error).toBe("Could not load your profile.");
  });
});
