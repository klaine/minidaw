// IndexedDB: projects (the JSON), samples (the audio files as their bytes), misc settings.
const DB_NAME = "minidaw";
let dbp = null;

function open() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains("projects")) db.createObjectStore("projects", { keyPath: "id" });
        if (!db.objectStoreNames.contains("samples")) db.createObjectStore("samples", { keyPath: "id" });
        if (!db.objectStoreNames.contains("misc")) db.createObjectStore("misc");
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return dbp;
}

function run(store, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

export const db = {
  saveProject: (p) => run("projects", "readwrite", (s) => s.put(p)),
  loadProject: (id) => run("projects", "readonly", (s) => s.get(id)),
  deleteProject: (id) => run("projects", "readwrite", (s) => s.delete(id)),
  async listProjects() {
    const all = await run("projects", "readonly", (s) => s.getAll());
    return (all || []).map((p) => ({ id: p.id, name: p.name, updatedAt: p.updatedAt, tracks: p.tracks.length }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  },
  saveSample: (rec) => run("samples", "readwrite", (s) => s.put(rec)),
  loadSample: (id) => run("samples", "readonly", (s) => s.get(id)),
  get: (k) => run("misc", "readonly", (s) => s.get(k)),
  set: (k, v) => run("misc", "readwrite", (s) => s.put(v, k)),
};

/** Ask the browser to keep this site's storage (Safari otherwise may clear it after weeks unused) */
export async function persistStorage() {
  try { if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist(); } catch (_) { /* no API */ }
  return false;
}
