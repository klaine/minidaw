// The project store: one project, undo / redo by snapshots, change events. UI state (selection, view) lives in
// store.ui and is not undone.
import { Emitter, deepCopy } from "./util.js";

const UNDO_LIMIT = 120;

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
    this.pending = null;
    this.ui.selTrack = p.tracks[0] ? p.tracks[0].id : null;
    this.ui.selClip = null;
    this.ui.selSlot = null;
    this.emit("project", p);
    this.emit("change", { reason: "project" });
  }

  snapshot() { return deepCopy(this.project); }

  /** A change with an undo step: fn(project) edits in place */
  update(fn, reason = "edit") {
    const before = this.pending ? null : this.snapshot();
    const r = fn(this.project);
    if (before) this.pushUndo(before);
    this.touch(reason);
    return r;
  }

  /** Start a gesture (a drag): its live() changes become one undo step at commit() */
  begin() { if (!this.pending) this.pending = this.snapshot(); }
  live(fn, reason = "edit") { const r = fn(this.project); this.touch(reason, true); return r; }
  commit(reason = "edit") {
    if (this.pending) { this.pushUndo(this.pending); this.pending = null; }
    this.touch(reason);
  }
  cancel() {
    if (this.pending) { this.project = this.pending; this.pending = null; this.touch("undo"); }
  }

  pushUndo(snap) {
    this.undoStack.push(snap);
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  touch(reason, live = false) {
    this.project.updatedAt = Date.now();
    this.ui.dirty = true;
    this.emit("change", { reason, live });
  }

  undo() {
    if (this.locked || !this.undoStack.length) return false; // a recording in progress is one step, taken at its end
    this.redoStack.push(this.snapshot());
    this.project = this.undoStack.pop();
    this.fixSelection();
    this.touch("undo");
    return true;
  }
  redo() {
    if (this.locked || !this.redoStack.length) return false;
    this.undoStack.push(this.snapshot());
    this.project = this.redoStack.pop();
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
  select(patch) { Object.assign(this.ui, patch); this.emit("select", patch); }
}
