// IndexedDB: projects (the JSON), samples (the audio files as their bytes), misc settings.
const DB_NAME = "minidaw";
let dbp = null;

let handle = null; // the open database, for a write that can't wait (the page is going away)

function open() {
  if (!dbp) {
    const mine = dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains("projects")) db.createObjectStore("projects", { keyPath: "id" });
        if (!db.objectStoreNames.contains("samples")) db.createObjectStore("samples", { keyPath: "id" });
        if (!db.objectStoreNames.contains("misc")) db.createObjectStore("misc");
      };
      r.onsuccess = () => {
        const db = handle = r.result;
        // the browser may drop the connection (storage pressure, another tab upgrading): the next call opens it again
        const gone = () => { if (dbp === mine) { dbp = null; handle = null; } };
        db.onclose = gone;
        db.onversionchange = () => { db.close(); gone(); };
        resolve(db);
      };
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(new Error("the database is in use by another window"));
    });
    mine.catch(() => { if (dbp === mine) dbp = null; }); // a failed open is tried again by the next call
  }
  return dbp;
}

function run(store, mode, fn, again = true) {
  return open().then((db) => new Promise((resolve, reject) => {
    let tx;
    try { tx = db.transaction(store, mode); } catch (e) {
      // a connection that closed without saying so: once more on a new one
      dbp = null; handle = null;
      if (again) { run(store, mode, fn, false).then(resolve, reject); return; }
      reject(e); return;
    }
    const req = fn(tx.objectStore(store), tx);
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("the write was refused"));
  }));
}

export const db = {
  /**
   * since: the updatedAt of the copy this window last loaded or saved. If the stored project is newer (another tab
   * or window saved it since), nothing is written and the error's name is "StaleProject".
   */
  saveProject(p, { since } = {}) {
    let stale = false;
    return run("projects", "readwrite", (s, tx) => {
      if (since === undefined) return s.put(p);
      const g = s.get(p.id);
      g.onsuccess = () => { if (g.result && g.result.updatedAt > since) { stale = true; tx.abort(); } else s.put(p); };
      return null;
    }).catch((e) => {
      if (!stale) throw e;
      const err = new Error("another window saved this project since");
      err.name = "StaleProject";
      throw err;
    });
  },
  /** The project written at once, without waiting for anything (the page is going away). true if it could be sent */
  saveProjectNow(p) {
    if (!handle) return false;
    try { const tx = handle.transaction("projects", "readwrite"); tx.objectStore("projects").put(p); if (tx.commit) tx.commit(); return true; } catch (_) { return false; }
  },
  loadProject: (id) => run("projects", "readonly", (s) => s.get(id)),
  deleteProject: (id) => run("projects", "readwrite", (s) => s.delete(id)),
  async listProjects() {
    const all = await run("projects", "readonly", (s) => s.getAll());
    return (all || []).map((p) => ({ id: p.id, name: p.name, updatedAt: p.updatedAt, tracks: p.tracks.length }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  },
  saveSample: (rec) => run("samples", "readwrite", (s) => s.put(rec)),
  loadSample: (id) => run("samples", "readonly", (s) => s.get(id)),
  deleteSample: (id) => run("samples", "readwrite", (s) => s.delete(id)),
  /** The ids of every stored sample (without their bytes) */
  sampleKeys: () => run("samples", "readonly", (s) => s.getAllKeys()),
  /** Every saved project, whole (to see what they use) */
  allProjects: () => run("projects", "readonly", (s) => s.getAll()).then((all) => all || []),
  get: (k) => run("misc", "readonly", (s) => s.get(k)),
  set: (k, v) => run("misc", "readwrite", (s) => s.put(v, k)),
};

/** Ask the browser to keep this site's storage (Safari otherwise may clear it after weeks unused) */
export async function persistStorage() {
  try { if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist(); } catch (_) { /* no API */ }
  return false;
}
