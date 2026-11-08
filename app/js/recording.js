// Recording, as in Ableton:
//
//   Arrangement   Record on the armed tracks from the song position. From a stop it counts in first (Count-in: off,
//                 1 or 2 bars; a note played just before the downbeat lands on it). Replace (the default) makes a new
//                 clip that grows bar by bar as you play and replaces what it covers; with the loop on it covers the
//                 loop and every pass overdubs into it. Overdub plays into the clips already there instead.
//   Session       Tap an armed track's empty slot (or select it and press Record): it records from the next bar
//                 (after the count-in from a stop), free length (until you tap it again or press Record) or a fixed
//                 1, 2, 4 or 8 bars, then plays on as a loop. Armed tracks with a playing clip overdub into it.
//   Audio         Arming an audio track opens the input (its level shows on the track, Monitor plays it through);
//                 the take starts exactly at the record point, its input latency taken off.
//   Capture       Everything played on the keys is kept: Capture turns what you just played into a clip, even when
//                 nothing was recording (in time if the transport ran, at the song tempo if not).
//
// Notes appear in their clip while you play (a held note grows), Quantize snaps the take's notes when it ends, and a
// whole take is one undo step.
import { newMidiClip, newAudioClip } from "./model.js";
import { uid, h } from "./util.js";
import { Capture, openInput } from "./audio/recorder.js";
import { encodeWav } from "./audio/wav.js";
import { toast } from "./ui/controls.js";

const PREFS_KEY = "minidaw.rec";
export const REC_DEFAULTS = { countIn: 1, clickRec: true, quantize: 0, overdub: false, sessionBars: 0 };
const PICKUP = 0.25;     // beats: a note this early lands on the first beat of the take
const HISTORY_S = 180;   // seconds of playing kept for Capture
const PHRASE_GAP_S = 4;  // a pause this long ends a phrase (for Capture, when stopped)
const r3 = (x) => Math.round(x * 1000) / 1000;

export class Recording {
  constructor(app) {
    this.app = app;
    this.prefs = { ...REC_DEFAULTS };
    try { Object.assign(this.prefs, JSON.parse(localStorage.getItem(PREFS_KEY) || "{}")); } catch (_) { /* private mode */ }
    this.state = "idle";       // idle | countin | rec
    this.takes = new Map();    // trackId -> take
    this.held = new Map();     // trackId|note -> held note
    this.taken = new Map();    // the notes recorded in this take -> their clip (for Quantize)
    this.leftovers = new Map(); // trackId -> [{p, s, d, v}] (overdub where no clip was)
    this.history = [];         // everything played live, for Capture
    this.lastCapture = 0;
    this.input = null;
    this.monitors = new Map(); // trackId -> GainNode (input monitoring)
    app.transport.clickWhen = () => this.active && this.prefs.clickRec;
  }

  get transport() { return this.app.transport; }
  get store() { return this.app.store; }
  get active() { return this.state !== "idle"; }
  setPref(k, v) {
    this.prefs[k] = v;
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(this.prefs)); } catch (_) { /* private mode */ }
  }
  sig() { return this.store.project.sig || 4; }
  /** {s, g} the listener hears now (what a note played now belongs to) */
  heard(t = this.app.ctx.currentTime) {
    const lat = this.app.ctx.outputLatency || this.app.ctx.baseLatency || 0;
    return this.transport.beatsAt(t - lat);
  }

  // ---- start and stop ----
  toggle() { return this.active ? this.stop() : this.start(); }

  /** Record into session slot `scene` of a track (tapping an armed empty slot); tapping it again stops */
  recordSlot(trackId, scene) {
    const take = this.takes.get(trackId);
    if (this.active && take && take.kind === "session" && take.scene === scene) return this.stop();
    if (this.active) return this.stop();
    return this.start({ slot: { trackId, scene } });
  }

  async start({ slot } = {}) {
    const app = this.app, store = this.store, tr = this.transport, p = store.project;
    if (this.active) return;
    if (slot) {
      const t = store.track(slot.trackId);
      if (t && !t.mixer.arm) store.update((p) => { p.tracks.find((x) => x.id === t.id).mixer.arm = true; }, "mixer");
    }
    let armed = p.tracks.filter((t) => t.mixer.arm);
    if (!armed.length) {
      const sel = store.selectedTrack;
      if (!sel) { toast("Arm a track (●) to record on it"); return; }
      store.update((p) => { p.tracks.find((t) => t.id === sel.id).mixer.arm = true; }, "mixer");
      armed = [store.track(sel.id)];
    }
    if (!slot && store.ui.view === "session" && store.ui.selSlot) {
      const ss = store.ui.selSlot, t = store.track(ss.trackId);
      if (t && t.mixer.arm && !t.slots[ss.scene]) slot = ss;
    }
    this.snap = store.snapshot();
    store.locked = true;
    this.takes.clear(); this.held.clear(); this.taken.clear(); this.leftovers.clear();
    this.audioTake = null;
    this.content = false;
    const sig = this.sig();
    const playing = tr.playing;
    const countIn = playing ? 0 : (this.prefs.countIn | 0) * sig;
    this.mode = slot ? "session" : "arrange";
    if (this.mode === "session") {
      if (!playing) tr.play(tr.position, { countIn });
      this.startG = playing ? tr.quantizedG() : countIn;
      this.startS = null;
      const t = store.track(slot.trackId);
      if (t.type === "midi") {
        const bars = this.prefs.sessionBars | 0;
        store.update((p) => {
          const x = p.tracks.find((q) => q.id === t.id);
          const c = newMidiClip(p, x, bars ? bars * sig : sig, "Recorded");
          c.rec = true;
          x.slots[slot.scene] = c.id;
          if (store.ui.selTrack === t.id) store.ui.selClip = c.id;
          this.takes.set(t.id, { kind: "session", trackId: t.id, scene: slot.scene, clipId: c.id, startG: this.startG, fixed: bars * sig });
        }, "session");
        const sess = tr.sess(t.id);
        sess.queued = { scene: slot.scene, clipId: this.takes.get(t.id).clipId, gAt: this.startG };
        tr.emit("session");
      } else {
        this.audioTake = { kind: "session", trackIds: [t.id], scene: slot.scene, startG: this.startG, fixed: (this.prefs.sessionBars | 0) * sig };
      }
    } else {
      this.startS = playing ? tr.songBeat() : tr.position;
      if (!playing) tr.play(tr.position, { countIn });
      this.startG = playing ? tr.now().g : countIn;
      const audio = armed.filter((t) => t.type === "audio");
      if (audio.length) this.audioTake = { kind: "arrange", trackIds: audio.map((t) => t.id), startS: this.startS, startG: this.startG };
    }
    this.state = playing && this.mode === "arrange" ? "rec" : "countin";
    this.waitTotal = this.mode === "arrange" ? countIn : this.startG - (playing ? tr.now().g : 0);
    if (this.audioTake) await this.startAudio();
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), 40);
    app.topbar.update();
    if (store.ui.view === "session") app.views.session.render();
  }

  /** Punch out: what was recorded stays (the transport keeps playing) */
  async stop() {
    if (!this.active) return;
    const store = this.store, tr = this.transport;
    clearInterval(this.timer);
    const wasCounting = this.state === "countin";
    this.state = "idle";
    const now = this.heard();
    for (const [key, hn] of this.held) this.release(key, hn, now);
    this.held.clear();
    let audio = null;
    if (this.audioCap) {
      const cap = this.audioCap;
      this.audioCap = null;
      audio = { chans: await cap.stop(), t0: cap.startTime };
      cap.dispose();
    }
    store.live(() => {
      const p = store.project;
      for (const take of this.takes.values()) this.finish(p, take, now, wasCounting);
      this.placeLeftovers(p);
      this.quantize();
      for (const c of Object.values(p.clips)) if (c.rec) delete c.rec;
    }, "clips");
    if (audio && this.audioTake && !wasCounting) await this.audioClips(audio, now);
    this.takes.clear();
    this.taken.clear();
    store.locked = false;
    if (this.content) store.pushUndo(this.snap);
    this.snap = null;
    store.touch("clips");
    this.app.topbar.update();
    this.syncInputs();
  }

  /** A take's end: its final length (whole bars), or gone if nothing was played into it */
  finish(p, take, now, cancelled) {
    const clip = p.clips[take.clipId];
    const sig = this.sig();
    const tr = this.transport;
    if (take.kind === "session") {
      const t = p.tracks.find((x) => x.id === take.trackId);
      const sess = tr.sess(take.trackId);
      if (!clip || !clip.notes.length || cancelled) {
        if (t && t.slots[take.scene] === take.clipId) t.slots[take.scene] = null;
        delete p.clips[take.clipId];
        // the track was playing this take: it goes back to the arrangement, not to a session clip that isn't there
        if (sess.playing && sess.playing.clipId === take.clipId) { sess.playing = null; sess.follow = true; if (tr.fresh) tr.fresh.add(take.trackId); }
        if (sess.queued && sess.queued.clipId === take.clipId) sess.queued = null;
        tr.emit("session");
        return;
      }
      if (!take.fixed) clip.length = Math.max(sig, Math.ceil((now.g - take.startG) / sig - 0.05) * sig);
      for (const n of clip.notes) if (n.t + n.d > clip.length) n.d = Math.max(0.05, clip.length - n.t);
      this.content = true;
    } else if (clip) {
      const t = p.tracks.find((x) => x.id === take.trackId);
      const pl = t && t.arrangement.find((x) => x.id === take.plId);
      if (pl && take.grow) {
        const len = Math.max(sig, Math.ceil((now.s - pl.start) / sig - 0.05) * sig);
        if (now.s >= pl.start) { pl.length = len; clip.length = len; }
      }
      this.content = this.content || clip.notes.length > 0;
    }
  }

  // ---- the takes while recording ----
  tick() {
    if (!this.active) return;
    const tr = this.transport, store = this.store;
    if (!tr.playing) { this.stop(); return; }
    const now = this.heard();
    if (this.state === "countin") {
      const started = this.mode === "arrange" ? now.s >= this.startS - 1e-6 : now.g >= this.startG - 1e-6;
      if (started) { this.state = "rec"; this.app.topbar.update(); }
      else return;
    }
    const sig = this.sig();
    let changed = false;
    const p = store.project;
    for (const take of this.takes.values()) {
      const clip = p.clips[take.clipId];
      if (!clip) continue;
      if (take.kind === "session") {
        if (take.fixed) {
          if (now.g >= take.startG + take.fixed - 1e-6) { this.finishFixed(take); return; }
        } else {
          // ahead of what the transport has scheduled, so the growing clip never wraps round to its start
          const len = Math.max(sig, Math.ceil((tr.nextG - take.startG + 0.5) / sig) * sig);
          if (len > clip.length) { clip.length = len; changed = true; }
        }
      } else if (take.grow) {
        const t = p.tracks.find((x) => x.id === take.trackId);
        const pl = t && t.arrangement.find((x) => x.id === take.plId);
        if (pl && tr.nextS >= pl.start) {
          const len = Math.max(sig, Math.ceil((tr.nextS - pl.start + 0.5) / sig) * sig);
          if (len > pl.length) { this.grow(t, pl, clip, len); changed = true; }
        }
      }
    }
    if (this.audioTake && this.audioTake.kind === "session" && this.audioTake.fixed && now.g >= this.audioTake.startG + this.audioTake.fixed - 1e-6) { this.stop(); return; }
    // held notes grow
    for (const hn of this.held.values()) {
      if (!hn.note) continue;
      const d = Math.min(hn.maxD, Math.max(0.05, now.g - hn.g));
      if (Math.abs(d - hn.note.d) > 0.02) { hn.note.d = r3(d); changed = true; }
    }
    if (changed) store.live(() => {}, "notes");
  }

  /** A fixed-length session take is done: it plays on as a loop, and the recording ends when nothing else records */
  finishFixed(take) {
    const others = [...this.takes.values()].filter((t) => t !== take);
    if (!others.length) { this.stop(); return; }
    const now = this.heard();
    for (const [key, hn] of this.held) if (hn.trackId === take.trackId) { this.release(key, hn, now); this.held.delete(key); }
    this.store.live((p) => { this.finish(p, take, now, false); const c = p.clips[take.clipId]; if (c) delete c.rec; }, "clips");
    this.takes.delete(take.trackId);
  }

  /** A replace take grows: longer, cutting what it now covers */
  grow(t, pl, clip, len) {
    pl.length = len;
    clip.length = len;
    t.arrangement = t.arrangement.filter((x) => x !== pl);
    placeClip(t, pl);
  }

  /** The take for a track in the arrangement (made at its first note, so an empty pass replaces nothing) */
  arrangeTake(track, s) {
    const store = this.store, p = store.project, sig = this.sig();
    let take = this.takes.get(track.id);
    if (take) return take;
    const loop = p.loop.on && p.loop.end > p.loop.start && this.startS >= p.loop.start - 1e-6 && this.startS < p.loop.end ? p.loop : null;
    const start = loop ? loop.start : Math.floor(Math.max(s, this.startS) / sig + 1e-6) * sig;
    const length = loop ? loop.end - loop.start : Math.max(sig, Math.ceil((s - start) / sig + 1e-6) * sig);
    const t = p.tracks.find((x) => x.id === track.id);
    const c = newMidiClip(p, t, length, "Recorded");
    c.rec = true;
    const pl = { id: uid("a"), clipId: c.id, start, length, offset: 0 };
    placeClip(t, pl);
    if (store.ui.selTrack === t.id) store.ui.selClip = c.id;
    take = { kind: "arrange", trackId: t.id, clipId: c.id, plId: pl.id, grow: !loop, start, loop: !!loop };
    this.takes.set(t.id, take);
    return take;
  }

  /** Where a note at {s, g} on a track goes: {clip, t, maxD}, "leftover" (overdub with no clip there), or null */
  target(track, b) {
    const p = this.store.project, tr = this.transport;
    if (this.state === "countin") {
      // only a pickup just before the downbeat counts
      const early = this.mode === "arrange" ? this.startS - b.s : this.startG - b.g;
      if (early > PICKUP) return null;
      b = { s: this.startS ?? b.s, g: this.startG };
      if (this.mode === "arrange") b.s = this.startS;
    }
    const take = this.takes.get(track.id);
    if (take && take.kind === "session") {
      const clip = p.clips[take.clipId];
      if (!clip) return null;
      const local = Math.max(0, b.g - take.startG);
      const t = take.fixed ? local % clip.length : local;
      return { clip, t, maxD: take.fixed ? clip.length - t : Infinity };
    }
    const sess = tr.session.get(track.id);
    if (sess && sess.playing) {
      const clip = p.clips[sess.playing.clipId];
      if (!clip || clip.type !== "midi") return null;
      const t = (((b.g - sess.playing.gStart) % clip.length) + clip.length) % clip.length;
      return { clip, t, maxD: clip.length - t };
    }
    if (this.mode !== "arrange" || (sess && !sess.follow)) return null;
    const s = Math.max(b.s, this.startS);
    if (!this.prefs.overdub) {
      const tk = this.arrangeTake(track, s);
      const t = p.tracks.find((x) => x.id === track.id);
      const pl = t.arrangement.find((x) => x.id === tk.plId);
      const clip = p.clips[tk.clipId];
      if (!pl || !clip) return null;
      const local = tk.loop ? ((s - pl.start) % pl.length + pl.length) % pl.length : Math.max(0, s - pl.start);
      return { clip, t: local, maxD: tk.loop ? pl.length - local : Infinity };
    }
    const t = p.tracks.find((x) => x.id === track.id);
    for (const pl of t.arrangement) {
      if (s >= pl.start && s < pl.start + pl.length) {
        const clip = p.clips[pl.clipId];
        if (!clip || clip.type !== "midi") continue;
        const local = ((s - pl.start + (pl.offset || 0)) % clip.length + clip.length) % clip.length;
        return { clip, t: local, maxD: Math.min(clip.length - local, pl.start + pl.length - s) };
      }
    }
    return "leftover";
  }

  // ---- notes ----
  /** Every note played live (the keys, MIDI, the pads) on a track */
  note(track, on, n, vel) {
    const tr = this.transport, ctx = this.app.ctx;
    const b = tr.playing ? this.heard() : null;
    this.remember(track, on, n, vel, ctx.currentTime, b);
    if (!this.active || !track.mixer.arm || track.type !== "midi" || !b) return;
    const key = track.id + "|" + n;
    if (on) {
      if (this.held.has(key)) this.release(key, this.held.get(key), b);
      let tg = null;
      this.store.live(() => {
        tg = this.target(track, b);
        if (!tg) return;
        if (tg === "leftover") { this.held.set(key, { trackId: track.id, leftover: true, p: n, s: Math.max(b.s, this.startS), g: b.g, v: vel }); return; }
        const note = { p: n, t: r3(tg.t), d: 0.05, v: vel };
        tg.clip.notes.push(note);
        this.taken.set(note, tg.clip);
        this.content = true;
        this.held.set(key, { trackId: track.id, note, clip: tg.clip, g: Math.max(b.g, this.state === "countin" ? this.startG : b.g), maxD: tg.maxD });
      }, "notes");
      return;
    }
    const hn = this.held.get(key);
    if (!hn) return;
    this.held.delete(key);
    this.store.live(() => this.release(key, hn, b), "notes");
  }

  release(key, hn, b) {
    const d = Math.max(0.05, b.g - hn.g);
    if (hn.leftover) {
      const list = this.leftovers.get(hn.trackId) || [];
      list.push({ p: hn.p, s: hn.s, d, v: hn.v });
      this.leftovers.set(hn.trackId, list);
      return;
    }
    hn.note.d = r3(Math.min(hn.maxD, d));
  }

  /** Overdub notes that fell where no clip was: a new clip of whole bars around them */
  placeLeftovers(p) {
    const sig = this.sig();
    for (const [id, list] of this.leftovers) {
      const t = p.tracks.find((x) => x.id === id);
      if (!t || !list.length) continue;
      const start = Math.floor(Math.min(...list.map((n) => n.s)) / sig) * sig;
      const end = Math.max(start + sig, Math.ceil(Math.max(...list.map((n) => n.s + n.d)) / sig) * sig);
      const c = newMidiClip(p, t, end - start, "Recorded");
      c.notes = list.map((n) => ({ p: n.p, t: r3(n.s - start), d: r3(n.d), v: n.v }));
      for (const n of c.notes) this.taken.set(n, c);
      placeClip(t, { id: uid("a"), clipId: c.id, start, length: end - start, offset: 0 });
      this.content = true;
    }
    this.leftovers.clear();
  }

  /** Record quantize: the take's notes' starts snap to the grid (applied when it ends, so nothing plays twice) */
  quantize() {
    const q = this.prefs.quantize;
    if (!q) return;
    for (const [n, clip] of this.taken) {
      n.t = Math.max(0, r3(Math.round(n.t / q) * q));
      if (n.t >= clip.length - 1e-6) n.t = 0; // the loop's end is its start
    }
  }

  // ---- Capture ----
  remember(track, on, n, vel, time, b) {
    const hist = this.history;
    // notes that went into a take are recorded already: Capture leaves them out
    if (on) hist.push({ trackId: track.id, p: n, v: vel, t: time, d: null, b, rec: this.active && track.mixer.arm });
    else for (let i = hist.length - 1; i >= 0; i--) { const e = hist[i]; if (e.trackId === track.id && e.p === n && e.d === null) { e.d = Math.max(0.03, time - e.t); break; } }
    while (hist.length && (hist.length > 4000 || time - hist[0].t > HISTORY_S)) hist.shift();
  }
  /** Notes Capture would take: on the tracks the keys play (else any), not recorded, since the last Capture */
  capturable() {
    const fresh = this.history.filter((e) => e.t > this.lastCapture && !e.rec);
    const targets = new Set(this.app.liveTargets().map((t) => t.id));
    const mine = fresh.filter((e) => targets.has(e.trackId));
    return mine.length ? mine : fresh;
  }
  get canCapture() { return this.capturable().length > 0; }

  /** What you just played, as a clip on the track you played it on */
  capture() {
    const app = this.app, store = this.store, tr = this.transport, ctx = app.ctx;
    const now = ctx.currentTime;
    let notes = this.capturable();
    if (!notes.length) { toast("Play something first: Capture keeps what you played, even when nothing was recording"); return; }
    // the last phrase: back from the newest note to a long pause
    let i = notes.length - 1;
    while (i > 0 && notes[i].t - (notes[i - 1].t + (notes[i - 1].d ?? 0)) < PHRASE_GAP_S) i--;
    notes = notes.slice(i);
    const timed = notes.every((e) => e.b); // played with the transport running: in its time
    const p = store.project, sig = p.sig || 4, spb = 60 / p.bpm;
    const byTrack = new Map();
    for (const e of notes) { if (!byTrack.has(e.trackId)) byTrack.set(e.trackId, []); byTrack.get(e.trackId).push(e); }
    const session = store.ui.view === "session";
    let made = 0, lastClip = null, lastTrack = null;
    store.update((p) => {
      for (const [id, list] of byTrack) {
        const t = p.tracks.find((x) => x.id === id);
        if (!t || t.type !== "midi") continue;
        const dur = (e) => (e.d ?? Math.max(0.05, now - e.t)) / spb;
        let ev, start;
        if (timed) {
          const key = session ? "g" : "s";
          start = Math.floor(Math.min(...list.map((e) => e.b[key])) / sig + 1e-6) * sig;
          ev = list.map((e) => ({ p: e.p, t: r3(e.b[key] - start), d: r3(dur(e)), v: e.v }));
        } else {
          const t0 = list[0].t;
          ev = list.map((e) => ({ p: e.p, t: r3((e.t - t0) / spb), d: r3(dur(e)), v: e.v }));
          start = Math.floor(tr.position / sig) * sig;
        }
        const len = Math.max(sig, Math.ceil(Math.max(...ev.map((n) => n.t + n.d)) / sig - 0.02) * sig);
        const c = newMidiClip(p, t, len, "Captured");
        c.notes = ev.map((n) => ({ ...n, d: Math.min(n.d, len - n.t) }));
        if (session) {
          const sel = store.ui.selSlot && store.ui.selSlot.trackId === t.id ? store.ui.selSlot.scene : 0;
          let i = t.slots.indexOf(null, sel);
          if (i < 0) i = t.slots.indexOf(null);
          if (i < 0) { p.scenes.push({ name: "" }); for (const x of p.tracks) x.slots.push(null); i = t.slots.length - 1; }
          t.slots[i] = c.id;
        } else placeClip(t, { id: uid("a"), clipId: c.id, start, length: len, offset: 0 });
        made++; lastClip = c.id; lastTrack = t.id;
      }
      if (lastClip) { store.ui.selTrack = lastTrack; store.ui.selClip = lastClip; store.ui.panel = "clip"; }
    }, "clips");
    this.lastCapture = now;
    if (made) toast(`Captured ${notes.length} note${notes.length === 1 ? "" : "s"}` + (timed ? "" : ` at ${p.bpm} BPM`));
  }

  // ---- audio ----
  /** The input is open while an audio track is armed: its level shows, Monitor plays it through the track */
  async syncInputs() {
    const p = this.store.project, engine = this.app.engine;
    const armed = p.tracks.filter((t) => t.type === "audio" && t.mixer.arm);
    if (this.opening) await this.opening; // already opening (Record right after arming): wait for it
    if (armed.length && !this.input) {
      let done;
      this.opening = new Promise((r) => { done = r; });
      try {
        this.input = await openInput(this.app.ctx);
        this.inputAnalyser = this.app.ctx.createAnalyser();
        this.inputAnalyser.fftSize = 512;
        this.input.src.connect(this.inputAnalyser);
        this.app.views.panel.update({ reason: "mixer" });
      } catch (e) {
        toast("No audio input: " + (e.message || e), 4000);
      }
      this.opening = null;
      done();
    }
    if (!armed.length && this.input && !this.audioCap) {
      for (const g of this.monitors.values()) g.disconnect();
      this.monitors.clear();
      this.input.close();
      this.input = null;
      return;
    }
    if (!this.input) return;
    for (const t of p.tracks) {
      const want = t.type === "audio" && t.mixer.arm && t.mixer.monitor;
      const has = this.monitors.get(t.id);
      const ch = engine.channel(t.id);
      if (want && !has && ch) {
        const g = this.app.ctx.createGain();
        this.input.src.connect(g).connect(ch.input);
        this.monitors.set(t.id, g);
      } else if (!want && has) { has.disconnect(); this.monitors.delete(t.id); }
    }
  }
  inputPeak() { return this.inputAnalyser ? this.app.engine.peak(this.inputAnalyser) : 0; }

  async startAudio() {
    await this.syncInputs();
    if (!this.input) { this.audioTake = null; return; }
    this.audioCap = new Capture(this.app.ctx, this.input.src, 2);
    await this.audioCap.start();
  }

  /** The recorded audio as clips: trimmed to start on the record point, the input's latency taken off */
  async audioClips({ chans, t0 }, now) {
    const app = this.app, store = this.store, take = this.audioTake;
    const sr = app.ctx.sampleRate, spb = 60 / store.project.bpm, sig = this.sig();
    const lat = (app.ctx.outputLatency || app.ctx.baseLatency || 0) + (this.input ? this.input.latency : 0);
    const b0 = this.transport.beatsAt(t0 - lat);
    const drop = Math.round((take.kind === "session" ? take.startG - b0.g : take.startS - b0.s) * spb * sr);
    const trimmed = chans.map((c) => c.subarray(Math.max(0, drop)));
    if (trimmed[0].length < sr * 0.05) return;
    const buffer = new AudioBuffer({ length: trimmed[0].length, numberOfChannels: trimmed.length, sampleRate: sr });
    trimmed.forEach((c, i) => buffer.copyToChannel(c, i));
    const name = "Audio " + new Date().toLocaleTimeString();
    const id = await app.samples.addBuffer(buffer, name, encodeWav(trimmed, sr, 16));
    const beats = buffer.duration / spb;
    store.live((p) => {
      for (const tid of take.trackIds) {
        const t = p.tracks.find((x) => x.id === tid);
        if (!t) continue;
        const c = newAudioClip(p, t, { id, name, duration: buffer.duration }, p.bpm);
        c.warp = true;
        if (take.kind === "session") {
          c.length = take.fixed || Math.max(sig, Math.ceil(beats / sig - 0.05) * sig);
          t.slots[take.scene] = c.id;
          const sess = this.transport.sess(t.id);
          if (this.transport.playing) { sess.playing = { clipId: c.id, scene: take.scene, gStart: take.startG }; sess.follow = false; }
        } else {
          c.length = Math.max(0.25, Math.round(beats * 16) / 16);
          placeClip(t, { id: uid("a"), clipId: c.id, start: r3(take.startS), length: c.length, offset: 0 });
        }
        store.ui.selClip = c.id;
      }
    }, "clips");
    this.content = true;
    void now;
  }

  /** Where audio is being recorded in the arrangement (drawn on the timeline while it runs) */
  audioRegion(trackId) {
    const a = this.audioTake;
    if (this.state !== "rec" || !a || a.kind !== "arrange" || !a.trackIds.includes(trackId)) return null;
    return { start: a.startS, end: this.heard().s };
  }
  /** Is this session slot being recorded into (or about to be)? */
  slotState(trackId, scene) {
    if (!this.active) return null;
    const take = this.takes.get(trackId);
    if (take && take.kind === "session" && take.scene === scene) return this.state;
    const a = this.audioTake;
    if (a && a.kind === "session" && a.scene === scene && a.trackIds.includes(trackId)) return this.state;
    return null;
  }

  // ---- the count-in display ----
  frame() {
    if (!this.overlay) {
      this.ovNum = h("div", { class: "ci-num" });
      this.ovLabel = h("div", { class: "ci-label" });
      this.ovDots = h("div", { class: "ci-dots" });
      this.overlay = h("div", { class: "countin", hidden: true }, this.ovLabel, this.ovNum, this.ovDots,
        h("button", { type: "button", class: "btn small", onclick: () => (this.transport.inPreroll ? this.app.stop() : this.stop()) }, "Cancel"));
      document.body.append(this.overlay);
    }
    const show = this.state === "countin" && this.transport.playing;
    this.overlay.hidden = !show;
    if (!show) return;
    const now = this.heard();
    const left = this.mode === "arrange" ? this.startS - now.s : this.startG - now.g;
    const beats = Math.max(1, Math.ceil(left - 1e-6));
    const label = this.transport.inPreroll ? "Count-in" : "Recording from the next bar";
    if (this.ovNum.textContent !== String(beats)) {
      this.ovNum.textContent = String(beats);
      this.ovNum.classList.remove("pop"); void this.ovNum.offsetWidth; this.ovNum.classList.add("pop");
    }
    if (this.ovLabel.textContent !== label) this.ovLabel.textContent = label;
    const sig = this.sig();
    const dots = Math.max(1, Math.min(16, Math.ceil(this.waitTotal - 1e-6) || sig));
    if (this.ovDots.childElementCount !== dots) { this.ovDots.textContent = ""; for (let i = 0; i < dots; i++) this.ovDots.append(h("span")); }
    [...this.ovDots.children].forEach((d, i) => d.classList.toggle("on", i < dots - beats + 1));
  }
}

/** Put a placement on a track, cutting what it covers (as recording or dropping a clip in Ableton does) */
export function placeClip(track, pl) {
  const out = [];
  const a = pl.start, b = pl.start + pl.length;
  for (const o of track.arrangement) {
    const oa = o.start, ob = o.start + o.length;
    if (ob <= a || oa >= b) { out.push(o); continue; }
    if (oa < a) out.push({ ...o, length: a - oa });
    if (ob > b) out.push({ ...o, id: uid("a"), start: b, length: ob - b, offset: (o.offset || 0) + (b - oa) });
  }
  out.push(pl);
  out.sort((x, y) => x.start - y.start);
  track.arrangement = out;
}
