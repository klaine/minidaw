// The first-start project: a short song in A minor that uses every instrument, in the session and the arrangement.
import { newProject, newTrack, newMidiClip, DRUM_BASE_NOTE } from "./model.js";
import { uid } from "./util.js";

const D = (pad) => DRUM_BASE_NOTE + pad; // drum pads: 0 kick, 1 snare, 2 closed hat, 3 open hat, 4 clap, 12 shaker

function drumClip(p, t, name, bars, rows) {
  const c = newMidiClip(p, t, bars * 4, name);
  for (const [pad, pattern, vel] of rows) {
    for (let i = 0; i < pattern.length; i++) {
      const ch = pattern[i];
      if (ch === ".") continue;
      c.notes.push({ p: D(pad), t: i * 0.25, d: 0.25, v: ch === "X" ? 120 : vel || 96 });
    }
  }
  return c;
}

function place(t, clip, start, length) {
  t.arrangement.push({ id: uid("a"), clipId: clip.id, start, length: length || clip.length, offset: 0 });
}

export function demoProject() {
  const p = newProject("Demo Song");
  p.bpm = 122;
  p.loop = { on: false, start: 0, end: 16 };

  const drums = newTrack(p, "midi", "drumrack");
  const bass = newTrack(p, "midi", "crest"); bass.name = "Bass"; bass.instrument.preset = "Dirty Bass";
  const pad = newTrack(p, "midi", "pro8000v"); pad.name = "Pad"; pad.instrument.preset = "Warm Pad";
  const pluck = newTrack(p, "midi", "bizar"); pluck.name = "Pluck"; pluck.instrument.preset = "PL Deep House Pluck";
  const lead = newTrack(p, "midi", "amino"); lead.name = "Lead"; lead.instrument.preset = "LD Supersaw Lead";
  const tops = newTrack(p, "audio"); tops.name = "Tops";
  p.tracks.push(drums, bass, pad, pluck, lead, tops);
  ["#ff6b5b", "#ffa23a", "#5a8cff", "#3fd6a0", "#e46be0", "#f7d046"].forEach((c, i) => { p.tracks[i].color = c; });
  drums.mixer.vol = 0.72; bass.mixer.vol = 0.66; pad.mixer.vol = 0.6; pad.mixer.sendA = 0.45;
  pluck.mixer.vol = 0.58; pluck.mixer.sendB = 0.45; pluck.mixer.pan = -0.15; lead.mixer.vol = 0.5; lead.mixer.sendA = 0.3; lead.mixer.sendB = 0.3;
  tops.mixer.vol = 0.5; tops.mixer.pan = 0.2;

  // drums
  const beatA = drumClip(p, drums, "Beat A", 1, [
    [0, "X...x...x...x..."], [4, "....x.......x..."], [2, "..x...x...x...x.", 80], [12, "x.x.x.x.x.x.x.x.", 50],
  ]);
  const beatB = drumClip(p, drums, "Beat B", 2, [
    [0, "X...x...x...x...X...x...x...x.x."], [1, "....x.......x.......x.......x.xx"], [2, "xxx.xxx.xxx.xxx.xxx.xxx.xxx.xxx.", 70],
    [3, "..x...x...x...x...x...x...x...x."],
  ]);
  const fill = drumClip(p, drums, "Fill", 1, [[0, "X.......x......."], [1, "....x...x.x.xxxx"], [5, "..........x....."], [6, "...........x...."], [7, "............x..."]]);

  // A minor: Am F C G, one bar each
  const chords = [[57, 60, 64], [53, 57, 60], [55, 60, 64], [55, 59, 62]];
  const roots = [45, 41, 48, 43];
  const bassClip = newMidiClip(p, bass, 16, "Bassline");
  roots.forEach((r, bar) => {
    for (let i = 0; i < 8; i++) {
      const oct = i % 4 === 3 ? 12 : 0;
      bassClip.notes.push({ p: r - 12 + oct, t: bar * 4 + i * 0.5 + 0.0, d: 0.4, v: i % 2 ? 90 : 110 });
    }
  });
  const padClip = newMidiClip(p, pad, 16, "Chords");
  chords.forEach((c, bar) => c.forEach((n) => padClip.notes.push({ p: n, t: bar * 4, d: 3.9, v: 90 })));
  const pluckClip = newMidiClip(p, pluck, 16, "Arp");
  chords.forEach((c, bar) => {
    const seq = [c[0], c[1], c[2], c[1] + 12, c[2], c[0] + 12, c[1], c[2] + 12];
    seq.forEach((n, i) => pluckClip.notes.push({ p: n + 12, t: bar * 4 + i * 0.5, d: 0.35, v: 80 + (i % 2 ? 0 : 20) }));
  });
  const leadClip = newMidiClip(p, lead, 16, "Hook");
  [[76, 0, 1.5], [74, 1.5, 0.5], [72, 2, 1], [69, 3, 1], [72, 4, 1.5], [74, 5.5, 0.5], [72, 6, 2],
   [71, 8, 1.5], [72, 9.5, 0.5], [74, 10, 1], [76, 11, 1], [79, 12, 1.5], [76, 13.5, 0.5], [74, 14, 2]]
    .forEach(([n, t, d]) => leadClip.notes.push({ p: n, t, d, v: 100 }));
  // a clip envelope: the pluck's filter opens across the clip (Bizar's cutoff), as an example of automation
  pluckClip.env["p:cutoff"] = [{ t: 0, v: 0.35 }, { t: 8, v: 0.75 }, { t: 15.75, v: 0.45 }];

  const topsClip = { id: uid("c"), type: "audio", name: "Percussion Tops", color: tops.color, length: 4, sampleId: "builtin:loop-tops", bpm: 120, warp: true, gain: 0.9, offset: 0, env: {} };
  p.clips[topsClip.id] = topsClip;

  // session: scenes Intro, Groove, Full, Break
  p.scenes[0].name = "Intro"; p.scenes[1].name = "Groove"; p.scenes[2].name = "Full"; p.scenes[3].name = "Break";
  drums.slots[0] = beatA.id; drums.slots[1] = beatA.id; drums.slots[2] = beatB.id; drums.slots[3] = fill.id;
  pad.slots[0] = padClip.id; pad.slots[1] = padClip.id; pad.slots[2] = padClip.id; pad.slots[3] = padClip.id;
  bass.slots[1] = bassClip.id; bass.slots[2] = bassClip.id;
  pluck.slots[1] = pluckClip.id; pluck.slots[2] = pluckClip.id; pluck.slots[3] = pluckClip.id;
  lead.slots[2] = leadClip.id;
  tops.slots[1] = topsClip.id; tops.slots[2] = topsClip.id;

  // arrangement: 32 bars
  for (let b = 0; b < 8; b++) place(drums, beatA, b * 4);
  place(drums, fill, 28);
  for (let b = 0; b < 6; b++) place(drums, beatB, 32 + b * 8);
  place(drums, fill, 124);
  place(pad, padClip, 0, 128);
  place(bass, bassClip, 32, 96);
  place(pluck, pluckClip, 16, 112);
  place(lead, leadClip, 64, 64);
  place(tops, topsClip, 32, 96);
  // track automation: the pad fades in over the first eight bars
  pad.automation.vol = [{ t: 0, v: 0.2 }, { t: 32, v: 0.6 }];
  pad.lanes = ["vol"];
  p.loop = { on: false, start: 32, end: 64 };
  return p;
}
