import { getMonster, Open5eError, searchMonsters } from "@/lib/monsters/open5e";
import {
  monsterQuerySchema,
  type MonsterDetailResponseBody,
  type MonsterErrorKind,
  type MonsterErrorResponseBody,
  type MonsterSearchResponseBody,
} from "@/lib/monsters/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ERROR_STATUS: Record<MonsterErrorKind, number> = {
  bad_request: 400,
  not_found: 404,
  upstream_error: 502,
  timeout: 504,
};

const ERROR_MESSAGE: Record<MonsterErrorKind, string> = {
  bad_request: "Provide a monster name to search for, or a monster slug.",
  not_found: "That monster wasn't found.",
  upstream_error: "The monster database is unavailable right now. Try again shortly.",
  timeout: "The monster database took too long to respond. Try again shortly.",
};

/** Lets shared caches reuse a lookup briefly; SRD data rarely changes. */
const SUCCESS_CACHE_CONTROL = "public, max-age=60, s-maxage=300, stale-while-revalidate=600";

function errorJson(kind: MonsterErrorKind): Response {
  const body: MonsterErrorResponseBody = { error: { kind, message: ERROR_MESSAGE[kind] } };
  return Response.json(body, {
    status: ERROR_STATUS[kind],
    headers: { "Cache-Control": "no-store" },
  });
}

function okJson(body: MonsterSearchResponseBody | MonsterDetailResponseBody): Response {
  return Response.json(body, { headers: { "Cache-Control": SUCCESS_CACHE_CONTROL } });
}

/**
 * GET /api/monsters — proxies Open5e (SRD monsters only). Exactly one of:
 *   ?search=<name> → 200 MonsterSearchResponseBody (empty `results` when nothing matches)
 *   ?slug=<slug>   → 200 MonsterDetailResponseBody
 * Errors → MonsterErrorResponseBody: 400 bad params, 404 unknown slug,
 * 502 upstream failure, 504 upstream timeout.
 */
export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const parsed = monsterQuerySchema.safeParse({
    search: params.get("search") ?? undefined,
    slug: params.get("slug") ?? undefined,
  });
  if (!parsed.success) return errorJson("bad_request");

  const query = parsed.data;
  try {
    if (query.mode === "slug") {
      return okJson({ monster: await getMonster(query.slug) });
    }
    return okJson({ results: await searchMonsters(query.search) });
  } catch (error) {
    const kind: MonsterErrorKind = error instanceof Open5eError ? error.kind : "upstream_error";
    const detail = error instanceof Error ? error.message : "non-Error thrown";
    console.error(`[api/monsters] lookup failed (${kind}): ${detail}`);
    return errorJson(kind);
  }
}
