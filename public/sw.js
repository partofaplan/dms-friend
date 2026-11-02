/* DM Friend service worker: caches the app shell so the PWA opens offline. */

// Bump to invalidate every cache on the next deploy.
const VERSION = "v2";
// Every cache this worker owns starts with this prefix; activation only prunes these.
const CACHE_PREFIX = "dm-friend-";
const SHELL_CACHE = `${CACHE_PREFIX}shell-${VERSION}`;
const RUNTIME_CACHE = `${CACHE_PREFIX}runtime-${VERSION}`;

// Required static files: install fails (and the previous worker stays active)
// if any of these can't be cached.
const SHELL_URLS = [
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon.svg",
];

/*
 * Top-level routes whose page shells are precached so a cold offline launch can
 * open any of them (keep in sync with APP_ROUTES in src/components/nav-items.ts).
 *
 * Required routes are the offline core: the home shell (the fallback for every
 * other navigation) plus the roster, the monster stable and the profile picker
 * (local data, fully usable offline). If one of them, or any asset it
 * references, can't be cached, install fails.
 *
 * Best-effort routes only matter online anyway (monsters/chat/scan show an
 * offline state), so one failing must not block an otherwise good update. Each
 * is all-or-nothing: its HTML is stored only after all of its assets are, so a
 * cached page never references a missing chunk. A skipped route falls back to
 * the home shell offline, as before.
 */
const REQUIRED_ROUTES = ["/", "/roster", "/stable", "/profiles"];
const BEST_EFFORT_ROUTES = ["/scan", "/monsters", "/chat"];

// Hashed build assets referenced by a page's HTML (scripts, styles, fonts).
// Backslash is excluded because the inline RSC payload uses escaped quotes (\").
const STATIC_ASSET_PATTERN = /\/_next\/static\/[^"'\s)\\]+/g;

// A best-effort route that hasn't finished by then is skipped, so a stalled
// request can't hold up install (and activation) once the required routes are in.
const BEST_EFFORT_TIMEOUT_MS = 10_000;

/**
 * Caches a route's HTML plus every static asset it references; rejects on any
 * failure, or once `signal` aborts.
 */
async function precacheRoute(cache, path, signal) {
  const response = await fetch(path, { cache: "reload", signal });
  if (!response.ok) throw new Error(`Precache failed for ${path}: ${response.status}`);
  const html = await response.clone().text();
  const assets = [...new Set(html.match(STATIC_ASSET_PATTERN) ?? [])];
  // Routes share most chunks; skip whatever an earlier route already stored.
  const missing = [];
  for (const asset of assets) {
    if (!(await cache.match(asset))) missing.push(asset);
  }
  // Fetched (rather than cache.addAll'd) so the abort signal reaches every request.
  const fetched = await Promise.all(
    missing.map(async (asset) => {
      const assetResponse = await fetch(asset, { signal });
      if (!assetResponse.ok) throw new Error(`Precache failed for ${asset}: ${assetResponse.status}`);
      return assetResponse;
    }),
  );
  await Promise.all(fetched.map((assetResponse, i) => cache.put(missing[i], assetResponse)));
  signal?.throwIfAborted();
  // Written last so the page is only ever cached alongside its assets.
  await cache.put(path, response);
}

/** precacheRoute, abandoned (and rejected) after BEST_EFFORT_TIMEOUT_MS. */
async function precacheRouteWithTimeout(cache, path) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`Precache timed out for ${path}`)),
    BEST_EFFORT_TIMEOUT_MS,
  );
  try {
    await precacheRoute(cache, path, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function precacheShell() {
  const cache = await caches.open(SHELL_CACHE);
  // addAll rejects if any request fails, which fails the install.
  await cache.addAll(SHELL_URLS);

  // Without its JS/CSS a page renders broken offline, so required routes and
  // their assets reject the install; the previous caches are left intact.
  for (const path of REQUIRED_ROUTES) await precacheRoute(cache, path);

  // Best-effort routes run after the required ones so they reuse the shared
  // chunks already cached; failures and timeouts are swallowed per route.
  await Promise.allSettled(BEST_EFFORT_ROUTES.map((path) => precacheRouteWithTimeout(cache, path)));
}

self.addEventListener("install", (event) => {
  event.waitUntil(precacheShell().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, RUNTIME_CACHE]);
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && !keep.has(key))
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

async function matchIn(cacheName, request) {
  const cache = await caches.open(cacheName);
  return cache.match(request);
}

// Runtime entries are written after install, so they are always at least as fresh
// as the shell copies; check them first rather than relying on global match order.
async function matchPreferringRuntime(request) {
  return (
    (await matchIn(RUNTIME_CACHE, request)) ?? (await matchIn(SHELL_CACHE, request))
  );
}

async function putInRuntime(request, response) {
  try {
    const cache = await caches.open(RUNTIME_CACHE);
    await cache.put(request, response);
  } catch {
    // Quota or storage errors must not break the response already in hand.
  }
}

async function networkFirstNavigation(event) {
  const { request } = event;
  try {
    const response = await fetch(request);
    if (response.ok) await putInRuntime(request, response.clone());
    return response;
  } catch {
    // Exact route first (a newer runtime copy beats the precached shell), then
    // the home shell, which can boot the app for any route.
    return (
      (await matchPreferringRuntime(request)) ??
      (await matchIn(RUNTIME_CACHE, "/")) ??
      (await matchIn(SHELL_CACHE, "/")) ??
      Response.error()
    );
  }
}

async function cacheFirst(event) {
  const { request } = event;
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await putInRuntime(request, response.clone());
  return response;
}

async function staleWhileRevalidate(event) {
  const { request } = event;
  const cached = await matchPreferringRuntime(request);
  const network = fetch(request)
    .then(async (response) => {
      if (response.ok) await putInRuntime(request, response.clone());
      return response;
    })
    .catch(() => undefined);
  // Keep the worker alive until the background refresh has been written.
  event.waitUntil(network);
  return cached ?? (await network) ?? Response.error();
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // API responses (AI, monster lookups) are live data; never serve them from cache.
  if (url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirstNavigation(event));
  } else if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(cacheFirst(event));
  } else {
    event.respondWith(staleWhileRevalidate(event));
  }
});
