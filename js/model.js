// The project: plain JSON (saved as is in IndexedDB, exported as a file). Times are in beats (quarter notes).
//
// project  { v, id, name, bpm, sig, loop{on,start,end}, metronome, launchQuant, scenes[{name}], tracks[], clips{id:clip},
//            returns[{id,name,type,vol,pan,mute,params}], master{vol} }
// track    { id, name, color, type: "midi"|"audio", instrument{kind, preset, state}, mixer{vol,pan,mute,solo,arm,
//            sendA,sendB,eq{low,mid,high},comp}, slots[clipId|null per scene], arrangement[{id,clipId,start,length,offset}],
//            automation{laneKey:[{t,v}]}, lanes[laneKey shown in the arrangement] }
// clip     midi  { id, type, name, color, length, notes[{p,t,d,v}], env{laneKey:[{t,v}]} }
//          audio { id, type, name, color, length, sampleId, bpm, warp, gain, offset (seconds into the sample), env{} }
// Lane keys: "vol", "pan", "sendA", "sendB" (the mixer) and "p:<param key>" (the instrument). Values are 0..1.
import { uid, UNITY, TRACK_COLORS } from "./util.js";

export const PROJECT_VERSION = 1;
export const SCENES = 8;

export const INSTRUMENT_KINDS = [
  { kind: "drumrack", name: "Drum Rack", short: "DRUM" },
  { kind: "crest", name: "Crest", short: "CRST" },
  { kind: "amino", name: "Amino", short: "AMNO" },
  { kind: "bizar", name: "Bizar", short: "BIZR" },
  { kind: "pro8000v", name: "PRO-8000 V", short: "P8V" },
];
export const kindName = (k) => (INSTRUMENT_KINDS.find((x) => x.kind === k) || { name: k }).name;

export function newProject(name = "Untitled") {
  const now = Date.now();
  return {
    v: PROJECT_VERSION, id: uid("p"), name, bpm: 120, sig: 4,
    loop: { on: false, start: 0, end: 16 }, metronome: false, launchQuant: 4,
    scenes: Array.from({ length: SCENES }, () => ({ name: "" })),
    tracks: [], clips: {},
    returns: [
      { id: "A", name: "Reverb", type: "reverb", vol: UNITY, pan: 0, mute: false, params: { size: 0.55, tone: 0.6 } },
      { id: "B", name: "Delay", type: "delay", vol: UNITY, pan: 0, mute: false, params: { time: 0.75, feedback: 0.38, tone: 0.55 } },
    ],
    master: { vol: UNITY },
    createdAt: now, updatedAt: now,
  };
}

export function newTrack(project, type, kind) {
  const n = project.tracks.length;
  const t = {
    id: uid("t"),
    name: type === "audio" ? "Audio " + (project.tracks.filter((x) => x.type === "audio").length + 1)
      : kind === "drumrack" ? "Drums" : kindName(kind),
    color: TRACK_COLORS[(n * 5) % TRACK_COLORS.length],
    type,
    instrument: type === "audio" ? null : { kind, preset: null, state: kind === "drumrack" ? defaultDrumState() : null },
    mixer: { vol: UNITY, pan: 0, mute: false, solo: false, arm: false, monitor: false, sendA: 0, sendB: 0, eq: { low: 0, mid: 0, high: 0 }, comp: false },
    slots: Array.from({ length: project.scenes.length }, () => null),
    arrangement: [],
    automation: {},
    lanes: [],
  };
  return t;
}

export function newMidiClip(project, track, length = 4, name) {
  const id = uid("c");
  const clip = { id, type: "midi", name: name || track.name, color: track.color, length, notes: [], env: {} };
  project.clips[id] = clip;
  return clip;
}

export function newAudioClip(project, track, sample, bpm) {
  const id = uid("c");
  const beatsAtBpm = sample.duration * (bpm || project.bpm) / 60;
  const length = Math.max(0.25, Math.round(beatsAtBpm * 4) / 4);
  const clip = { id, type: "audio", name: sample.name || "Audio", color: track.color, length,
    sampleId: sample.id, bpm: bpm || project.bpm, warp: !!bpm, gain: 1, offset: 0, env: {} };
  project.clips[id] = clip;
  return clip;
}

/** A guess at a loop's tempo: the bar count (1, 2, 4, 8, 16) that puts it nearest 120 BPM */
export function guessBpm(seconds) {
  let best = null;
  for (const bars of [1, 2, 4, 8, 16]) {
    const bpm = (bars * 4 * 60) / seconds;
    if (bpm < 60 || bpm > 200) continue;
    if (!best || Math.abs(bpm - 120) < Math.abs(best - 120)) best = bpm;
  }
  return best ? Math.round(best * 100) / 100 : null;
}

export const DRUM_BASE_NOTE = 36; // pad 1 = C1 (36), as a Drum Rack

export const BUILTIN_KIT = [
  ["Kick", "kick"], ["Snare", "snare"], ["Closed Hat", "hat"], ["Open Hat", "openhat"],
  ["Clap", "clap"], ["Low Tom", "tomlo"], ["Mid Tom", "tommid"], ["High Tom", "tomhi"],
  ["Rim", "rim"], ["Cowbell", "cowbell"], ["Crash", "crash"], ["Ride", "ride"],
  ["Shaker", "shaker"], ["Clave", "clave"], ["808", "sub"], ["Zap", "zap"],
];

export function defaultDrumState() {
  return {
    pads: BUILTIN_KIT.map(([name, id], i) => ({
      name, sample: "builtin:" + id, gain: 0.8, pan: 0, pitch: 0, decay: 1, start: 0, end: 1, reverse: false,
      choke: i === 2 || i === 3 ? 1 : 0, mute: false,
    })),
  };
}

/** The clip on a track at song beat b in the arrangement, with its placement */
export function placementAt(track, b) {
  for (const pl of track.arrangement) if (b >= pl.start && b < pl.start + pl.length) return pl;
  return null;
}

export function arrangementEnd(project) {
  let end = 0;
  for (const t of project.tracks) for (const pl of t.arrangement) end = Math.max(end, pl.start + pl.length);
  return end;
}

/** Lane keys a track can automate, with their names */
export function laneChoices(track, meta) {
  const out = [{ key: "vol", name: "Volume" }, { key: "pan", name: "Pan" }, { key: "sendA", name: "Send A" }, { key: "sendB", name: "Send B" }];
  if (meta && meta.params) for (const p of meta.params) out.push({ key: "p:" + p.key, name: p.name });
  return out;
}

/** Bring an older or foreign project up to this version's shape (missing fields get their defaults) */
export function migrate(p) {
  const base = newProject(p.name);
  for (const k of Object.keys(base)) if (p[k] === undefined) p[k] = base[k];
  for (const t of p.tracks) {
    const d = newTrack(p, t.type, t.instrument && t.instrument.kind);
    for (const k of Object.keys(d)) if (t[k] === undefined) t[k] = d[k];
    for (const k of Object.keys(d.mixer)) if (t.mixer[k] === undefined) t.mixer[k] = d.mixer[k];
    while (t.slots.length < p.scenes.length) t.slots.push(null);
  }
  for (const id in p.clips) { const c = p.clips[id]; if (!c.env) c.env = {}; if (c.type === "midi" && !c.notes) c.notes = []; }
  p.v = PROJECT_VERSION;
  return p;
}
