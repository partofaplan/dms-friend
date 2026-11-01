// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
  const table = { ...defaults, ...routes };
  let online = true;

  const fetch = vi.fn(async (request: RequestLike) => {
    if (!online) throw new TypeError("Failed to fetch");
    const url = new URL(keyOf(request));
    const route = url.origin === ORIGIN ? table[url.pathname] : undefined;
    return route ? route() : new Response("not found", { status: 404 });
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

describe("service worker", () => {
  describe("install", () => {
    it("precaches the shell and the static assets it references", async () => {
      const sw = setup();
      await sw.lifecycle("install");

      const shell = sw.caches.stores.get("dm-friend-shell-v1")!;
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
      await sw.caches.open("dm-friend-shell-v0");
      await sw.caches.open("dm-friend-runtime-v0");
      await sw.caches.open("campaign-notes");
      await sw.caches.open("some-other-lib-cache");

      await sw.lifecycle("install");
      await sw.lifecycle("activate");

      expect((await sw.caches.keys()).sort()).toEqual([
        "campaign-notes",
        "dm-friend-shell-v1",
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
      const runtime = sw.caches.stores.get("dm-friend-runtime-v1");
      expect(runtime?.entries.size ?? 0).toBe(0);
    });
  });
});
