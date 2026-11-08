// The transport: plays the arrangement and the session's clips, a step ahead of the audio clock.
//
// Two clocks run while playing: the song beat `s` (the arrangement position, which wraps at the loop) and the global
// beat `g` (beats since play, never wraps: session clips and launch quantization follow it, as in Ableton). Each step
// covers a short window of beats and schedules what falls in it at the AudioContext time it falls at: notes (to the
// instruments' timed queues), clip audio (sample players), automation (AudioParam ramps, instrument parameters) and
// the metronome. The same steps run back to back for an offline render.
import { envAt } from "../util.js";
import { Channel } from "./engine.js";

const STEP = 0.25;        // beats per scheduling step
const LOOKAHEAD = 0.14;   // seconds scheduled ahead of the audio clock
const AUTO_RES = 1 / 16;  // beats between automation points
const EPS = 1e-7;

export class Transport {
  constructor(engine, getProject, { offline = false } = {}) {
    this.engine = engine;
    this.ctx = engine.ctx;
    this.getProject = getProject;
    this.offline = offline;
    this.playing = false;
    this.position = 0;       // song beat while stopped
    this.playStart = 0;
    this.session = new Map(); // trackId -> { playing: {clipId, scene, gStart} | null, queued: {scene, clipId, gAt} | null, follow }
    this.segments = [];
    this.listeners = new Set();
    this.timer = 0;
    this.lastAuto = new Map(); // "track|key" -> last value sent
    this.loopOverride = undefined;
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(what) { for (const fn of this.listeners) fn(what); }

  sess(id) {
    let s = this.session.get(id);
    if (!s) { s = { playing: null, queued: null, follow: true }; this.session.set(id, s); }
    return s;
  }

  get project() { return this.getProject(); }

  // ---- the clocks ----
  /** {g, s} at AudioContext time t (from the steps scheduled so far) */
  beatsAt(t) {
    const segs = this.segments;
    if (!segs.length) return { g: 0, s: this.position };
    if (t < segs[0].t0) { // before the first step (an input recording that began a moment early): the same clock, backwards
      const d = (t - segs[0].t0) / segs[0].spb;
      return { g: segs[0].g0 + d, s: segs[0].s0 + d };
    }
    for (let i = segs.length - 1; i >= 0; i--) {
      const seg = segs[i];
      if (t >= seg.t0) {
        const d = Math.min(seg.len, (t - seg.t0) / seg.spb);
        return { g: seg.g0 + d, s: seg.s0 + d };
      }
    }
    return { g: segs[0].g0, s: segs[0].s0 };
  }
  /** Where the listener is: the audio clock minus the output's latency */
  now() {
    if (!this.playing) return { g: 0, s: this.position };
    const lat = this.ctx.outputLatency || this.ctx.baseLatency || 0;
    return this.beatsAt(this.ctx.currentTime - lat);
  }
  songBeat() { return this.now().s; }
  /** Counting in (playing, the song not reached yet) */
  get inPreroll() { return this.playing && this.prerollEnd !== null && this.prerollEnd !== undefined && this.now().s < this.prerollEnd - 1e-6; }

  // ---- play / stop ----
  /** Play from song beat `from`; countIn: beats of clicks first (the song is silent until `from`) */
  play(from = this.position, { countIn = 0 } = {}) {
    if (this.playing) this.halt();
    const p = this.project;
    this.playing = true;
    this.playStart = from;
    this.prerollEnd = countIn > 0 ? from : null;
    const t = this.ctx.currentTime + 0.05;
    this.nextTime = t; this.nextG = 0; this.nextS = from - countIn;
    this.segments = [];
    this.fresh = new Set(p.tracks.map((x) => x.id));
    this.autoInit = new Set();
    this.lastAuto.clear();
    this.refreshAutomated();
    this.engine.setTempo(p.bpm, true);
    for (const s of this.session.values()) if (s.queued && !(s.queued.gAt > 0)) s.queued.gAt = 0;
    if (!this.offline) {
      this.tick();
      this.timer = setInterval(() => this.tick(), 25);
    }
    this.emit("play");
  }

  halt() {
    clearInterval(this.timer);
    this.timer = 0;
    this.playing = false;
    this.engine.stopAll();
    for (const ch of this.engine.channels.values()) for (const k in ch.params) ch.params[k].cancelScheduledValues(0);
  }

  stop() {
    const was = this.playing;
    if (was) this.halt();
    this.position = was ? this.playStart : 0;
    for (const s of this.session.values()) { s.playing = null; s.queued = null; }
    this.engine.setTempo(this.project.bpm, false);
    this.applyStatic();
    this.emit("stop");
  }

  /** Move the song position (restarts the steps when playing) */
  seek(beat) {
    beat = Math.max(0, beat);
    if (this.playing) {
      this.halt();
      this.play(beat);
    } else {
      this.position = beat;
      this.applyStatic();
      this.emit("seek");
    }
  }

  // ---- the session ----
  quantizedG() {
    const q = this.project.launchQuant;
    const g = Math.max(this.nextG, this.beatsAt(this.ctx.currentTime).g);
    if (!q) return this.nextG;
    return Math.max(this.nextG, Math.ceil((g - EPS) / q) * q);
  }

  launch(trackId, scene) {
    const p = this.project;
    const track = p.tracks.find((t) => t.id === trackId);
    if (!track) return;
    const clipId = track.slots[scene];
    if (!clipId) { this.stopTrack(trackId); return; }
    const s = this.sess(trackId);
    if (!this.playing) {
      s.queued = { scene, clipId, gAt: 0 };
      this.play(this.position);
    } else {
      s.queued = { scene, clipId, gAt: this.quantizedG() };
    }
    this.emit("session");
  }
  launchScene(scene) {
    const p = this.project;
    const wasPlaying = this.playing;
    const gAt = wasPlaying ? this.quantizedG() : 0;
    for (const t of p.tracks) {
      const s = this.sess(t.id);
      const clipId = t.slots[scene];
      if (clipId) s.queued = { scene, clipId, gAt };
      else if (s.playing) s.queued = { scene: -1, clipId: null, gAt };
    }
    if (!wasPlaying) this.play(this.position);
    this.emit("session");
  }
  stopTrack(trackId) {
    const s = this.sess(trackId);
    if (!this.playing) { s.playing = null; s.queued = null; s.follow = false; this.emit("session"); return; }
    s.queued = { scene: -1, clipId: null, gAt: this.quantizedG() };
    this.emit("session");
  }
  stopAllClips() { for (const t of this.project.tracks) if (this.sess(t.id).playing) this.stopTrack(t.id); }
  backToArrangement() {
    for (const s of this.session.values()) {
      s.follow = true;
      if (s.playing && this.playing) s.queued = { scene: -1, clipId: null, gAt: this.nextG, back: true };
      else { s.playing = null; s.queued = null; }
    }
    this.emit("session");
  }
  get overridden() { for (const s of this.session.values()) if (!s.follow) return true; return false; }

  activate(track, s, time) {
    const q = s.queued;
    s.queued = null;
    const ch = this.engine.channel(track.id);
    if (ch) ch.stopSources(time);
    if (q.back) { s.playing = null; s.follow = true; this.fresh.add(track.id); }
    else if (!q.clipId) { s.playing = null; s.follow = false; }
    else { s.playing = { clipId: q.clipId, scene: q.scene, gStart: this.nextG }; s.follow = false; }
    if (!this.offline) setTimeout(() => this.emit("session"), Math.max(0, (time - this.ctx.currentTime) * 1000));
  }

  // ---- the steps ----
  tick() {
    if (!this.playing) return;
    const horizon = this.ctx.currentTime + LOOKAHEAD;
    let n = 0;
    while (this.nextTime < horizon && n++ < 64) this.step();
    for (const ch of this.engine.channels.values()) if (ch.instrument) ch.instrument.flushEvents();
    if (this.segments.length > 96) this.segments.splice(0, this.segments.length - 64);
  }

  loopRange() {
    if (this.loopOverride !== undefined) return this.loopOverride;
    const l = this.project.loop;
    return l.on && l.end > l.start ? l : null;
  }

  step() {
    const p = this.project;
    const spb = 60 / p.bpm;
    const g0 = this.nextG, s0 = this.nextS, t0 = this.nextTime;
    let len = STEP;
    const loop = this.loopRange();
    const looping = loop && s0 < loop.end - EPS;
    if (looping && s0 + len > loop.end) len = loop.end - s0;
    const preroll = this.prerollEnd !== null && this.prerollEnd !== undefined && s0 < this.prerollEnd - EPS;
    if (preroll && s0 + len > this.prerollEnd) len = this.prerollEnd - s0;
    if (!this.offline) {
      for (const t of p.tracks) {
        const s = this.session.get(t.id);
        if (!s || !s.queued) continue;
        if (s.queued.gAt <= g0 + EPS) this.activate(t, s, t0);
        else if (s.queued.gAt < g0 + len) len = s.queued.gAt - g0;
      }
    }
    if (len < EPS) len = EPS;
    if (preroll) this.clicks(s0, len, t0, spb); // the count-in: only the click
    else this.scheduleWindow(g0, s0, len, t0, spb);
    this.segments.push({ t0, g0, s0, len, spb });
    this.nextG = g0 + len;
    this.nextS = s0 + len;
    this.nextTime = t0 + len * spb;
    if (looping && this.nextS >= loop.end - EPS) {
      this.nextS = loop.start;
      for (const t of p.tracks) this.fresh.add(t.id);
    }
  }

  scheduleWindow(g0, s0, len, t0, spb) {
    const p = this.project;
    const loop = this.loopRange();
    const loopCap = loop && s0 < loop.end ? loop.end - s0 : Infinity;
    for (const track of p.tracks) {
      const ch = this.engine.channel(track.id);
      if (!ch) continue;
      const s = this.offline ? null : this.session.get(track.id);
      const fresh = this.fresh.has(track.id);
      if (s && s.playing) {
        const clip = p.clips[s.playing.clipId];
        if (clip) {
          const local = g0 - s.playing.gStart;
          if (clip.loop === false && local >= clip.length) { s.playing = null; s.follow = false; this.emit("session"); }
          else this.span(track, ch, clip, local, len, t0, spb, { remaining: Infinity, regionStart: fresh });
        }
      } else if (!s || s.follow) {
        for (const pl of track.arrangement) {
          const a = Math.max(s0, pl.start), b = Math.min(s0 + len, pl.start + pl.length);
          if (b - a < EPS) continue;
          const clip = p.clips[pl.clipId];
          if (!clip) continue;
          const local = a - pl.start + (pl.offset || 0);
          const tStart = t0 + (a - s0) * spb;
          this.span(track, ch, clip, local, b - a, tStart, spb, {
            remaining: Math.min(pl.start + pl.length - a, loopCap - (a - s0)),
            regionStart: fresh || Math.abs(a - pl.start) < EPS,
          });
        }
      }
      this.fresh.delete(track.id);
      this.automate(track, ch, g0, s0, len, t0, spb, s);
      if (ch.instrument && ch.instrument.wantsClock) this.clock(ch.instrument, g0, len, t0, spb);
    }
    if ((p.metronome || (this.clickWhen && this.clickWhen())) && !this.offline) this.clicks(s0, len, t0, spb);
  }

  clicks(s0, len, t0, spb) {
    if (this.offline) return;
    const sig = this.project.sig || 4;
    for (let b = Math.ceil(s0 - EPS); b < s0 + len - EPS; b++) this.engine.click(t0 + (b - s0) * spb, ((b % sig) + sig) % sig === 0);
  }

  /** MIDI clock (24 per beat, Start at the first) for instruments that follow it */
  clock(inst, g0, len, t0, spb) {
    if (g0 < EPS) inst.midi([0xfa], t0);
    for (let k = Math.ceil(g0 * 24 - EPS); k < (g0 + len) * 24 - EPS; k++) inst.midi([0xf8], t0 + (k / 24 - g0) * spb);
  }

  /** Clip content from clip-local beat `local` for `len` beats, starting at time t */
  span(track, ch, clip, local, len, t, spb, info) {
    const L = clip.length;
    if (L <= 0) return;
    let pos = local, rem = len, remaining = info.remaining, first = true;
    while (rem > EPS) {
      let lp;
      if (clip.loop === false) { if (pos >= L - EPS) break; lp = pos; }
      else lp = ((pos % L) + L) % L;
      if (L - lp < EPS) lp = 0;
      const seg = Math.min(rem, L - lp);
      const regionStart = lp < EPS || (first && info.regionStart);
      if (clip.type === "midi") this.notes(ch, clip, lp, lp + seg, t, spb, remaining);
      else if (regionStart) this.audio(ch, clip, lp, t, spb, Math.min(L - lp, remaining));
      first = false;
      pos += seg; rem -= seg; remaining -= seg; t += seg * spb;
    }
  }

  notes(ch, clip, a, b, t, spb, remaining) {
    const inst = ch.instrument;
    if (!inst) return;
    const notes = clip.notes;
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      if (n.t < a - EPS || n.t >= b - EPS || n.mute) continue;
      let d = Math.min(n.d, clip.length - n.t, remaining - (n.t - a));
      for (let j = 0; j < notes.length; j++) {
        const m = notes[j];
        if (m !== n && m.p === n.p && m.t > n.t + EPS && m.t - n.t < d) d = m.t - n.t;
      }
      if (d <= EPS) continue;
      const on = t + (n.t - a) * spb;
      inst.noteOn(n.p, n.v, on);
      inst.noteOff(n.p, on + d * spb - 0.0005);
    }
  }

  audio(ch, clip, lp, t, spb, beats) {
    const buffer = this.engine.samples.buffer(clip.sampleId);
    if (!buffer || beats <= EPS) return;
    const p = this.project;
    const bufSecPerBeat = clip.warp ? 60 / clip.bpm : spb;
    const offset = (clip.offset || 0) + lp * bufSecPerBeat;
    if (offset >= buffer.duration) return;
    const c = this.ctx;
    const src = c.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = clip.warp ? p.bpm / clip.bpm : 1;
    const g = c.createGain();
    const lvl = clip.gain ?? 1;
    const dur = beats * spb;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(lvl, t + 0.003);
    g.gain.setValueAtTime(lvl, Math.max(t + 0.003, t + dur - 0.004));
    g.gain.linearRampToValueAtTime(0, t + dur);
    src.connect(g).connect(ch.input);
    src.start(t, offset);
    src.stop(t + dur + 0.001);
    const s = ch.addSource(src, t + dur);
    s.gain = g;
  }

  // ---- automation ----
  /** Which lanes of each track have points (their params follow the lanes, not the knobs) */
  refreshAutomated() {
    const p = this.project;
    const map = this.engine.automated;
    map.clear();
    for (const t of p.tracks) {
      const set = new Set();
      for (const k in t.automation) if (t.automation[k] && t.automation[k].length) set.add(k);
      const clipIds = new Set([...t.slots.filter(Boolean), ...t.arrangement.map((pl) => pl.clipId)]);
      for (const id of clipIds) { const c = p.clips[id]; if (c && c.env) for (const k in c.env) if (c.env[k].length) set.add(k); }
      if (set.size) map.set(t.id, set);
    }
  }

  /** A lane's value for a track at global beat g / song beat s: the playing clip's envelope, else the track's lane */
  laneValue(track, key, g, s, sess) {
    const p = this.project;
    let clip = null, local = 0;
    if (sess && sess.playing) {
      clip = p.clips[sess.playing.clipId];
      if (clip) local = ((g - sess.playing.gStart) % clip.length + clip.length) % clip.length;
    } else if (!sess || sess.follow) {
      for (const pl of track.arrangement) {
        if (s >= pl.start && s < pl.start + pl.length) {
          clip = p.clips[pl.clipId];
          if (clip) local = ((s - pl.start + (pl.offset || 0)) % clip.length + clip.length) % clip.length;
          break;
        }
      }
    }
    if (clip && clip.env && clip.env[key] && clip.env[key].length) return envAt(clip.env[key], local);
    const lane = track.automation[key];
    if (lane && lane.length && (!sess || sess.follow)) return envAt(lane, s);
    return null;
  }

  automate(track, ch, g0, s0, len, t0, spb, sess) {
    const keys = this.engine.automated.get(track.id);
    if (!keys) return;
    for (const key of keys) {
      const id = track.id + "|" + key;
      const param = ch.params[key];
      for (let x = 0; x < len + EPS; x += AUTO_RES) {
        const d = Math.min(x, len);
        const v = this.laneValue(track, key, g0 + d, s0 + d, sess);
        if (v === null) continue;
        const time = t0 + d * spb;
        if (param) {
          const val = Channel.laneValue(key, v);
          if (!this.autoInit.has(id)) { param.cancelScheduledValues(time); param.setValueAtTime(val, time); this.autoInit.add(id); }
          else param.linearRampToValueAtTime(val, time);
        } else if (key.startsWith("p:") && ch.instrument) {
          const last = this.lastAuto.get(id);
          if (last === undefined || Math.abs(last - v) > 0.002) {
            this.lastAuto.set(id, v);
            ch.instrument.setNorm(key.slice(2), v, time);
          }
        }
      }
    }
  }

  /** Stopped: automated params take their value at the song position */
  applyStatic() {
    this.refreshAutomated();
    const p = this.project;
    const t = this.ctx.currentTime;
    for (const track of p.tracks) {
      const keys = this.engine.automated.get(track.id);
      const ch = this.engine.channel(track.id);
      if (!keys || !ch) continue;
      for (const key of keys) {
        const v = this.laneValue(track, key, 0, this.position, null);
        if (v === null) continue;
        const param = ch.params[key];
        if (param) { param.cancelScheduledValues(t); param.setValueAtTime(Channel.laneValue(key, v), t); }
        else if (key.startsWith("p:") && ch.instrument) ch.instrument.setNorm(key.slice(2), v, 0);
      }
    }
  }

  // ---- offline ----
  /** Schedule song beats [from, to) from time 0 in one go (an OfflineAudioContext, before startRendering) */
  renderRange(from, to) {
    this.loopOverride = null;
    this.playing = true;
    this.nextTime = 0; this.nextG = 0; this.nextS = from;
    this.segments = [];
    this.fresh = new Set(this.project.tracks.map((x) => x.id));
    this.autoInit = new Set();
    this.lastAuto.clear();
    this.refreshAutomated();
    this.engine.setTempo(this.project.bpm, true);
    while (this.nextS < to - EPS) {
      const before = this.nextS;
      this.step();
      if (this.nextS > to) break;
      if (this.nextS <= before) break;
    }
    for (const ch of this.engine.channels.values()) if (ch.instrument) ch.instrument.flushEvents();
    this.playing = false;
  }
}
