import {
  MONSTER_ERROR_KINDS,
  type MonsterDetailResponseBody,
  type MonsterErrorKind,
  type MonsterErrorResponseBody,
  type MonsterSearchResponseBody,
  type MonsterStatBlock,
  type MonsterSummary,
} from "./types";

/*
 * Browser-side calls to GET /api/monsters. Failures are reduced to a kind plus
 * a fixed, friendly message; server message text is never shown verbatim.
 */

export const MONSTERS_ENDPOINT = "/api/monsters";

export type MonsterLookupErrorKind = MonsterErrorKind | "network" | "invalid_response";

export const MONSTER_LOOKUP_MESSAGES: Record<MonsterLookupErrorKind, string> = {
  bad_request: "Enter a monster name to search.",
  not_found: "That monster couldn't be found.",
  upstream_error: "The monster database is unavailable right now. Try again shortly.",
  timeout: "The monster database took too long to respond. Try again.",
  invalid_response: "The monster data came back garbled. Try again.",
  network: "Couldn't reach the server. Check your connection and try again.",
};

export type LookupResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: MonsterLookupErrorKind; message: string };

type FetchOptions = { signal?: AbortSignal; fetchImpl?: typeof fetch };

function failure(kind: MonsterLookupErrorKind): { ok: false; kind: MonsterLookupErrorKind; message: string } {
  return { ok: false, kind, message: MONSTER_LOOKUP_MESSAGES[kind] };
}

function kindFromStatus(status: number): MonsterErrorKind {
  if (status === 400) return "bad_request";
  if (status === 404) return "not_found";
  if (status === 504) return "timeout";
  return "upstream_error";
}

async function getJson<T>(
  params: URLSearchParams,
  pick: (json: unknown) => T | undefined,
  { signal, fetchImpl = fetch }: FetchOptions,
): Promise<LookupResult<T>> {
  let response: Response;
  try {
    response = await fetchImpl(`${MONSTERS_ENDPOINT}?${params}`, { signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    return failure("network");
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch (error) {
    if (signal?.aborted) throw error;
    json = undefined;
  }
  if (!response.ok) {
    const kind = (json as Partial<MonsterErrorResponseBody> | undefined)?.error?.kind;
    const known = (MONSTER_ERROR_KINDS as readonly unknown[]).includes(kind);
    return failure(known ? (kind as MonsterErrorKind) : kindFromStatus(response.status));
  }
  const data = pick(json);
  return data === undefined ? failure("invalid_response") : { ok: true, data };
}

/** Searches SRD monsters by name. Rejects only on abort. */
export function fetchMonsterSearch(
  query: string,
  options: FetchOptions = {},
): Promise<LookupResult<MonsterSummary[]>> {
  return getJson(
    new URLSearchParams({ search: query }),
    (json) => {
      const results = (json as Partial<MonsterSearchResponseBody> | undefined)?.results;
      return Array.isArray(results) ? results : undefined;
    },
    options,
  );
}

/** Fetches one monster's full stat block. Rejects only on abort. */
export function fetchMonsterDetail(
  slug: string,
  options: FetchOptions = {},
): Promise<LookupResult<MonsterStatBlock>> {
  return getJson(
    new URLSearchParams({ slug }),
    (json) => {
      const monster = (json as Partial<MonsterDetailResponseBody> | undefined)?.monster;
      return typeof monster === "object" && monster !== null ? monster : undefined;
    },
    options,
  );
}
