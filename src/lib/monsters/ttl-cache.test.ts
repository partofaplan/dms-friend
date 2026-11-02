import { TtlCache } from "./ttl-cache";

function makeCache(maxEntries = 3, ttlMs = 1_000) {
  let now = 0;
  const cache = new TtlCache<string>({ ttlMs, maxEntries, now: () => now });
  return { cache, advance: (ms: number) => (now += ms) };
}

describe("TtlCache", () => {
  it("returns values until they expire, then drops them", () => {
    const { cache, advance } = makeCache();
    cache.set("a", "A");
    advance(999);
    expect(cache.get("a")).toBe("A");
    advance(1);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("evicts the least-recently-used entry past the size cap", () => {
    const { cache } = makeCache(3);
    cache.set("a", "A");
    cache.set("b", "B");
    cache.set("c", "C");
    cache.get("a"); // a is now most recent; b is oldest
    cache.set("d", "D");
    expect(cache.size).toBe(3);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe("A");
    expect(cache.get("c")).toBe("C");
    expect(cache.get("d")).toBe("D");
  });

  it("overwriting a key refreshes its TTL without growing", () => {
    const { cache, advance } = makeCache(2);
    cache.set("a", "A1");
    advance(800);
    cache.set("a", "A2");
    advance(800);
    expect(cache.get("a")).toBe("A2");
    expect(cache.size).toBe(1);
  });

  it("never grows past the cap", () => {
    const { cache } = makeCache(5);
    for (let i = 0; i < 50; i += 1) cache.set(`k${i}`, String(i));
    expect(cache.size).toBe(5);
    expect(cache.get("k49")).toBe("49");
    expect(cache.get("k44")).toBeUndefined();
  });
});
