import "server-only";

import { TtlCache } from "./ttl-cache";
import {
  normalizeMonster,
  normalizeMonsterSummary,
  type MonsterStatBlock,
  type MonsterSummary,
} from "./types";

/*
 * Server-side Open5e client for /api/monsters. Responses are normalized to our
 * trimmed shapes and cached in memory so repeated lookups during a session
 * don't re-hit Open5e. Only successful lookups are cached (including empty
 * search results); failures are not.
 */

export const OPEN5E_BASE_URL = "https://api.open5e.com/v1/monsters/";
/** Restrict results to the 5e System Reference Document. */
export const OPEN5E_DOCUMENT = "wotc-srd";
export const SEARCH_RESULT_LIMIT = 25;
export const UPSTREAM_TIMEOUT_MS = 8_000;
export const CACHE_TTL_MS = 5 * 60_000;
export const CACHE_MAX_ENTRIES = 200;
/**
 * Upstream body cap. A single SRD monster or a 25-result search page is a few
 * tens of KB; anything past this is treated as an upstream failure.
 */
export const MAX_UPSTREAM_BYTES = 2 * 1024 * 1024;

export type Open5eErrorKind = "not_found" | "upstream_error" | "timeout";

export class Open5eError extends Error {
  constructor(
    readonly kind: Open5eErrorKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "Open5eError";
  }
}

type CachedValue = MonsterSummary[] | MonsterStatBlock;

/** Shared across requests in this server process. Exported for tests. */
export const monsterCache = new TtlCache<CachedValue>({
  ttlMs: CACHE_TTL_MS,
  maxEntries: CACHE_MAX_ENTRIES,
});

/**
 * Reads and parses a JSON response body, never buffering more than
 * MAX_UPSTREAM_BYTES. A declared Content-Length over the cap is rejected before
 * reading; otherwise bytes are counted as they arrive and the stream is
 * cancelled as soon as the cap is crossed.
 */
async function readJsonWithLimit(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_UPSTREAM_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Open5eError("upstream_error", "Open5e response exceeds the size limit");
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_UPSTREAM_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Open5eError("upstream_error", "Open5e response exceeds the size limit");
      }
      chunks.push(value);
    }
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
        cache: "no-store",
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Open5eError("timeout", "Open5e request timed out", { cause: error });
      }
      throw new Open5eError("upstream_error", "Open5e request failed", { cause: error });
    }
    if (response.status === 404) throw new Open5eError("not_found", "Open5e returned 404");
    if (!response.ok) {
      throw new Open5eError("upstream_error", `Open5e returned ${response.status}`);
    }
    try {
      return await readJsonWithLimit(response);
    } catch (error) {
      if (error instanceof Open5eError) throw error;
      if (controller.signal.aborted) {
        throw new Open5eError("timeout", "Open5e response timed out", { cause: error });
      }
      throw new Open5eError("upstream_error", "Open5e returned invalid JSON", { cause: error });
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Case/whitespace-insensitive search key, so "Goblin " and "goblin" share a cache entry. */
function normalizeSearch(query: string): string {
  return query.trim().replace(/\s+/g, " ").toLowerCase();
}

export async function searchMonsters(query: string): Promise<MonsterSummary[]> {
  const search = normalizeSearch(query);
  const key = `search:${search}`;
  const cached = monsterCache.get(key);
  if (cached) return cached as MonsterSummary[];

  const params = new URLSearchParams({
    search,
    document__slug: OPEN5E_DOCUMENT,
    limit: String(SEARCH_RESULT_LIMIT),
  });
  const body = await fetchJson(`${OPEN5E_BASE_URL}?${params}`);
  const results = (body as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) {
    throw new Open5eError("upstream_error", "Open5e search response has no results array");
  }
  const summaries: MonsterSummary[] = [];
  for (const raw of results) {
    if (summaries.length >= SEARCH_RESULT_LIMIT) break;
    const summary = normalizeMonsterSummary(raw);
    if (summary) summaries.push(summary);
  }
  monsterCache.set(key, summaries);
  return summaries;
}

export async function getMonster(slug: string): Promise<MonsterStatBlock> {
  const key = `slug:${slug}`;
  const cached = monsterCache.get(key);
  if (cached) return cached as MonsterStatBlock;

  const body = await fetchJson(`${OPEN5E_BASE_URL}${encodeURIComponent(slug)}/`);
  const monster = normalizeMonster(body);
  if (!monster) {
    throw new Open5eError("upstream_error", "Open5e monster response is malformed");
  }
  monsterCache.set(key, monster);
  return monster;
}
