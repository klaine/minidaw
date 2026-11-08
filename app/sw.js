// minidaw's service worker: the app works offline once loaded. The app shell is cached at install; everything else
// in precache.json (the instruments, their editors) right after, in the background. Requests are answered from the
// cache first, then the network (and cached). A new VERSION (scripts/gen_precache.mjs) replaces the caches.
const VERSION = "6dc6bfe79fd5";
const CACHE = "minidaw-" + VERSION;
const SHELL = ["./", "index.html", "css/app.css", "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png", "precache.json"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith("minidaw-") && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
    // the rest, without holding up the page
    try {
      const list = await (await fetch("precache.json", { cache: "no-cache" })).json();
      const c = await caches.open(CACHE);
      for (const url of list.files) {
        if (await c.match(url)) continue;
        try { const r = await fetch(url, { cache: "no-cache" }); if (r.ok) await c.put(url, r); } catch (_) { /* offline now: later */ }
      }
    } catch (_) { /* no list (a dev server) */ }
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
