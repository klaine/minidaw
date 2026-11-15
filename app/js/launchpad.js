// A Novation Launchpad Pro Mk3 as minidaw's grid (where the browser has Web MIDI with SysEx: Chrome and Edge on a
// computer or Android, not Safari on an iPad). The Launchpad is put in its DAW mode, as Ableton Live does:
//   - Session (the Launchpad's Session button): its 8 x 8 pads are the session's clips, a column a track, the top row
//     the first scene. A pad plays or stops its clip; on an armed track an empty pad records there. The buttons on the
//     right launch the scenes, the arrows scroll, Play and Record are the transport's (Shift + Record: Capture).
//     The row under the pads selects tracks; with Record Arm, Mute, Solo or Stop Clip lit (the bottom row) it arms,
//     mutes, solos or stops them instead.
//   - Note, Chord and the Launchpad's own sequencer stay the Launchpad's: they send notes on its MIDI port, which play
//     the armed or selected track as any keyboard does (js/midi.js).
// The protocol, from the Launchpad Pro Mk3 programmer's reference as the Ardour project's driver uses it
// (libs/surfaces/launchpad_pro): three USB ports (MIDI, DIN, DAW); on the DAW port, SysEx F0 00 20 29 02 0E ...:
// 10 01 enters DAW mode (10 00 leaves it), 00 <layout> <page> 00 selects a layout (0: Session; the Launchpad sends
// the same when its layout changes), 03 <type> <led> <data>... lights LEDs (type 0: a palette colour, 1: flashing
// between two, 2: pulsing, 3: RGB, 0-127 each). Pads are notes 11-88 (row * 10 + column, row 1 at the bottom), the
// buttons control changes. Not tried on the hardware here: tests/launchpad.test.mjs and a user flow drive a stand-in.

export const HEADER = [0xf0, 0x00, 0x20, 0x29, 0x02, 0x0e];
export const BTN = {
  shift: 90, left: 91, right: 92, session: 93, note: 94, chord: 95, custom: 96, sequencer: 97, projects: 98,
  up: 80, down: 70, clear: 60, duplicate: 50, quantize: 40, fixedLength: 30, play: 20, record: 10,
  scenes: [89, 79, 69, 59, 49, 39, 29, 19],          // the right column, top to bottom
  tracks: [101, 102, 103, 104, 105, 106, 107, 108],   // the row under the pads
  arm: 1, mute: 2, solo: 3, volume: 4, pan: 5, sends: 6, device: 7, stopClip: 8, // the bottom row
};
// palette colours (pulsing and flashing take these, not RGB)
const RED = 5, GREEN = 21, WHITE = 3;

export const isLaunchpadPro3 = (name) => /LPProMK3|Launchpad Pro MK3/i.test(name || "");
/** The DAW port: "… LPProMK3 DAW" (macOS, Linux), the third "MIDIIN3 / MIDIOUT3 (LPProMK3 MIDI)" on Windows */
export const isDawPort = (name) => isLaunchpadPro3(name) && /DAW|MIDI ?3\b|MIDI(IN|OUT)3/i.test(name || "");

/** The pad at a column (0 left) and row (0 top) of the 8 x 8 */
export const padId = (col, row) => 11 + (7 - row) * 10 + col;
export function padPos(id) {
  const r = Math.floor(id / 10), c = id % 10;
  return r >= 1 && r <= 8 && c >= 1 && c <= 8 ? { col: c - 1, row: 8 - r } : null;
}

/** "#ff6b5b" -> the LED's [r, g, b], 0-127, at a brightness (0..1) */
export function rgb7(hex, level = 1) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || "");
  const c = m ? [m[1], m[2], m[3]].map((x) => parseInt(x, 16)) : [128, 128, 128];
  return c.map((v) => Math.max(0, Math.min(127, Math.round((v / 255) ** 1.6 * 127 * level)))); // LEDs wash out: a curve keeps colours apart
}

export const enterDaw = () => [...HEADER, 0x10, 0x01, 0xf7];
export const leaveDaw = () => [...HEADER, 0x10, 0x00, 0xf7];
export const sessionLayout = () => [...HEADER, 0x00, 0x00, 0x00, 0x00, 0xf7];

/** LED specs ([type, led, ...data]) as SysEx messages, at most 60 LEDs in each */
export function ledMessages(specs) {
  const out = [];
  for (let i = 0; i < specs.length; i += 60) out.push([...HEADER, 0x03, ...specs.slice(i, i + 60).flat(), 0xf7]);
  return out;
}

const off = (led) => [0, led, 0];
const rgb = (led, c) => [3, led, c[0], c[1], c[2]];
const pulse = (led, colour) => [2, led, colour];
const flash = (led, a, b = 0) => [1, led, b, a];

/**
 * Every LED for a view of the session:
 * { tracks: [{ color, arm, mute, solo, selected, playing (a clip of it plays), slots: [null | "clip" | "playing" |
 *   "queued" | "stopping" | "recording" | "countin"] }], scenes (how many), x, y (the scroll), playing, recording,
 *   mode: "select" | "arm" | "mute" | "solo" | "stop" }
 * -> Map(led -> spec)
 */
export function lights(v) {
  const m = new Map();
  const set = (spec) => m.set(spec[1], spec);
  for (let col = 0; col < 8; col++) {
    const t = v.tracks[v.x + col];
    for (let row = 0; row < 8; row++) {
      const led = padId(col, row), scene = v.y + row;
      const st = t && scene < v.scenes ? t.slots[scene] : null;
      if (st === "playing") set(pulse(led, GREEN));
      else if (st === "queued") set(flash(led, GREEN));
      else if (st === "stopping") set(flash(led, WHITE));
      else if (st === "recording") set(pulse(led, RED));
      else if (st === "countin") set(flash(led, RED));
      else if (st === "clip") set(rgb(led, rgb7(t.color, 0.75)));
      else if (t && t.arm && scene < v.scenes) set(rgb(led, [10, 0, 0])); // an armed track's empty slots: a pad records there
      else set(off(led));
    }
    const led = BTN.tracks[col];
    if (!t) set(off(led));
    else if (v.mode === "arm") set(rgb(led, t.arm ? [127, 0, 0] : [14, 0, 0]));
    else if (v.mode === "mute") set(rgb(led, t.mute ? [14, 9, 0] : [127, 80, 0])); // lit: it sounds
    else if (v.mode === "solo") set(rgb(led, t.solo ? [0, 40, 127] : [0, 5, 16]));
    else if (v.mode === "stop") set(rgb(led, t.playing ? [127, 127, 127] : [8, 8, 8]));
    else set(rgb(led, t.selected ? [127, 127, 127] : rgb7(t.color, 0.3)));
  }
  for (let row = 0; row < 8; row++) {
    const scene = v.y + row, led = BTN.scenes[row];
    const any = scene < v.scenes && v.tracks.some((t) => t.slots[scene]);
    set(any ? rgb(led, [28, 28, 28]) : off(led));
  }
  const dim = [16, 16, 16];
  set(v.y > 0 ? rgb(BTN.up, dim) : off(BTN.up));
  set(v.y + 8 < v.scenes ? rgb(BTN.down, dim) : off(BTN.down));
  set(v.x > 0 ? rgb(BTN.left, dim) : off(BTN.left));
  set(v.x + 8 < v.tracks.length ? rgb(BTN.right, dim) : off(BTN.right));
  set(rgb(BTN.play, v.playing ? [0, 127, 0] : [0, 14, 0]));
  set(v.recording ? pulse(BTN.record, RED) : rgb(BTN.record, [14, 0, 0]));
  set(rgb(BTN.arm, v.mode === "arm" ? [127, 0, 0] : [14, 0, 0]));
  set(rgb(BTN.mute, v.mode === "mute" ? [127, 80, 0] : [14, 9, 0]));
  set(rgb(BTN.solo, v.mode === "solo" ? [0, 40, 127] : [0, 5, 16]));
  set(rgb(BTN.stopClip, v.mode === "stop" ? [127, 127, 127] : [10, 10, 10]));
  for (const b of [BTN.volume, BTN.pan, BTN.sends, BTN.device, BTN.clear, BTN.duplicate, BTN.quantize, BTN.fixedLength]) set(off(b));
  return m;
}

/** The specs that differ from what was sent last */
export function changed(next, sent) {
  const out = [];
  for (const [led, spec] of next) { const old = sent.get(led); if (!old || old.join() !== spec.join()) out.push(spec); }
  return out;
}

export class Launchpad {
  constructor(app) {
    this.app = app;
    this.x = 0; this.y = 0;
    this.mode = "select";
    this.shift = false;
    this.sent = new Map();
    this.out = null; this.in = null;
    this.last = 0;
    this.layout = 0;
  }
  get connected() { return !!this.out; }

  /** Take the Launchpad's DAW ports (from a MIDIAccess with SysEx), or let go of it when they're gone */
  attach(input, output) {
    if (this.out === output && this.in === input) return;
    this.detach();
    if (!input || !output) return;
    this.in = input; this.out = output;
    input.onmidimessage = (e) => this.receive(e.data);
    this.send(enterDaw());
    this.send(sessionLayout());
    this.sent = new Map();
    this.refresh(true);
  }
  detach() {
    if (this.out) { try { this.send(leaveDaw()); } catch (_) { /* unplugged */ } }
    if (this.in) this.in.onmidimessage = null;
    this.in = this.out = null;
    this.sent = new Map();
  }
  send(bytes) { try { this.out.send(bytes); } catch (_) { /* a port that just went away */ } }

  /** The session as the Launchpad shows it */
  view() {
    const app = this.app, p = app.store.project, tr = app.transport, rec = app.recording;
    const tracks = p.tracks.map((t) => {
      const s = tr.session.get(t.id);
      const stopping = !!(s && s.queued && s.queued.scene === -1);
      const slots = p.scenes.map((_, i) => {
        const r = rec.slotState(t.id, i);
        if (r) return r === "countin" ? "countin" : "recording";
        if (!t.slots[i]) return null;
        if (s && s.queued && s.queued.scene === i) return "queued";
        if (s && s.playing && s.playing.scene === i && tr.playing) return stopping ? "stopping" : "playing";
        return "clip";
      });
      return { color: t.color, arm: !!t.mixer.arm, mute: !!t.mixer.mute, solo: !!t.mixer.solo, selected: t.id === app.store.ui.selTrack, playing: !!(s && s.playing && tr.playing), slots };
    });
    this.x = Math.max(0, Math.min(this.x, Math.max(0, tracks.length - 1)));
    this.y = Math.max(0, Math.min(this.y, Math.max(0, p.scenes.length - 1)));
    return { tracks, scenes: p.scenes.length, x: this.x, y: this.y, playing: tr.playing, recording: rec.active, mode: this.mode };
  }

  /** Light what changed (called from the app's frame loop; at most 12 times a second) */
  refresh(force = false) {
    if (!this.out || this.layout !== 0) return;
    const now = performance.now();
    if (!force && now - this.last < 80) return;
    this.last = now;
    const next = lights(this.view());
    const specs = changed(next, this.sent);
    if (!specs.length) return;
    for (const msg of ledMessages(specs)) this.send(msg);
    this.sent = next;
  }

  receive(data) {
    const st = data[0] & 0xf0;
    if (data[0] === 0xf0) {
      // the Launchpad's layout changed (its Session, Note, Chord... buttons): back on Session, light it all again
      if (HEADER.every((b, i) => data[i] === b) && data[6] === 0x00) { this.layout = data[7]; if (this.layout === 0) { this.sent = new Map(); this.refresh(true); } }
      return;
    }
    if (st === 0x90 && data[2] > 0) { const pos = padPos(data[1]); if (pos && this.layout === 0) this.pad(pos.col, pos.row); }
    else if (st === 0xb0) this.button(data[1], data[2] > 0);
    this.refresh(true);
  }

  pad(col, row) {
    const app = this.app, p = app.store.project;
    const t = p.tracks[this.x + col], scene = this.y + row;
    if (!t || scene >= p.scenes.length) return;
    if (app.ctx && app.ctx.state !== "running") app.ctx.resume();
    if (app.recording.slotState(t.id, scene)) { app.recording.stop(); return; } // recording there: done
    const clipId = t.slots[scene];
    if (clipId) {
      app.store.select({ selTrack: t.id, selClip: clipId, selSlot: { trackId: t.id, scene } });
      app.transport.toggleClip(t.id, scene);
    } else if (t.mixer.arm) app.recording.recordSlot(t.id, scene);
    else app.transport.stopTrack(t.id); // an empty pad stops its track, as in Live
  }

  button(cc, down) {
    const app = this.app, p = app.store.project, store = app.store;
    if (cc === BTN.shift) { this.shift = down; return; }
    if (!down) return;
    const step = this.shift ? 8 : 1;
    if (cc === BTN.up) this.y = Math.max(0, this.y - step);
    else if (cc === BTN.down) this.y = Math.min(Math.max(0, p.scenes.length - 8), this.y + step);
    else if (cc === BTN.left) this.x = Math.max(0, this.x - step);
    else if (cc === BTN.right) this.x = Math.min(Math.max(0, p.tracks.length - 8), this.x + step);
    else if (cc === BTN.play) app.togglePlay();
    else if (cc === BTN.record) { if (this.shift) app.recording.capture(); else app.recording.toggle(); }
    else if (cc === BTN.arm) this.mode = this.mode === "arm" ? "select" : "arm";
    else if (cc === BTN.mute) this.mode = this.mode === "mute" ? "select" : "mute";
    else if (cc === BTN.solo) this.mode = this.mode === "solo" ? "select" : "solo";
    else if (cc === BTN.stopClip) { if (this.shift) app.transport.stopAllClips(); else this.mode = this.mode === "stop" ? "select" : "stop"; }
    else if (BTN.scenes.includes(cc)) { const scene = this.y + BTN.scenes.indexOf(cc); if (scene < p.scenes.length) app.transport.launchScene(scene); }
    else if (BTN.tracks.includes(cc)) {
      const t = p.tracks[this.x + BTN.tracks.indexOf(cc)];
      if (!t) return;
      const flip = (key) => store.update((pr) => { const m = pr.tracks.find((x) => x.id === t.id).mixer; m[key] = !m[key]; }, "mixer");
      if (this.mode === "arm") flip("arm");
      else if (this.mode === "mute") flip("mute");
      else if (this.mode === "solo") flip("solo");
      else if (this.mode === "stop") app.transport.stopTrack(t.id);
      else store.select({ selTrack: t.id });
    }
  }
}
