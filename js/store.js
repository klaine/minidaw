// The project store: one project, undo / redo by snapshots, change events. UI state (selection, view) lives in
// store.ui and is not undone.
import { Emitter, deepCopy } from "./util.js";

const UNDO_LIMIT = 120;
// ...and at most this much of them (characters of JSON that the steps don't share with each other): many edits of a
// very large clip stop being undoable at the far end rather than fill the memory
const UNDO_CHARS = 48e6;

/** Are two states of a project the same, but for when they were touched? */
function sameProject(a, b) {
  const ua = a.updatedAt, ub = b.updatedAt;
  a.updatedAt = b.updatedAt = 0;
  const same = JSON.stringify(a) === JSON.stringify(b);
  a.updatedAt = ua; b.updatedAt = ub;
  return same;
}

export class Store extends Emitter {
  constructor(project) {
    super();
    this.project = project;
    this.undoStack = [];
    this.redoStack = [];
    this.pending = null;
    this.ui = {
      view: "arrange", // arrange | session | mixer
      selTrack: project.tracks[0] ? project.tracks[0].id : null,
      selClip: null,   // clip id open in the editor
      selSlot: null,   // {trackId, scene}
      panel: "device", // bottom panel: device | clip | keys
      tool: "draw",    // draw | select
      grid: 0.25,
      dirty: false,
    };
  }

  setProject(p) {
    this.project = p;
    this.undoStack = [];
    this.redoStack = [];
    this.undoChars = 0;
    this.shared = null;
    this.pending = null;
    this.gesture = false;
    this.ui.selTrack = p.tracks[0] ? p.tracks[0].id : null;
    this.ui.selClip = null;
    this.ui.selSlot = null;
    this.emit("project", p);
    this.emit("change", { reason: "project" });
  }

  /**
   * The project as it is, to go back to. Not a copy of all of it: a clip or a track that hasn't changed since the last
   * snapshot is the last snapshot's (the same object), so an undo step costs what it changed (a song with 50,000
   * notes took 120 whole copies of itself). Snapshots are never changed: going back to one copies it (thaw).
   */
  snapshot() {
    const p = this.project;
    const cache = this.shared || (this.shared = { clips: new Map(), tracks: new Map() });
    let fresh = 0;
    const part = (map, id, value) => {
      const json = JSON.stringify(value);
      const hit = map.get(id);
      if (hit && hit.json === json) return hit.obj;
      const obj = JSON.parse(json);
      map.set(id, { json, obj });
      fresh += json.length;
      return obj;
    };
    const snap = {};
    for (const k of Object.keys(p)) { // in the project's own order, so two states compare as text
      if (k === "clips") { snap.clips = {}; for (const id of Object.keys(p.clips)) snap.clips[id] = part(cache.clips, id, p.clips[id]); }
      else if (k === "tracks") snap.tracks = p.tracks.map((t) => part(cache.tracks, t.id, t));
      else if (p[k] !== undefined) { const json = JSON.stringify(p[k]); fresh += json.length; snap[k] = JSON.parse(json); }
    }
    // only what's in the project now can be shared with the next snapshot
    for (const id of cache.clips.keys()) if (!(id in p.clips)) cache.clips.delete(id);
    if (cache.tracks.size > p.tracks.length) { const ids = new Set(p.tracks.map((t) => t.id)); for (const id of cache.tracks.keys()) if (!ids.has(id)) cache.tracks.delete(id); }
    Object.defineProperty(snap, "chars", { value: fresh, enumerable: false }); // what it holds that the one before didn't
    return snap;
  }
  /** A snapshot as the project again: a copy, the snapshot stays as it was (other steps share its parts) */
  thaw(snap) { return deepCopy(snap); }

  /**
   * A change with an undo step: fn(project) edits in place. Live edits just before it (a knob's or a fader's drag,
   * which ends with an update) are part of the same step, undone from before the first of them.
   */
  update(fn, reason = "edit") {
    const before = this.pending || this.locked ? null : this.snapshot();
    const r = fn(this.project);
    if (before) this.pushUndo(before);
    else if (this.pending && !this.gesture) { this.pushUndo(this.pending); this.pending = null; }
    this.touch(reason);
    return r;
  }

  /** Start a gesture (a drag): its live() changes become one undo step at commit() */
  begin() { if (!this.pending) this.pending = this.snapshot(); this.gesture = true; }
  /** A change while something is being dragged: no undo step yet (the state before it is kept for the step) */
  live(fn, reason = "edit") {
    if (!this.pending && !this.locked) this.pending = this.snapshot();
    const r = fn(this.project);
    this.touch(reason, true);
    return r;
  }
  commit(reason = "edit") {
    // a gesture that changed nothing (a drag that hit no note, a tap on a control) is not an undo step
    if (this.pending && !this.locked && !sameProject(this.pending, this.project)) this.pushUndo(this.pending);
    this.pending = null;
    this.gesture = false;
    this.touch(reason);
  }
  cancel() {
    if (this.pending) { this.project = this.thaw(this.pending); this.pending = null; this.gesture = false; this.touch("undo"); }
  }
  /** Live edits that weren't closed by an update or a commit become their step now */
  settle() { if (this.pending && !this.gesture && !this.locked) { this.pushUndo(this.pending); this.pending = null; } }

  pushUndo(snap) {
    this.undoStack.push(snap);
    this.undoChars = (this.undoChars || 0) + (snap.chars || 0);
    while (this.undoStack.length > UNDO_LIMIT || (this.undoChars > UNDO_CHARS && this.undoStack.length > 8)) this.undoChars -= this.undoStack.shift().chars || 0;
    this.redoStack.length = 0;
  }

  touch(reason, live = false) {
    this.project.updatedAt = Date.now();
    this.ui.dirty = true;
    this.emit("change", { reason, live });
  }

  undo() {
    if (this.locked) return false; // a recording in progress is one step, taken at its end
    this.settle();
    if (!this.undoStack.length) return false;
    this.redoStack.push(this.snapshot());
    const back = this.undoStack.pop();
    this.undoChars = Math.max(0, (this.undoChars || 0) - (back.chars || 0));
    this.project = this.thaw(back);
    this.fixSelection();
    this.touch("undo");
    return true;
  }
  redo() {
    this.settle();
    if (this.locked || !this.redoStack.length) return false;
    const now = this.snapshot();
    this.undoStack.push(now);
    this.undoChars = (this.undoChars || 0) + (now.chars || 0);
    this.project = this.thaw(this.redoStack.pop());
    this.fixSelection();
    this.touch("undo");
    return true;
  }
  fixSelection() {
    const p = this.project;
    if (!p.tracks.find((t) => t.id === this.ui.selTrack)) this.ui.selTrack = p.tracks[0] ? p.tracks[0].id : null;
    if (this.ui.selClip && !p.clips[this.ui.selClip]) this.ui.selClip = null;
  }

  track(id) { return this.project.tracks.find((t) => t.id === id) || null; }
  get selectedTrack() { return this.track(this.ui.selTrack); }
  get selectedClip() { return this.ui.selClip ? this.project.clips[this.ui.selClip] || null : null; }
  /** The track that holds a clip (in a slot or the arrangement) */
  trackOfClip(clipId) {
    for (const t of this.project.tracks) {
      if (t.slots.includes(clipId) || t.arrangement.some((pl) => pl.clipId === clipId)) return t;
    }
    return null;
  }
  /** The panel tab after a track is picked: Keys stays (you're playing: the next track plays), else its device */
  trackPanel() { return this.ui.panel === "keys" ? "keys" : "device"; }
  select(patch) { Object.assign(this.ui, patch); this.emit("select", patch); }
}
