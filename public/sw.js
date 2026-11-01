/* DM Friend service worker: caches the app shell so the PWA opens offline. */

// Bump to invalidate every cache on the next deploy.
const VERSION = "v1";
// Every cache this worker owns starts with this prefix; activation only prunes these.
const CACHE_PREFIX = "dm-friend-";
const SHELL_CACHE = `${CACHE_PREFIX}shell-${VERSION}`;
const RUNTIME_CACHE = `${CACHE_PREFIX}runtime-${VERSION}`;

// Required: install fails (and the previous worker stays active) if any of these can't be cached.
const SHELL_URLS = [
  "/",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon.svg",
];

// Hashed build assets referenced by the shell HTML (scripts, styles, fonts).
// Backslash is excluded because the inline RSC payload uses escaped quotes (\").
const STATIC_ASSET_PATTERN = /\/_next\/static\/[^"'\s)\\]+/g;

async function precacheShell() {
  const cache = await caches.open(SHELL_CACHE);
  // addAll rejects if any request fails, which fails the install.
  await cache.addAll(SHELL_URLS);

  // The JS/CSS the shell HTML references is also required: without it the first
  // offline launch renders broken HTML. Any failure here rejects the install so
  // the new worker never activates and the previous caches are left intact.
  const response = await cache.match("/");
  if (!response) throw new Error("Shell HTML missing after precache");
  const html = await response.text();
  const requiredAssets = [...new Set(html.match(STATIC_ASSET_PATTERN) ?? [])];
  await cache.addAll(requiredAssets);
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
    return (
      (await matchIn(RUNTIME_CACHE, request)) ??
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
