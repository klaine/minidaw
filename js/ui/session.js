// The session: a grid of clip slots, a column per track and a row per scene, as Ableton's Session View. Tap a clip's
// ▶ to launch it (on the next bar), its body to open it, an empty slot to select it (to record into, or double tap for
// a new clip), ■ to stop a track, a scene's ▶ to launch the row.
import { h, uid } from "../util.js";
import { gestures } from "./gestures.js";
import { menu, prompt, toast } from "./controls.js";
import { newMidiClip, newAudioClip, guessBpm, INSTRUMENT_KINDS } from "../model.js";
import { placeClip } from "../recording.js";
import { pickSample } from "./browser.js";
import { importMidiToTrack, exportClipMidi } from "./import.js";

export class SessionView {
  constructor(app) {
    this.app = app;
    this.grid = h("div", { class: "ses-grid" });
    this.el = h("section", { class: "view session" }, h("div", { class: "ses-scroll" }, this.grid));
    this.cells = new Map();
  }
  get p() { return this.app.store.project; }

  update(c = {}) {
    if (this.el.hidden) return;
    if (c.reason === "transport" || c.reason === "session") { this.paintStates(); return; }
    if (c.live) return;
    this.render();
  }

  render() {
    const app = this.app, store = app.store, p = this.p;
    this.grid.textContent = "";
    this.cells.clear();
    const cols = p.tracks.length;
    this.grid.style.gridTemplateColumns = `repeat(${cols}, minmax(112px, 1fr)) 104px`;
    // header row
    for (const t of p.tracks) {
      const kind = t.type === "audio" ? "AUDIO" : (INSTRUMENT_KINDS.find((k) => k.kind === t.instrument.kind) || {}).short;
      const head = h("div", { class: "ses-head" + (store.ui.selTrack === t.id ? " sel" : ""), dataset: { track: t.id }, style: { "--tc": t.color } },
        h("div", { class: "ses-head-name" }, t.name), h("div", { class: "ses-head-kind" }, kind));
      gestures(head, {
        tap: () => { store.select({ selTrack: t.id, panel: "device" }); this.render(); },
        longPress: (pos, e) => app.views.arrange.trackMenu(t, { x: e.clientX, y: e.clientY }),
      });
      this.grid.append(head);
    }
    this.grid.append(h("div", { class: "ses-head master" }, h("div", { class: "ses-head-name" }, "Scenes")));
    // slots
    for (let s = 0; s < p.scenes.length; s++) {
      for (const t of p.tracks) this.grid.append(this.slot(t, s));
      const scene = p.scenes[s];
      const sc = h("div", { class: "ses-scene" }, h("span", { class: "ses-play", html: PLAY }), h("span", { class: "ses-scene-name" }, scene.name || String(s + 1)));
      gestures(sc, {
        tap: () => app.transport.launchScene(s),
        doubleTap: async () => { const n = await prompt("Scene name", scene.name || ""); if (n !== null) store.update((p) => { p.scenes[s].name = n; }, "session"); },
        longPress: (pos, e) => menu({ x: e.clientX, y: e.clientY }, [
          { label: "Launch", onClick: () => app.transport.launchScene(s) },
          { label: "Rename…", onClick: async () => { const n = await prompt("Scene name", scene.name || ""); if (n !== null) store.update((p) => { p.scenes[s].name = n; }, "session"); } },
          { label: "Copy the scene to the arrangement at the playhead", onClick: () => this.sceneToArrangement(s) },
          { label: "Insert scene below", onClick: () => store.update((p) => { p.scenes.splice(s + 1, 0, { name: "" }); for (const t of p.tracks) t.slots.splice(s + 1, 0, null); }, "session") },
          { label: "Delete scene", danger: true, disabled: p.scenes.length < 2, onClick: () => store.update((p) => { p.scenes.splice(s, 1); for (const t of p.tracks) t.slots.splice(s, 1); }, "session") },
        ], { title: "Scene " + (s + 1) }),
      });
      this.grid.append(sc);
    }
    // stop row
    for (const t of p.tracks) {
      const stop = h("button", { type: "button", class: "ses-stop", title: "Stop the track's clip", onclick: () => app.transport.stopTrack(t.id), html: STOP });
      this.cells.set(t.id + ":stop", stop);
      this.grid.append(stop);
    }
    this.grid.append(h("div", { class: "ses-stop-all" },
      h("button", { type: "button", class: "btn small", onclick: () => app.transport.stopAllClips() }, "Stop clips"),
      h("button", { type: "button", class: "btn small", onclick: () => store.update((p) => { p.scenes.push({ name: "" }); for (const t of p.tracks) t.slots.push(null); }, "session") }, "+ Scene")));
    this.paintStates();
  }

  slot(t, s) {
    const app = this.app, store = app.store, p = this.p;
    const clipId = t.slots[s];
    const clip = clipId ? p.clips[clipId] : null;
    const selSlot = store.ui.selSlot;
    const isSel = selSlot && selSlot.trackId === t.id && selSlot.scene === s;
    let el;
    if (clip) {
      el = h("div", { class: "ses-slot clip" + (store.ui.selClip === clip.id ? " sel" : "") + (clip.rec ? " recording" : ""), dataset: { track: t.id, scene: s }, style: { "--cc": clip.color || t.color } },
        h("span", { class: "ses-play", html: clip.rec ? REC : PLAY }), h("span", { class: "ses-clip-name" }, clip.name), h("span", { class: "ses-prog" }));
      gestures(el, {
        tap: (pos) => {
          if (app.recording.slotState(t.id, s)) { app.recording.stop(); return; } // recording here: done
          if (pos.x < 38) app.transport.launch(t.id, s);
          else store.select({ selTrack: t.id, selClip: clip.id, selSlot: { trackId: t.id, scene: s }, panel: "clip" }) || this.render();
        },
        doubleTap: () => app.transport.launch(t.id, s),
        longPress: (pos, e) => this.clipMenu(t, s, clip, { x: e.clientX, y: e.clientY }),
      });
    } else {
      el = h("div", { class: "ses-slot empty" + (isSel ? " sel" : "") + (t.mixer.arm ? " armed" : ""), dataset: { track: t.id, scene: s },
        title: t.mixer.arm ? "Tap to record here" : "" }, h("span", { class: "ses-dot" }));
      gestures(el, {
        tap: () => {
          store.select({ selTrack: t.id, selSlot: { trackId: t.id, scene: s }, selClip: null });
          // an armed track's empty slot records (as Ableton's slot record buttons); tapping it again stops
          if (t.mixer.arm || app.recording.slotState(t.id, s)) { app.recording.recordSlot(t.id, s); return; }
          this.render();
        },
        doubleTap: () => this.create(t, s),
        longPress: (pos, e) => menu({ x: e.clientX, y: e.clientY }, [
          t.type === "midi" ? { label: "New MIDI clip", onClick: () => this.create(t, s) } : { label: "Import a sample…", onClick: () => this.create(t, s) },
          t.type === "midi" ? { label: "Import a MIDI file…", onClick: () => importMidiToTrack(app, t.id, { scene: s }) } : null,
          this.clipboard ? { label: "Paste clip", onClick: () => this.paste(t, s) } : null,
          { label: t.mixer.arm ? "Record here" : "Arm the track and record here", onClick: () => { app.recording.recordSlot(t.id, s); } },
          { label: "Arm the track (then tap a slot to record)", disabled: t.mixer.arm, onClick: () => {
            store.update((p) => { p.tracks.find((x) => x.id === t.id).mixer.arm = true; }, "mixer");
            store.select({ selTrack: t.id, selSlot: { trackId: t.id, scene: s } });
            this.render();
          } },
        ], { title: t.name + " · scene " + (s + 1) }),
      });
    }
    this.cells.set(t.id + ":" + s, el);
    return el;
  }

  async create(t, s) {
    const app = this.app, store = app.store;
    if (t.type === "midi") {
      store.update((p) => {
        const tr = p.tracks.find((x) => x.id === t.id);
        const c = newMidiClip(p, tr, 4);
        tr.slots[s] = c.id;
        store.ui.selClip = c.id; store.ui.selTrack = t.id; store.ui.panel = "clip"; store.ui.selSlot = { trackId: t.id, scene: s };
      }, "session");
      return;
    }
    const smp = await pickSample(app, { title: "Sample for " + t.name });
    if (!smp) return;
    store.update((p) => {
      const tr = p.tracks.find((x) => x.id === t.id);
      const c = newAudioClip(p, tr, smp, smp.bpm || guessBpm(smp.duration));
      tr.slots[s] = c.id;
      store.ui.selClip = c.id; store.ui.selTrack = t.id;
    }, "session");
  }

  clipMenu(t, s, clip, at) {
    const app = this.app, store = app.store;
    menu(at, [
      { label: "Launch", onClick: () => app.transport.launch(t.id, s) },
      { label: "Open in editor", onClick: () => store.select({ selTrack: t.id, selClip: clip.id, panel: "clip" }) },
      { label: "Copy to the arrangement at the playhead", onClick: () => {
        const at0 = Math.floor(app.transport.position / 4) * 4;
        store.update((p) => placeClip(p.tracks.find((x) => x.id === t.id), { id: uid("a"), clipId: clip.id, start: at0, length: clip.length, offset: 0 }), "arrange");
        toast("Copied to bar " + (at0 / 4 + 1));
      } },
      { label: "Duplicate into the next empty slot", onClick: () => store.update((p) => {
        const tr = p.tracks.find((x) => x.id === t.id);
        let i = tr.slots.indexOf(null, s + 1);
        if (i < 0) { p.scenes.push({ name: "" }); for (const x of p.tracks) x.slots.push(null); i = tr.slots.length - 1; }
        const c = JSON.parse(JSON.stringify(clip)); c.id = uid("c"); c.name = clip.name; p.clips[c.id] = c; tr.slots[i] = c.id;
      }, "session") },
      { label: "Copy", onClick: () => { this.clipboard = clip.id; toast("Copied: long press an empty slot to paste"); } },
      { label: "Rename…", onClick: async () => { const n = await prompt("Clip name", clip.name); if (n) store.update((p) => { p.clips[clip.id].name = n; }, "clips"); } },
      clip.type === "midi" ? { label: "Save as a MIDI file…", onClick: () => exportClipMidi(app, clip, t) } : null,
      "-",
      { label: "Delete", danger: true, onClick: () => store.update((p) => { p.tracks.find((x) => x.id === t.id).slots[s] = null; }, "session") },
    ], { title: clip.name });
  }

  paste(t, s) {
    const clip = this.p.clips[this.clipboard];
    if (!clip) return;
    if ((clip.type === "audio") !== (t.type === "audio")) { toast("That clip goes on a " + (clip.type === "audio" ? "audio" : "MIDI") + " track"); return; }
    this.app.store.update((p) => { const c = JSON.parse(JSON.stringify(clip)); c.id = uid("c"); p.clips[c.id] = c; p.tracks.find((x) => x.id === t.id).slots[s] = c.id; }, "session");
  }

  sceneToArrangement(s) {
    const app = this.app;
    const at0 = Math.floor(app.transport.position / 4) * 4;
    app.store.update((p) => {
      let len = 0;
      for (const t of p.tracks) { const c = p.clips[t.slots[s]]; if (c) len = Math.max(len, c.length); }
      for (const t of p.tracks) { const c = p.clips[t.slots[s]]; if (c) placeClip(t, { id: uid("a"), clipId: c.id, start: at0, length: len, offset: 0 }); }
    }, "arrange");
    toast("Scene copied to bar " + (at0 / 4 + 1));
  }

  paintStates() {
    const tr = this.app.transport;
    const now = tr.playing ? tr.beatsAt(this.app.ctx.currentTime) : { g: 0 };
    for (const t of this.p.tracks) {
      const s = tr.session.get(t.id);
      for (let i = 0; i < this.p.scenes.length; i++) {
        const el = this.cells.get(t.id + ":" + i);
        if (!el) continue;
        const playing = s && s.playing && s.playing.scene === i && tr.playing;
        const queued = s && s.queued && s.queued.scene === i;
        el.classList.toggle("playing", !!playing);
        el.classList.toggle("queued", !!queued);
        const rs = this.app.recording.slotState(t.id, i);
        el.classList.toggle("recording", !!rs);
        el.classList.toggle("rec-wait", rs === "countin");
      }
      const stop = this.cells.get(t.id + ":stop");
      if (stop) stop.classList.toggle("queued", !!(s && s.queued && s.queued.scene === -1));
      if (stop) stop.classList.toggle("active", !!(s && s.playing));
    }
    void now;
  }

  frame() {
    const tr = this.app.transport, rec = this.app.recording;
    if (rec.active || this.wasRec) { this.paintStates(); this.wasRec = rec.active; }
    if (!tr.playing) return;
    const g = tr.now().g;
    for (const t of this.p.tracks) {
      const s = tr.session.get(t.id);
      if (!s || !s.playing) continue;
      const el = this.cells.get(t.id + ":" + s.playing.scene);
      const clip = this.p.clips[s.playing.clipId];
      if (!el || !clip) continue;
      const prog = el.querySelector(".ses-prog");
      const f = (((g - s.playing.gStart) % clip.length) + clip.length) % clip.length / clip.length;
      if (prog) prog.style.width = (f * 100).toFixed(1) + "%";
    }
    const blink = Math.floor(performance.now() / 250) % 2 === 0;
    this.el.classList.toggle("blink", blink);
  }
}

const PLAY = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
const REC = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="6.5"/></svg>';
const STOP = '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>';
