// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { APP_ROUTES } from "@/components/nav-items";

/*
 * Runs the deployed public/sw.js against in-memory fakes of the service worker
 * globals (self, caches, fetch), so the tests exercise the exact shipped script.
 */

const ORIGIN = "https://dm-friend.test";
const SW_SOURCE = readFileSync(
  fileURLToPath(new URL("../public/sw.js", import.meta.url)),
  "utf8",
);

type RequestLike = string | { url: string; method?: string; mode?: string };

function keyOf(request: RequestLike): string {
  return new URL(typeof request === "string" ? request : request.url, ORIGIN).href;
}

class FakeCache {
  entries = new Map<string, Response>();
  constructor(private fetcher: (request: RequestLike) => Promise<Response>) {}

  async match(request: RequestLike) {
    return this.entries.get(keyOf(request))?.clone();
  }
  async put(request: RequestLike, response: Response) {
    this.entries.set(keyOf(request), response);
  }
  async add(request: RequestLike) {
    const response = await this.fetcher(request);
    if (!response.ok) throw new TypeError(`Bad response for ${keyOf(request)}`);
    await this.put(request, response);
  }
  async addAll(requests: RequestLike[]) {
    await Promise.all(requests.map((request) => this.add(request)));
  }
}

class FakeCacheStorage {
  stores = new Map<string, FakeCache>();
  constructor(private fetcher: (request: RequestLike) => Promise<Response>) {}

  async open(name: string) {
    let cache = this.stores.get(name);
    if (!cache) {
      cache = new FakeCache(this.fetcher);
      this.stores.set(name, cache);
    }
    return cache;
  }
  // Like the real CacheStorage.match: searches caches in creation order.
  async match(request: RequestLike) {
    for (const cache of this.stores.values()) {
      const hit = await cache.match(request);
      if (hit) return hit;
    }
    return undefined;
  }
  async keys() {
    return [...this.stores.keys()];
  }
  async delete(name: string) {
    return this.stores.delete(name);
  }
}

type Handler = (event: unknown) => void;

function html(body: string) {
  return new Response(body, { headers: { "Content-Type": "text/html" } });
}

const SHELL_HTML = `<html><head>
<link rel="stylesheet" href="/_next/static/css/app.css">
<script src="/_next/static/chunks/main.js"></script>
<script>self.__next_f.push([1,"HL[\\"/_next/static/css/app.css\\",\\"style\\"]"])</script>
</head><body>shell v1</body></html>`;

const FEATURE_ROUTES = ["/roster", "/stable", "/scan", "/monsters", "/chat"];

/** A feature page: the shared app chunks plus its own page chunk. */
function pageChunk(route: string) {
  return `/_next/static/chunks/app${route}/page.js`;
}
function pageHtml(route: string) {
  return `<html><head>
<link rel="stylesheet" href="/_next/static/css/app.css">
<script src="/_next/static/chunks/main.js"></script>
<script src="${pageChunk(route)}"></script>
</head><body>${route} page v1</body></html>`;
}

function setup(routes: Record<string, () => Response | Promise<Response>> = {}) {
  const defaults: Record<string, () => Response> = {
    "/": () => html(SHELL_HTML),
    "/manifest.webmanifest": () => new Response("{}"),
    "/icons/icon-192.png": () => new Response("png"),
    "/icons/icon-512.png": () => new Response("png"),
    "/icons/icon.svg": () => new Response("svg"),
    "/_next/static/css/app.css": () => new Response("css"),
    "/_next/static/chunks/main.js": () => new Response("js"),
  };
  for (const route of FEATURE_ROUTES) {
    defaults[route] = () => html(pageHtml(route));
    defaults[pageChunk(route)] = () => new Response(`${route} js`);
  }
  const table = { ...defaults, ...routes };
  let online = true;

  const fetch = vi.fn(async (request: RequestLike, init?: { signal?: AbortSignal }) => {
    if (!online) throw new TypeError("Failed to fetch");
    const url = new URL(keyOf(request));
    const route = url.origin === ORIGIN ? table[url.pathname] : undefined;
    if (!route) return new Response("not found", { status: 404 });
    // Like the real fetch, an aborted signal rejects even a request that never settles.
    const signal = init?.signal;
    if (!signal) return route();
    signal.throwIfAborted();
    return new Promise<Response>((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      Promise.resolve().then(route).then(resolve, reject);
    });
  });

  const caches = new FakeCacheStorage(fetch);
  const listeners: Record<string, Handler[]> = {};
  const self = {
    location: new URL(ORIGIN),
    skipWaiting: vi.fn(async () => {}),
    clients: { claim: vi.fn(async () => {}) },
    addEventListener(type: string, handler: Handler) {
      (listeners[type] ??= []).push(handler);
    },
  };

  new Function("self", "caches", "fetch", SW_SOURCE)(self, caches, fetch);

  function extendable() {
    const pending: Promise<unknown>[] = [];
    return {
      pending,
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
    };
  }

  async function lifecycle(type: "install" | "activate") {
    const event = extendable();
    listeners[type].forEach((handler) => handler(event));
    await Promise.all(event.pending);
  }

  /** Dispatches a fetch event; resolves to the response, or null if the worker didn't respond. */
  async function dispatchFetch(
    path: string,
    init: { method?: string; mode?: string } = {},
  ) {
    const request = {
      url: new URL(path, ORIGIN).href,
      method: init.method ?? "GET",
      mode: init.mode ?? "no-cors",
    };
    const event = extendable();
    let responded: Promise<Response> | null = null;
    listeners.fetch.forEach((handler) =>
      handler({
        request,
        waitUntil: event.waitUntil,
        respondWith(promise: Promise<Response>) {
          responded = promise;
        },
      }),
    );
    const response = responded ? await responded : null;
    await Promise.all(event.pending);
    return response as Response | null;
  }

  return {
    caches,
    fetch,
    self,
    table,
    lifecycle,
    dispatchFetch,
    navigate: (path: string) => dispatchFetch(path, { mode: "navigate" }),
    setOnline(value: boolean) {
      online = value;
    },
  };
}

/** Reads a `const NAME = ["...", ...];` string-array literal out of the worker source. */
function swRouteList(name: string): string[] {
  const match = SW_SOURCE.match(new RegExp(`const ${name} = (\\[[^\\]]*\\]);`));
  if (!match) throw new Error(`${name} not found in public/sw.js`);
  return JSON.parse(match[1].replace(/,\s*\]$/, "]"));
}

describe("service worker", () => {
  it("precaches exactly the app's top-level routes (APP_ROUTES)", () => {
    const precached = [...swRouteList("REQUIRED_ROUTES"), ...swRouteList("BEST_EFFORT_ROUTES")];
    // No route listed twice, and none missing or extra versus the nav.
    expect(new Set(precached).size).toBe(precached.length);
    expect([...precached].sort()).toEqual([...APP_ROUTES].sort());
  });

  describe("install", () => {
    it("precaches the shell and the static assets it references", async () => {
      const sw = setup();
      await sw.lifecycle("install");

      const shell = sw.caches.stores.get("dm-friend-shell-v2")!;
      expect([...shell.entries.keys()].map((key) => new URL(key).pathname)).toEqual(
        expect.arrayContaining([
          "/",
          "/manifest.webmanifest",
          "/_next/static/css/app.css",
          "/_next/static/chunks/main.js",
        ]),
      );
      expect(sw.self.skipWaiting).toHaveBeenCalled();
    });

    it("precaches every top-level route and the page chunks each one references", async () => {
      const sw = setup();
      await sw.lifecycle("install");

      const cached = [...sw.caches.stores.get("dm-friend-shell-v2")!.entries.keys()].map(
        (key) => new URL(key).pathname,
      );
      expect(cached).toEqual(
        expect.arrayContaining([...FEATURE_ROUTES, ...FEATURE_ROUTES.map(pageChunk)]),
      );
      // Shared chunks are fetched once, not once per route.
      const mainFetches = sw.fetch.mock.calls.filter(
        ([request]) => keyOf(request).endsWith("/_next/static/chunks/main.js"),
      );
      expect(mainFetches).toHaveLength(1);
    });

    it("rejects when a required route (the roster) or one of its assets fails", async () => {
      const page = setup({ "/roster": () => new Response("", { status: 500 }) });
      await expect(page.lifecycle("install")).rejects.toThrow();
      expect(page.self.skipWaiting).not.toHaveBeenCalled();

      const chunk = setup({ [pageChunk("/roster")]: () => new Response("", { status: 500 }) });
      await expect(chunk.lifecycle("install")).rejects.toThrow();
      expect(chunk.self.skipWaiting).not.toHaveBeenCalled();
    });

    it("treats the monster stable as required, since it works offline", async () => {
      expect(swRouteList("REQUIRED_ROUTES")).toContain("/stable");
      const page = setup({ "/stable": () => new Response("", { status: 500 }) });
      await expect(page.lifecycle("install")).rejects.toThrow();
      expect(page.self.skipWaiting).not.toHaveBeenCalled();
    });

    it("skips a best-effort route whose page or assets fail, without failing install", async () => {
      const sw = setup({
        "/monsters": () => new Response("", { status: 503 }),
        [pageChunk("/chat")]: () => {
          throw new TypeError("Failed to fetch");
        },
      });
      await sw.lifecycle("install");
      expect(sw.self.skipWaiting).toHaveBeenCalled();

      const shell = sw.caches.stores.get("dm-friend-shell-v2")!;
      const has = (path: string) => shell.entries.has(new URL(path, ORIGIN).href);
      expect(has("/monsters")).toBe(false);
      // The chat page is never stored without its chunk.
      expect(has("/chat")).toBe(false);
      expect(has("/scan")).toBe(true);
      expect(has("/roster")).toBe(true);

      // Offline, a skipped route still boots from the home shell.
      sw.setOnline(false);
      expect(await (await sw.navigate("/chat"))!.text()).toContain("shell v1");
    });

    it("skips a best-effort route that stalls, so install still completes", async () => {
      vi.useFakeTimers();
      try {
        const never = () => new Promise<Response>(() => {});
        // One route's page never responds; another's page chunk never does.
        const sw = setup({ "/chat": never, [pageChunk("/monsters")]: never });

        let installed = false;
        const install = sw.lifecycle("install").then(() => {
          installed = true;
        });
        await vi.advanceTimersByTimeAsync(9_999);
        expect(installed).toBe(false);

        await vi.advanceTimersByTimeAsync(1);
        await install;
        expect(sw.self.skipWaiting).toHaveBeenCalled();

        const shell = sw.caches.stores.get("dm-friend-shell-v2")!;
        const has = (path: string) => shell.entries.has(new URL(path, ORIGIN).href);
        expect(has("/")).toBe(true);
        expect(has("/roster")).toBe(true);
        expect(has("/scan")).toBe(true);
        expect(has("/chat")).toBe(false);
        // Never stored without its chunk.
        expect(has("/monsters")).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("rejects when a required static asset fails to cache", async () => {
      const sw = setup({
        "/_next/static/chunks/main.js": () => new Response("boom", { status: 500 }),
      });

      await expect(sw.lifecycle("install")).rejects.toThrow();
      expect(sw.self.skipWaiting).not.toHaveBeenCalled();
    });

    it("rejects when a static asset request errors at the network layer", async () => {
      const sw = setup({
        "/_next/static/css/app.css": () => {
          throw new TypeError("Failed to fetch");
        },
      });

      await expect(sw.lifecycle("install")).rejects.toThrow();
      expect(sw.self.skipWaiting).not.toHaveBeenCalled();
    });

    it("rejects when a shell URL fails to cache", async () => {
      const sw = setup({
        "/manifest.webmanifest": () => new Response("", { status: 503 }),
      });

      await expect(sw.lifecycle("install")).rejects.toThrow();
      expect(sw.self.skipWaiting).not.toHaveBeenCalled();
    });
  });

  describe("activate", () => {
    it("deletes only stale dm-friend-* caches and leaves unrelated caches intact", async () => {
      const sw = setup();
      await sw.caches.open("dm-friend-shell-v1");
      await sw.caches.open("dm-friend-runtime-v1");
      await sw.caches.open("campaign-notes");
      await sw.caches.open("some-other-lib-cache");

      await sw.lifecycle("install");
      await sw.lifecycle("activate");

      expect((await sw.caches.keys()).sort()).toEqual([
        "campaign-notes",
        "dm-friend-shell-v2",
        "some-other-lib-cache",
      ]);
      expect(sw.self.clients.claim).toHaveBeenCalled();
    });
  });

  describe("navigation", () => {
    it("serves the newer runtime HTML offline instead of the stale precached shell", async () => {
      const sw = setup();
      await sw.lifecycle("install");
      await sw.lifecycle("activate");

      // A deploy ships new HTML; an online visit refreshes the runtime cache.
      sw.table["/"] = () => html("<html><body>shell v2</body></html>");
      const online = await sw.navigate("/");
      expect(await online!.text()).toContain("shell v2");

      sw.setOnline(false);
      const offline = await sw.navigate("/");
      expect(await offline!.text()).toContain("shell v2");
    });

    it("falls back to the runtime '/' copy, then the shell '/', for unknown routes offline", async () => {
      const sw = setup();
      await sw.lifecycle("install");

      sw.setOnline(false);
      expect(await (await sw.navigate("/encounters"))!.text()).toContain("shell v1");

      sw.setOnline(true);
      sw.table["/"] = () => html("<html><body>shell v2</body></html>");
      await sw.navigate("/");
      sw.setOnline(false);
      expect(await (await sw.navigate("/encounters"))!.text()).toContain("shell v2");
    });

    it.each(["/", ...FEATURE_ROUTES])(
      "opens %s from the precached shell on a cold offline launch",
      async (route) => {
        const sw = setup();
        await sw.lifecycle("install");
        await sw.lifecycle("activate");

        sw.setOnline(false);
        const page = await sw.navigate(route);
        expect(await page!.text()).toContain(route === "/" ? "shell v1" : `${route} page v1`);
        const chunk = await sw.dispatchFetch(route === "/" ? "/_next/static/chunks/main.js" : pageChunk(route));
        expect(chunk!.ok).toBe(true);
      },
    );

    it("prefers a newer runtime copy of a precached route offline", async () => {
      const sw = setup();
      await sw.lifecycle("install");

      sw.table["/roster"] = () => html("<html><body>/roster page v2</body></html>");
      await sw.navigate("/roster");

      sw.setOnline(false);
      expect(await (await sw.navigate("/roster"))!.text()).toContain("/roster page v2");
    });

    it("prefers the cached page for the exact route offline", async () => {
      const sw = setup({ "/party": () => html("party page") });
      await sw.lifecycle("install");
      await sw.navigate("/party");

      sw.setOnline(false);
      expect(await (await sw.navigate("/party"))!.text()).toBe("party page");
    });

    it("returns a network error when nothing is cached", async () => {
      const sw = setup();
      sw.setOnline(false);
      const response = await sw.navigate("/");
      expect(response!.type).toBe("error");
    });
  });

  describe("runtime caching", () => {
    it("writes cache-first static assets before responding", async () => {
      const sw = setup({ "/_next/static/chunks/late.js": () => new Response("late") });
      await sw.dispatchFetch("/_next/static/chunks/late.js");

      sw.setOnline(false);
      const response = await sw.dispatchFetch("/_next/static/chunks/late.js");
      expect(await response!.text()).toBe("late");
    });

    it("revalidates stale-while-revalidate entries within the event lifetime", async () => {
      const sw = setup();
      await sw.lifecycle("install");

      sw.table["/manifest.webmanifest"] = () => new Response('{"v":2}');
      const stale = await sw.dispatchFetch("/manifest.webmanifest");
      expect(await stale!.text()).toBe("{}");

      sw.setOnline(false);
      const fresh = await sw.dispatchFetch("/manifest.webmanifest");
      expect(await fresh!.text()).toBe('{"v":2}');
    });
  });

  describe("bypass", () => {
    it.each([
      ["an /api/ request", "/api/monsters", {}],
      ["a non-GET request", "/", { method: "POST", mode: "navigate" }],
      ["a cross-origin request", "https://cdn.example.com/lib.js", {}],
    ])("does not handle %s", async (_label, path, init) => {
      const sw = setup();
      await sw.lifecycle("install");
      sw.fetch.mockClear();

      expect(await sw.dispatchFetch(path, init)).toBeNull();
      expect(sw.fetch).not.toHaveBeenCalled();
      const runtime = sw.caches.stores.get("dm-friend-runtime-v2");
      expect(runtime?.entries.size ?? 0).toBe(0);
    });

    it("leaves offline /api/ requests to fail fast in the page instead of serving a cache", async () => {
      const sw = setup({ "/api/monsters": () => new Response("[]") });
      await sw.lifecycle("install");
      await sw.dispatchFetch("/api/monsters");

      sw.setOnline(false);
      expect(await sw.dispatchFetch("/api/monsters")).toBeNull();
      for (const cache of sw.caches.stores.values()) {
        expect([...cache.entries.keys()].some((key) => key.includes("/api/"))).toBe(false);
      }
    });
  });
});
