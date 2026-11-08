// Recording onto tracks, as in Ableton:
//   - arrangement: the armed tracks record from the song position when Record starts; MIDI into a new clip there
//     (notes from every loop pass overdub into the loop's range), audio from the input into an audio clip;
//   - session: a selected empty slot on an armed track records from the next bar and, when you stop, becomes a clip
//     of whole bars that keeps playing; a playing clip on an armed track takes notes as overdub.
import { newMidiClip, newAudioClip } from "./model.js";
import { uid } from "./util.js";
import { Capture, openInput } from "./audio/recorder.js";
import { encodeWav } from "./audio/wav.js";
import { toast } from "./ui/controls.js";

export class Recording {
  constructor(app) {
    this.app = app;
    this.active = false;
    this.mode = null;
    this.notes = new Map(); // trackId -> [{p, t, d, v, g}]
    this.held = new Map();  // trackId|note -> {p, s, g, v}
  }

  get transport() { return this.app.transport; }

  async start() {
    const app = this.app, store = app.store, p = store.project;
    const armed = p.tracks.filter((t) => t.mixer.arm);
    if (!armed.length) {
      const sel = store.selectedTrack;
      if (sel) { store.update((p) => { p.tracks.find((t) => t.id === sel.id).mixer.arm = true; }, "mixer"); armed.push(sel); }
      else { toast("Arm a track to record on it"); return; }
    }
    this.notes.clear();
    this.held.clear();
    this.overdub = new Map();
    const slot = store.ui.selSlot;
    if (store.ui.view === "session" && slot) {
      const t = p.tracks.find((x) => x.id === slot.trackId);
      if (t && t.mixer.arm && !t.slots[slot.scene]) {
        this.mode = "session";
        this.slot = slot;
        if (!this.transport.playing) this.transport.play();
        this.startG = this.transport.quantizedG();
        this.active = true;
        if (t.type === "audio") await this.startAudio([t]);
        app.topbar.update();
        return;
      }
    }
    this.mode = "arrange";
    this.startS = this.transport.playing ? this.transport.songBeat() : this.transport.position;
    if (!this.transport.playing) this.transport.play();
    this.active = true;
    const audioTracks = armed.filter((t) => t.type === "audio");
    if (audioTracks.length) await this.startAudio(audioTracks);
    app.topbar.update();
  }

  async startAudio(tracks) {
    try {
      this.input = await openInput(this.app.ctx);
    } catch (e) {
      toast("No audio input: " + (e.message || e), 4000);
      return;
    }
    this.capture = new Capture(this.app.ctx, this.input.src, 2);
    this.audioTracks = tracks.map((t) => t.id);
    const t0 = await this.capture.start();
    const lat = (this.app.ctx.outputLatency || this.app.ctx.baseLatency || 0) + this.input.latency;
    const b = this.transport.beatsAt(t0 - lat);
    this.audioStartS = b.s;
    this.audioStartG = b.g;
  }

  /** A live note (from the keys or MIDI) on a track */
  note(track, on, n, vel) {
    if (!this.active || !track.mixer.arm || track.type !== "midi") return;
    const lat = this.app.ctx.outputLatency || this.app.ctx.baseLatency || 0;
    const b = this.transport.beatsAt(this.app.ctx.currentTime - lat);
    const key = track.id + "|" + n;
    if (on) this.held.set(key, { p: n, s: b.s, g: b.g, v: vel });
    else {
      const h = this.held.get(key);
      if (!h) return;
      this.held.delete(key);
      const list = this.notes.get(track.id) || [];
      list.push({ p: n, s: h.s, g: h.g, v: h.v, d: Math.max(0.05, b.g - h.g) });
      this.notes.set(track.id, list);
      this.overdubNote(track, list[list.length - 1]);
    }
  }

  /** Into a playing session clip right away (so the loop plays it back next time round) */
  overdubNote(track, n) {
    const sess = this.transport.session.get(track.id);
    if (!sess || !sess.playing || (this.mode === "session" && this.slot.trackId === track.id)) return;
    const clip = this.app.store.project.clips[sess.playing.clipId];
    if (!clip || clip.type !== "midi") return;
    const t = ((n.g - sess.playing.gStart) % clip.length + clip.length) % clip.length;
    this.app.store.update(() => { clip.notes.push({ p: n.p, t: round(t), d: round(n.d), v: n.v }); }, "notes");
    n.done = true;
  }

  async stop() {
    if (!this.active) return;
    this.active = false;
    const app = this.app, store = app.store;
    const nowB = this.transport.now();
    // notes still held end now
    for (const [key, hd] of this.held) {
      const id = key.split("|")[0];
      const list = this.notes.get(id) || [];
      list.push({ p: hd.p, s: hd.s, g: hd.g, v: hd.v, d: Math.max(0.05, nowB.g - hd.g) });
      this.notes.set(id, list);
    }
    this.held.clear();
    let audio = null;
    if (this.capture) {
      const chans = await this.capture.stop();
      this.capture.dispose();
      this.input.close();
      this.capture = null;
      audio = chans;
    }
    const p = store.project;
    if (this.mode === "session") {
      const t = p.tracks.find((x) => x.id === this.slot.trackId);
      const bars = Math.max(1, Math.ceil((nowB.g - this.startG) / 4 - 0.02));
      if (t && t.type === "midi") {
        const notes = (this.notes.get(t.id) || []).filter((n) => n.g >= this.startG - 0.25);
        store.update((p) => {
          const c = newMidiClip(p, t, bars * 4, "Recorded");
          c.notes = notes.map((n) => ({ p: n.p, t: round(Math.max(0, n.g - this.startG) % (bars * 4)), d: round(n.d), v: n.v }));
          p.tracks.find((x) => x.id === t.id).slots[this.slot.scene] = c.id;
          store.ui.selClip = c.id;
          const sess = this.transport.sess(t.id);
          if (this.transport.playing) { sess.playing = { clipId: c.id, scene: this.slot.scene, gStart: this.startG }; sess.follow = false; }
        }, "clips");
      } else if (t && audio) {
        await this.audioClip(t, audio, { slot: this.slot.scene, bars });
      }
    } else {
      for (const [id, list] of this.notes) {
        const t = p.tracks.find((x) => x.id === id);
        const fresh = list.filter((n) => !n.done);
        if (!t || !fresh.length) continue;
        const loop = p.loop.on ? p.loop : null;
        const minS = Math.min(...fresh.map((n) => n.s));
        const maxS = Math.max(...fresh.map((n) => n.s + n.d));
        const start = loop && minS >= loop.start - 0.5 ? loop.start : Math.floor(Math.min(this.startS, minS) / 4) * 4;
        const end = loop && maxS <= loop.end + 0.5 ? loop.end : Math.max(start + 4, Math.ceil(maxS / 4) * 4);
        store.update((p) => {
          const tr = p.tracks.find((x) => x.id === id);
          const c = newMidiClip(p, tr, end - start, "Recorded");
          c.notes = fresh.map((n) => ({ p: n.p, t: round(Math.max(0, n.s - start)), d: round(Math.min(n.d, end - n.s)), v: n.v }));
          placeClip(tr, { id: uid("a"), clipId: c.id, start, length: end - start, offset: 0 });
          store.ui.selClip = c.id;
        }, "clips");
      }
      if (audio) for (const id of this.audioTracks || []) {
        const t = p.tracks.find((x) => x.id === id);
        if (t) await this.audioClip(t, audio, { start: this.audioStartS });
      }
    }
    this.notes.clear();
    app.topbar.update();
  }

  async audioClip(track, chans, { slot, start, bars }) {
    const app = this.app, store = app.store;
    const sr = app.ctx.sampleRate;
    // the part before the song position the recording belongs at is the input's latency: drop it
    if (!chans[0].length) return;
    const buffer = new AudioBuffer({ length: chans[0].length, numberOfChannels: chans.length, sampleRate: sr });
    chans.forEach((c, i) => buffer.copyToChannel(c, i));
    const name = "Rec " + new Date().toLocaleTimeString();
    const id = await app.samples.addBuffer(buffer, name, encodeWav(chans, sr, 16));
    store.update((p) => {
      const t = p.tracks.find((x) => x.id === track.id);
      const c = newAudioClip(p, t, { id, name, duration: buffer.duration }, p.bpm);
      c.warp = true;
      if (bars) c.length = bars * 4;
      if (slot !== undefined) t.slots[slot] = c.id;
      else placeClip(t, { id: uid("a"), clipId: c.id, start: Math.max(0, round(start)), length: c.length, offset: 0 });
      store.ui.selClip = c.id;
    }, "clips");
  }
}

const round = (x) => Math.round(x * 1000) / 1000;

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
