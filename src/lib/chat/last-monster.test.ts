import { act, cleanup, renderHook } from "@testing-library/react";

import { normalizeMonster } from "@/lib/monsters/types";
import { goblinRaw, guardianRaw } from "@/test-utils/open5e-fixtures";

import {
  getLastViewedMonster,
  LAST_MONSTER_STORAGE_KEY,
  setLastViewedMonster,
  useLastViewedMonster,
} from "./last-monster";

const goblin = normalizeMonster(goblinRaw)!;
const guardian = normalizeMonster(guardianRaw)!;

afterEach(() => {
  cleanup();
  setLastViewedMonster(null);
});

describe("last-viewed monster store", () => {
  it("starts empty, records the latest monster, and mirrors it to sessionStorage", () => {
    expect(getLastViewedMonster()).toBeNull();
    setLastViewedMonster(goblin);
    expect(getLastViewedMonster()).toBe(goblin);
    expect(JSON.parse(sessionStorage.getItem(LAST_MONSTER_STORAGE_KEY)!)).toEqual(goblin);

    setLastViewedMonster(null);
    expect(sessionStorage.getItem(LAST_MONSTER_STORAGE_KEY)).toBeNull();
  });

  it("restores a stored monster on first read, ignoring corrupt values", async () => {
    sessionStorage.setItem(LAST_MONSTER_STORAGE_KEY, JSON.stringify(goblin));
    vi.resetModules();
    expect((await import("./last-monster")).getLastViewedMonster()?.name).toBe("Goblin");

    sessionStorage.setItem(LAST_MONSTER_STORAGE_KEY, "{not json");
    vi.resetModules();
    expect((await import("./last-monster")).getLastViewedMonster()).toBeNull();
    sessionStorage.clear();
  });

  it("discards a stored value that is not a complete stat block", async () => {
    sessionStorage.setItem(
      LAST_MONSTER_STORAGE_KEY,
      JSON.stringify({ name: "Goblin", actions: [] }),
    );
    vi.resetModules();
    expect((await import("./last-monster")).getLastViewedMonster()).toBeNull();

    sessionStorage.setItem(
      LAST_MONSTER_STORAGE_KEY,
      JSON.stringify({ ...goblin, speed: undefined }),
    );
    vi.resetModules();
    expect((await import("./last-monster")).getLastViewedMonster()).toBeNull();
    sessionStorage.clear();
  });

  it("treats setting an incomplete stat block as forgetting the monster", () => {
    setLastViewedMonster(goblin);
    setLastViewedMonster({ name: "Goblin", actions: [] } as unknown as typeof goblin);
    expect(getLastViewedMonster()).toBeNull();
    expect(sessionStorage.getItem(LAST_MONSTER_STORAGE_KEY)).toBeNull();
  });

  it("re-renders subscribers when the monster changes", () => {
    const { result } = renderHook(() => useLastViewedMonster());
    expect(result.current).toBeNull();
    act(() => setLastViewedMonster(goblin));
    expect(result.current?.name).toBe("Goblin");
    act(() => setLastViewedMonster(guardian));
    expect(result.current?.name).toBe(guardian.name);
  });
});
