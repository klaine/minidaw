// minidaw's service worker: the app works offline once it's installed. Installing caches everything in precache.json
// (the app, the instruments, their editors), so an active worker means a complete offline copy; until then the page
// runs from the network. Requests are answered from the cache first, then the network (and cached). A new VERSION
// (scripts/gen_precache.mjs) installs a new copy and the old one is removed.
const VERSION = "82b23a82743c";
const CACHE = "minidaw-" + VERSION;
const SHELL = ["./", "index.html", "css/app.css", "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png", "precache.json"];

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await c.addAll(SHELL.map((u) => new Request(u, { cache: "no-cache" })));
    const list = await (await c.match("precache.json")).json();
    // a few at a time; a file that fails fails the install (the next visit tries again)
    const files = list.files.filter((f) => !SHELL.includes(f));
    for (let i = 0; i < files.length; i += 8) {
      await Promise.all(files.slice(i, i + 8).map(async (f) => {
        const r = await fetch(f, { cache: "no-cache" });
        if (!r.ok) throw new Error(f + ": HTTP " + r.status);
        await c.put(f, r);
      }));
    }
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith("minidaw-") && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    const hit = await c.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const r = await fetch(req);
      if (r.ok && r.type === "basic") c.put(req, r.clone());
      return r;
    } catch (err) {
      if (req.mode === "navigate") { const shell = await c.match("index.html"); if (shell) return shell; }
      throw err;
    }
  })());
});
