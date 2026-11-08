// node tests/transport.test.mjs: the transport's scheduling against a stand-in engine that records what it is asked
// to play. Arrangement timing, clip loops inside a placement, the loop brace, session launches on the bar, automation.
import { Transport } from "../app/js/audio/transport.js";
import { newProject, newTrack, newMidiClip } from "../app/js/model.js";

let failures = 0;
const check = (ok, what) => { if (!ok) { failures++; console.log("  FAIL " + what); } else console.log("  ok   " + what); };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

function rig() {
  const p = newProject("t");
  p.bpm = 120; // 0.5 s per beat
  const t = newTrack(p, "midi", "crest");
  p.tracks.push(t);
  const events = [];
  const inst = {
    noteOn: (n, v, time) => events.push({ k: "on", n, time }),
    noteOff: (n, time) => events.push({ k: "off", n, time }),
    setNorm: (key, v, time) => events.push({ k: "set", key, v, time }),
    flushEvents() {}, tempo() {}, stop() {},
  };
  const ctx = { currentTime: 0, sampleRate: 44100 };
  const ch = { instrument: inst, params: {}, input: {}, stopSources() {}, addSource() { return {}; } };
  const engine = { ctx, channels: new Map([[t.id, ch]]), channel: (id) => (id === t.id ? ch : null), automated: new Map(),
    samples: { buffer: () => null }, setTempo() {}, stopAll() {}, click() {} };
  const tr = new Transport(engine, () => p, { offline: true });
  return { p, t, events, tr, ctx };
}

console.log("arrangement");
{
  const { p, t, events, tr } = rig();
  const c = newMidiClip(p, t, 4);
  c.notes.push({ p: 60, t: 0, d: 1, v: 100 }, { p: 62, t: 2, d: 0.5, v: 100 });
  t.arrangement.push({ id: "a", clipId: c.id, start: 4, length: 8, offset: 0 });
  tr.renderRange(0, 16);
  const ons = events.filter((e) => e.k === "on").map((e) => [e.n, e.time]);
  check(JSON.stringify(ons) === JSON.stringify([[60, 2], [62, 3], [60, 4], [62, 5]]), "notes at their beats, the clip looping in its placement: " + JSON.stringify(ons));
  const off = events.find((e) => e.k === "off" && e.n === 60);
  check(off && near(off.time, 2.4995, 1e-3), "a note ends after its length (" + (off && off.time) + ")");
}

console.log("placement offset and end");
{
  const { p, t, events, tr } = rig();
  const c = newMidiClip(p, t, 4);
  c.notes.push({ p: 60, t: 0, d: 4, v: 100 }, { p: 64, t: 3, d: 2, v: 100 });
  t.arrangement.push({ id: "a", clipId: c.id, start: 0, length: 2, offset: 3 }); // plays clip beats 3..5 (3, then 0 of the loop)
  tr.renderRange(0, 4);
  const ons = events.filter((e) => e.k === "on").map((e) => [e.n, e.time]);
  check(JSON.stringify(ons) === JSON.stringify([[64, 0], [60, 0.5]]), "an offset placement starts inside the clip: " + JSON.stringify(ons));
  const off60 = events.find((e) => e.k === "off" && e.n === 60);
  check(off60 && off60.time <= 1.0 + 1e-6, "a note is cut at the placement's end (" + (off60 && off60.time.toFixed(3)) + ")");
}

console.log("loop brace (real time steps)");
{
  const { p, t, events, tr, ctx } = rig();
  const c = newMidiClip(p, t, 8);
  c.notes.push({ p: 60, t: 0, d: 0.5, v: 100 }, { p: 67, t: 5, d: 0.5, v: 100 });
  t.arrangement.push({ id: "a", clipId: c.id, start: 0, length: 8, offset: 0 });
  p.loop = { on: true, start: 0, end: 4 };
  tr.offline = false;
  tr.play(0);
  clearInterval(tr.timer);
  const t0 = tr.segments.length ? tr.segments[0].t0 : 0.05;
  for (let i = 0; i < 40; i++) tr.step(); // 10 beats
  const ons = events.filter((e) => e.k === "on").map((e) => [e.n, +(e.time - t0).toFixed(4)]);
  check(JSON.stringify(ons) === JSON.stringify([[60, 0], [60, 2], [60, 4]]), "the loop repeats beats 0-4 and skips beat 5: " + JSON.stringify(ons));
  const b = tr.beatsAt(t0 + 2.25);
  check(near(b.s, 0.5, 1e-6) && near(b.g, 4.5, 1e-6), `the song beat wraps, the global one doesn't (s ${b.s}, g ${b.g})`);
  void ctx;
}

console.log("session launch on the bar");
{
  const { p, t, events, tr, ctx } = rig();
  const c = newMidiClip(p, t, 4);
  c.notes.push({ p: 72, t: 0, d: 0.5, v: 100 });
  t.slots[0] = c.id;
  tr.offline = false;
  tr.play(0);
  clearInterval(tr.timer);
  const t0 = 0.05;
  for (let i = 0; i < 5; i++) tr.step(); // 1.25 beats in
  ctx.currentTime = t0 + 1.25 * 0.5;
  tr.launch(t.id, 0);
  for (let i = 0; i < 40; i++) tr.step();
  const ons = events.filter((e) => e.k === "on").map((e) => +(e.time - t0).toFixed(4));
  check(ons[0] === 2 && ons[1] === 4, "the clip starts on the next bar and loops: " + JSON.stringify(ons));
  check(tr.session.get(t.id).follow === false, "the track leaves the arrangement");
  tr.backToArrangement();
  for (let i = 0; i < 4; i++) tr.step();
  check(tr.session.get(t.id).follow === true && !tr.session.get(t.id).playing, "Back to Arrangement returns it");
}

console.log("automation");
{
  const { p, t, events, tr } = rig();
  const c = newMidiClip(p, t, 4);
  t.arrangement.push({ id: "a", clipId: c.id, start: 0, length: 4, offset: 0 });
  t.automation["p:flt_cut"] = [{ t: 0, v: 0 }, { t: 4, v: 1 }];
  tr.renderRange(0, 4);
  const sets = events.filter((e) => e.k === "set");
  const at2 = sets.find((e) => near(e.time, 1.0));
  check(sets.length > 20 && at2 && near(at2.v, 0.5, 1e-6), `an instrument parameter follows its lane (${sets.length} points, ${at2 && at2.v} at beat 2)`);
  c.env["p:flt_cut"] = [{ t: 0, v: 0.25 }];
  events.length = 0;
  tr.renderRange(0, 4);
  const vs = events.filter((e) => e.k === "set" && e.time < 2 - 1e-9).map((e) => e.v); // inside the clip (beats 0-4)
  check(vs.length > 0 && vs.every((v) => near(v, 0.25)), "a clip envelope wins over the track's lane: " + JSON.stringify(vs.slice(0, 5)));
}

console.log("the arrangement comes back");
{
  const { p, t, events, tr, ctx } = rig();
  const a = newMidiClip(p, t, 4), sc = newMidiClip(p, t, 4);
  a.notes.push({ p: 50, t: 0, d: 0.5, v: 100 });
  sc.notes.push({ p: 72, t: 0, d: 0.5, v: 100 }, { p: 74, t: 2, d: 0.5, v: 100 });
  t.arrangement.push({ id: "a", clipId: a.id, start: 0, length: 16, offset: 0 });
  t.slots[0] = sc.id;
  tr.offline = false;
  // a session clip took the track; stop, then play: the arrangement plays again
  tr.launch(t.id, 0);
  clearInterval(tr.timer);
  for (let i = 0; i < 8; i++) tr.step();
  check(tr.session.get(t.id).follow === false, "a launched clip takes the track off the arrangement");
  tr.stop();
  check(tr.session.get(t.id).follow === true, "stopping puts it back on the arrangement");
  // a track stopped in the session while the transport is stopped stays on the arrangement
  tr.stopTrack(t.id);
  events.length = 0;
  tr.play(0);
  clearInterval(tr.timer);
  for (let i = 0; i < 4; i++) tr.step();
  check(events.some((e) => e.k === "on" && e.n === 50), "■ while stopped doesn't silence the arrangement");
  // a left-over override (no clip playing) is cleared by Play
  tr.stop();
  tr.sess(t.id).follow = false;
  events.length = 0;
  tr.play(0);
  clearInterval(tr.timer);
  for (let i = 0; i < 4; i++) tr.step();
  check(events.some((e) => e.k === "on" && e.n === 50), "Play from a stop plays the arrangement");
  // seeking while a session clip plays keeps its place in the clip
  tr.stop();
  tr.launch(t.id, 0);
  clearInterval(tr.timer);
  for (let i = 0; i < 9; i++) tr.step(); // 2.25 beats into the clip
  ctx.currentTime = tr.segments[0].t0 + 2.25 * 0.5;
  tr.seek(8);
  clearInterval(tr.timer);
  events.length = 0;
  for (let i = 0; i < 8; i++) tr.step();
  const ons = events.filter((e) => e.k === "on").map((e) => e.n);
  check(tr.session.get(t.id).playing && ons[0] === 72 && !ons.includes(50), "a seek keeps the session clip going from its place: " + JSON.stringify(ons));
  ctx.currentTime = 0;
}

console.log("count-in");
{
  const { p, t, events, tr } = rig();
  const clicks = [];
  tr.engine.click = (time, accent) => clicks.push([+(time - 0.05).toFixed(4), accent]);
  const c = newMidiClip(p, t, 4);
  c.notes.push({ p: 60, t: 0, d: 0.5, v: 100 });
  t.arrangement.push({ id: "a", clipId: c.id, start: 0, length: 4, offset: 0 });
  tr.offline = false;
  tr.play(0, { countIn: 4 });
  clearInterval(tr.timer);
  for (let i = 0; i < 20; i++) tr.step(); // the bar of count-in, then a bar of song
  const ons = events.filter((e) => e.k === "on").map((e) => +(e.time - 0.05).toFixed(4));
  check(JSON.stringify(ons) === JSON.stringify([2]), "the song starts after a bar of count-in, silent before: " + JSON.stringify(ons));
  const pre = clicks.filter((c) => c[0] < 2 - 1e-6);
  check(pre.length === 4 && pre[0][1] === true && pre.slice(1).every((c) => !c[1]), "four clicks before it, the first accented: " + JSON.stringify(pre));
  check(clicks.every((c) => c[0] < 2 - 1e-6), "no click after it with the metronome off");
  const b = tr.beatsAt(0.05 + 1);
  check(Math.abs(b.s + 2) < 1e-6 && Math.abs(b.g - 2) < 1e-6, `the song beat counts up to 0 (s ${b.s}, g ${b.g})`);
  const before = tr.beatsAt(0.05 - 0.25);
  check(Math.abs(before.s + 4.5) < 1e-6, "the clock runs backwards before the first step (an input that started early): " + before.s);
}

console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
