// The browser's storage, and what is in it that nothing uses any more. A sample's bytes are kept in IndexedDB once it
// is imported or recorded; they are deleted here when no library folder lists it, no saved kit holds it, no saved
// project plays it, and the open project doesn't either (nor any state its Undo or Redo could bring back). That is
// looked at when something is removed from the library, when a project is deleted, and from Settings ("Free up
// storage"), never by itself. (A second tab with unsaved work is the one thing not seen from here: its project
// counts once it has saved, which it does within seconds of an edit.)
import { db } from "./db.js";
import { kits } from "./library.js";

/** The samples a project plays (audio clips, a Drum Rack's pads), added to `into`; the built-in ones aren't stored */
export function projectSamples(p, into = new Set()) {
  if (!p) return into;
  for (const c of Object.values(p.clips || {})) if (c && c.type === "audio" && c.sampleId && !c.sampleId.startsWith("builtin:")) into.add(c.sampleId);
  for (const t of p.tracks || []) {
    const pads = t.instrument && t.instrument.kind === "drumrack" && t.instrument.state && t.instrument.state.pads;
    for (const pad of pads || []) if (pad && pad.sample && !pad.sample.startsWith("builtin:")) into.add(pad.sample);
  }
  return into;
}

/** Every stored sample something still uses: { library: [items], kits: [kits], projects: [projects], open: [states] } -> Set */
export function usedSamples({ library = [], kits: saved = [], projects = [], open = [] }) {
  const used = new Set(library.map((it) => it.id));
  for (const k of saved) for (const pad of (k && k.pads) || []) if (pad && pad.sample) used.add(pad.sample);
  for (const p of [...projects, ...open]) projectSamples(p, used);
  return used;
}

/** Delete the stored samples nothing uses. -> how many went */
export async function sweepSamples(app) {
  const st = app.store;
  const used = usedSamples({
    library: app.library.items,
    kits: await kits.list(),
    projects: await db.allProjects(),
    open: [st.project, st.pending, ...st.undoStack, ...st.redoStack],
  });
  let gone = 0;
  for (const id of await db.sampleKeys()) {
    if (used.has(id)) continue;
    await db.deleteSample(id);
    app.samples.forget(id);
    gone++;
  }
  return gone;
}

/** { used, quota } in bytes, as the browser estimates them, or null where it doesn't say */
export async function storageUse() {
  try {
    if (!navigator.storage || !navigator.storage.estimate) return null;
    const e = await navigator.storage.estimate();
    return { used: e.usage || 0, quota: e.quota || 0 };
  } catch (_) { return null; }
}

export const megabytes = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + " GB" : n >= 1e6 ? Math.round(n / 1e6) + " MB" : Math.max(1, Math.round(n / 1e3)) + " kB");
