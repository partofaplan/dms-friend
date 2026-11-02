import { act, cleanup, renderHook } from "@testing-library/react";

import { normalizeMonster } from "@/lib/monsters/types";
import { goblinRaw, guardianRaw } from "@/test-utils/open5e-fixtures";

import {
  getLastViewedMonster,
  lastMonsterStorageKey,
  setLastViewedMonster,
  useLastViewedMonster,
} from "./last-monster";

const goblin = normalizeMonster(goblinRaw)!;
const guardian = normalizeMonster(guardianRaw)!;

const PARTY_A = "party-a";
const PARTY_B = "party-b";

afterEach(() => {
  cleanup();
  setLastViewedMonster(PARTY_A, null);
  setLastViewedMonster(PARTY_B, null);
});

describe("last-viewed monster store", () => {
  it("starts empty, records the latest monster, and mirrors it to sessionStorage", () => {
    expect(getLastViewedMonster(PARTY_A)).toBeNull();
    setLastViewedMonster(PARTY_A, goblin);
    expect(getLastViewedMonster(PARTY_A)).toBe(goblin);
    expect(JSON.parse(sessionStorage.getItem(lastMonsterStorageKey(PARTY_A))!)).toEqual(goblin);

    setLastViewedMonster(PARTY_A, null);
    expect(sessionStorage.getItem(lastMonsterStorageKey(PARTY_A))).toBeNull();
  });

  it("keeps one monster per party", () => {
    setLastViewedMonster(PARTY_A, goblin);
    expect(getLastViewedMonster(PARTY_B)).toBeNull();

    setLastViewedMonster(PARTY_B, guardian);
    expect(getLastViewedMonster(PARTY_A)).toBe(goblin);
    expect(getLastViewedMonster(PARTY_B)).toBe(guardian);
    expect(lastMonsterStorageKey(PARTY_A)).not.toBe(lastMonsterStorageKey(PARTY_B));
  });

  it("restores a stored monster on first read, ignoring corrupt values", async () => {
    sessionStorage.setItem(lastMonsterStorageKey(PARTY_A), JSON.stringify(goblin));
    vi.resetModules();
    expect((await import("./last-monster")).getLastViewedMonster(PARTY_A)?.name).toBe("Goblin");

    sessionStorage.setItem(lastMonsterStorageKey(PARTY_A), "{not json");
    vi.resetModules();
    expect((await import("./last-monster")).getLastViewedMonster(PARTY_A)).toBeNull();
    sessionStorage.clear();
  });

  it("discards a stored value that is not a complete stat block", async () => {
    sessionStorage.setItem(
      lastMonsterStorageKey(PARTY_A),
      JSON.stringify({ name: "Goblin", actions: [] }),
    );
    vi.resetModules();
    expect((await import("./last-monster")).getLastViewedMonster(PARTY_A)).toBeNull();

    sessionStorage.setItem(
      lastMonsterStorageKey(PARTY_A),
      JSON.stringify({ ...goblin, speed: undefined }),
    );
    vi.resetModules();
    expect((await import("./last-monster")).getLastViewedMonster(PARTY_A)).toBeNull();
    sessionStorage.clear();
  });

  it("treats setting an incomplete stat block as forgetting the monster", () => {
    setLastViewedMonster(PARTY_A, goblin);
    setLastViewedMonster(PARTY_A, { name: "Goblin", actions: [] } as unknown as typeof goblin);
    expect(getLastViewedMonster(PARTY_A)).toBeNull();
    expect(sessionStorage.getItem(lastMonsterStorageKey(PARTY_A))).toBeNull();
  });

  it("re-renders subscribers when the party's monster changes, and follows the party", () => {
    const { result, rerender } = renderHook(
      ({ party }: { party: string | null }) => useLastViewedMonster(party),
      { initialProps: { party: PARTY_A as string | null } },
    );
    expect(result.current).toBeNull();
    act(() => setLastViewedMonster(PARTY_A, goblin));
    expect(result.current?.name).toBe("Goblin");
    act(() => setLastViewedMonster(PARTY_A, guardian));
    expect(result.current?.name).toBe(guardian.name);

    rerender({ party: PARTY_B });
    expect(result.current).toBeNull();
    rerender({ party: null });
    expect(result.current).toBeNull();
  });
});
