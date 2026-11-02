// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CACHE_MAX_ENTRIES,
  CACHE_TTL_MS,
  monsterCache,
  OPEN5E_BASE_URL,
  UPSTREAM_TIMEOUT_MS,
} from "@/lib/monsters/open5e";
import type {
  MonsterDetailResponseBody,
  MonsterErrorResponseBody,
  MonsterSearchResponseBody,
} from "@/lib/monsters/types";
import { goblinRaw, guardianRaw, searchPayload } from "@/test-utils/open5e-fixtures";

import { GET } from "./route";

let upstream: ReturnType<typeof vi.fn<typeof fetch>>;

function get(query: string): Promise<Response> {
  return GET(new Request(`http://localhost/api/monsters${query}`));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function upstreamUrl(call = 0): URL {
  return new URL(String(upstream.mock.calls[call][0]));
}

beforeEach(() => {
  monsterCache.clear();
  upstream = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", upstream);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GET /api/monsters?search=", () => {
  it("returns trimmed summaries", async () => {
    upstream.mockResolvedValue(json(searchPayload([goblinRaw, guardianRaw])));

    const response = await get("?search=gob");

    expect(response.status).toBe(200);
    const body = (await response.json()) as MonsterSearchResponseBody;
    expect(body).toEqual({
      results: [
        { slug: "goblin", name: "Goblin", size: "Small", type: "humanoid", cr: 0.25, challengeRating: "1/4" },
        {
          slug: "vault-guardian",
          name: "Vault Guardian",
          size: "Large",
          type: "construct",
          cr: 11,
          challengeRating: "11",
        },
      ],
    });
    expect(response.headers.get("Cache-Control")).toMatch(/s-maxage=\d+/);
  });

  it("URL-encodes the upstream query and restricts it to the SRD", async () => {
    upstream.mockResolvedValue(json(searchPayload([])));

    await get(`?search=${encodeURIComponent("Ogre & Co?/x")}`);

    const url = upstreamUrl();
    expect(`${url.origin}${url.pathname}`).toBe(OPEN5E_BASE_URL);
    expect(url.searchParams.get("search")).toBe("ogre & co?/x");
    expect(url.searchParams.get("document__slug")).toBe("wotc-srd");
    expect(url.search).not.toContain("&co?");
  });

  it("returns an empty list (not an error) when nothing matches", async () => {
    upstream.mockResolvedValue(json(searchPayload([])));

    const response = await get("?search=zzzz");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ results: [] });
  });

  it("drops upstream entries without a slug or name", async () => {
    upstream.mockResolvedValue(json(searchPayload([goblinRaw, { name: "No slug" }, null])));

    const body = (await (await get("?search=g")).json()) as MonsterSearchResponseBody;

    expect(body.results.map((m) => m.slug)).toEqual(["goblin"]);
  });
});

describe("GET /api/monsters?slug=", () => {
  it("returns the mapped stat block", async () => {
    upstream.mockResolvedValue(json(guardianRaw));

    const response = await get("?slug=vault-guardian");

    expect(response.status).toBe(200);
    expect(upstreamUrl().href).toBe(`${OPEN5E_BASE_URL}vault-guardian/`);
    const { monster } = (await response.json()) as MonsterDetailResponseBody;
    expect(monster).toMatchObject({
      slug: "vault-guardian",
      armorClass: 18,
      hitPoints: 178,
      challengeRating: "11",
      abilities: { strength: 23, charisma: 1 },
      savingThrows: [
        { name: "STR", bonus: 11 },
        { name: "CON", bonus: 10 },
        { name: "WIS", bonus: 5 },
      ],
    });
    expect(monster.legendaryActions).toHaveLength(2);
    expect(monster).not.toHaveProperty("document__slug");
  });

  it("maps an upstream 404 to 404", async () => {
    upstream.mockResolvedValue(json({ detail: "Not found." }, 404));

    const response = await get("?slug=nope");

    expect(response.status).toBe(404);
    expect(((await response.json()) as MonsterErrorResponseBody).error.kind).toBe("not_found");
  });
});

describe("GET /api/monsters validation", () => {
  it.each(["", "?search=", "?search=%20%20", "?slug=", "?search=a&slug=b", "?slug=..%2Fadmin"])(
    "rejects %s with 400",
    async (query) => {
      const response = await get(query);
      expect(response.status).toBe(400);
      expect(((await response.json()) as MonsterErrorResponseBody).error.kind).toBe("bad_request");
      expect(upstream).not.toHaveBeenCalled();
    },
  );
});

describe("GET /api/monsters upstream failures", () => {
  it("maps upstream non-OK to 502 without leaking detail", async () => {
    upstream.mockResolvedValue(new Response("Internal stack trace at db.py:42", { status: 500 }));

    const response = await get("?search=goblin");

    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).not.toContain("stack trace");
    expect(JSON.parse(text)).toEqual({
      error: { kind: "upstream_error", message: expect.any(String) },
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("maps a network failure to 502", async () => {
    upstream.mockRejectedValue(new TypeError("fetch failed: ECONNREFUSED 10.0.0.1"));

    const response = await get("?slug=goblin");

    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("ECONNREFUSED");
  });

  it("maps an upstream payload without results to 502", async () => {
    upstream.mockResolvedValue(json({ unexpected: true }));
    expect((await get("?search=goblin")).status).toBe(502);
  });

  it("maps a timeout to 504", async () => {
    vi.useFakeTimers();
    upstream.mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError")),
          );
        }),
    );

    const pending = get("?search=goblin");
    await vi.advanceTimersByTimeAsync(UPSTREAM_TIMEOUT_MS);
    const response = await pending;

    expect(response.status).toBe(504);
    expect(((await response.json()) as MonsterErrorResponseBody).error.kind).toBe("timeout");
  });

  it("does not cache failures", async () => {
    upstream.mockResolvedValueOnce(new Response("", { status: 503 }));
    upstream.mockResolvedValueOnce(json(searchPayload([goblinRaw])));

    expect((await get("?search=goblin")).status).toBe(502);
    expect((await get("?search=goblin")).status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(2);
  });
});

describe("GET /api/monsters caching", () => {
  it("serves a repeat search from memory", async () => {
    upstream.mockImplementation(async () => json(searchPayload([goblinRaw])));

    const first = await (await get("?search=goblin")).json();
    const second = await (await get("?search=%20GOBLIN%20")).json();

    expect(second).toEqual(first);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("serves a repeat slug lookup from memory", async () => {
    upstream.mockImplementation(async () => json(goblinRaw));

    await get("?slug=goblin");
    await get("?slug=goblin");

    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("caches empty results too", async () => {
    upstream.mockImplementation(async () => json(searchPayload([])));

    await get("?search=zzz");
    await get("?search=zzz");

    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("refetches after the TTL expires", async () => {
    vi.useFakeTimers();
    upstream.mockImplementation(async () => json(searchPayload([goblinRaw])));

    await get("?search=goblin");
    vi.advanceTimersByTime(CACHE_TTL_MS - 1);
    await get("?search=goblin");
    expect(upstream).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    await get("?search=goblin");
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("caps the cache size, evicting the oldest lookup", async () => {
    upstream.mockImplementation(async () => json(searchPayload([])));

    for (let i = 0; i <= CACHE_MAX_ENTRIES; i += 1) await get(`?search=q${i}`);

    expect(monsterCache.size).toBe(CACHE_MAX_ENTRIES);
    upstream.mockClear();
    await get(`?search=q${CACHE_MAX_ENTRIES}`);
    expect(upstream).not.toHaveBeenCalled();
    await get("?search=q0");
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});
