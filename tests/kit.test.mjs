// node tests/kit.test.mjs: drums sorted by their sound (sounds synthesized here, and the app's built-in kit), the
// automatic kit (random picks that still fit their pads, seeded), tidying (trim and level), a pad rendered as it plays,
// and the Ableton exports: Move's preset JSON in the shape of Move's own kits, Live's Drum Rack XML.
import { readFileSync } from "node:fs";
import { soundFeatures, roleOfSound, tidyPad } from "../app/js/kitsound.js";
import { buildKit, seeded, ROLES } from "../app/js/kitmap.js";
import { builtinSound } from "../app/js/audio/samples.js";
import { renderPad, movePreset, liveRackXml, padDb, fileSafe } from "../app/js/ableton/kit.js";

let failures = 0;
const check = (ok, what) => { if (!ok) { failures++; console.log("  FAIL " + what); } else console.log("  ok   " + what); };
const R = 44100;

// ---- sounds made here: a kick's falling sine, noise for snares and cymbals, sines for toms, squares for a cowbell
let seed = 1;
const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
const make = (secs, fn, lead = 0) => { const n = Math.round((secs + lead) * R), x = new Float32Array(n); for (let i = Math.round(lead * R); i < n; i++) x[i] = fn(i / R - lead); return x; };
const highpass = (x, fc) => { const a = 1 - Math.exp((-2 * Math.PI * fc) / R); let s = 0; return x.map((v) => { s += a * (v - s); return v - s; }); };
const SOUNDS = {
  kick: make(0.4, (t) => Math.sin(2 * Math.PI * (50 * t + 3 * (1 - Math.exp(-t / 0.03)))) * Math.exp(-t / 0.12)),
  sub: make(1.2, (t) => Math.sin(2 * Math.PI * 48 * t) * Math.exp(-t / 0.5)),
  snare: make(0.25, (t) => (0.6 * noise() + 0.5 * Math.sin(2 * Math.PI * 190 * t)) * Math.exp(-t / 0.05)),
  hat: highpass(make(0.08, (t) => noise() * Math.exp(-t / 0.015)), 7000),
  openhat: highpass(make(0.6, (t) => noise() * Math.exp(-t / 0.12)), 7000),
  crash: highpass(make(2.5, (t) => noise() * Math.exp(-t / 0.4)), 5000),
  tomlo: make(0.5, (t) => Math.sin(2 * Math.PI * 90 * t) * Math.exp(-t / 0.12)),
  tomhi: make(0.4, (t) => Math.sin(2 * Math.PI * 220 * t) * Math.exp(-t / 0.08)),
  cowbell: make(0.3, (t) => (Math.sign(Math.sin(2 * Math.PI * 560 * t)) + Math.sign(Math.sin(2 * Math.PI * 845 * t))) * 0.5 * Math.exp(-t / 0.06)),
  clave: make(0.05, (t) => Math.sin(2 * Math.PI * 2500 * t) * Math.exp(-t / 0.008)),
  shaker: highpass(make(0.9, (t) => noise() * 0.3 * Math.sin((Math.PI * t) / 0.9)), 2500),
};

console.log("drums by their sound");
{
  const wrong = Object.entries(SOUNDS).map(([want, x]) => [want, roleOfSound(soundFeatures([x], R))]).filter(([a, b]) => a !== b);
  check(!wrong.length, "synthesized drums: " + (wrong.length ? wrong.map(([a, b]) => `${a} heard as ${b}`).join(", ") : Object.keys(SOUNDS).join(", ")));
  const kit = ["kick", "snare", "hat", "openhat", "clap", "tommid", "tomhi", "rim", "cowbell", "crash", "ride", "clave", "sub"];
  const off = kit.map((k) => [k, roleOfSound(soundFeatures([builtinSound(k)], R))]).filter(([a, b]) => a !== b);
  check(!off.length, "the built-in kit's one-shots: " + (off.length ? off.map(([a, b]) => `${a} heard as ${b}`).join(", ") : kit.length + " of them"));
  check(roleOfSound(soundFeatures([new Float32Array(4410)], R)) === null && soundFeatures([new Float32Array(10)], R) === null, "silence is nothing");
  const late = soundFeatures([make(0.3, (t) => Math.sin(2 * Math.PI * 50 * t) * Math.exp(-t / 0.1), 0.05)], R);
  check(Math.abs(late.lead - 0.049) < 0.002 && roleOfSound(late) === "kick", "a kick 50 ms in: found where it starts (" + late.lead.toFixed(4) + " s)");
  const stereo = soundFeatures([SOUNDS.snare, SOUNDS.snare.map((v) => -v * 0.5)], R);
  check(roleOfSound(stereo) === "snare", "stereo: both channels heard");
}

console.log("tidying");
{
  const loud = soundFeatures([SOUNDS.kick], R), softer = soundFeatures([SOUNDS.kick.map((v) => v * 0.7)], R), quiet = soundFeatures([SOUNDS.kick.map((v) => v * 0.1)], R);
  const a = tidyPad(loud, "kick"), b = tidyPad(softer, "kick"), c = tidyPad(quiet, "kick");
  check(Math.abs(a.gain * 1.25 * loud.peak - 0.891) < 0.01, "a loud kick peaks at -1 dB (gain " + a.gain + ")");
  check(Math.abs(b.gain * 0.7 - a.gain) < 0.003, "a softer one gets as much more level as it lacks (" + b.gain + ")");
  check(c.gain === 1.25, "a very quiet one: up to the knob's top");
  const h = tidyPad(soundFeatures([SOUNDS.hat], R), "hat");
  check(Math.abs(20 * Math.log10(h.gain * 1.25 * soundFeatures([SOUNDS.hat], R).peak) + 5) < 0.2, "cymbals sit 4 dB lower");
  const late = soundFeatures([make(0.3, (t) => Math.sin(2 * Math.PI * 50 * t) * Math.exp(-t / 0.1), 0.1)], R);
  const t = tidyPad(late, "kick");
  check(Math.abs(t.start * 0.4 - 0.099) < 0.002, "the silence before it trimmed: start " + t.start);
  check(tidyPad(soundFeatures([SOUNDS.kick], R), "kick").start === 0, "nothing trimmed when it starts at once");
  check(Object.keys(tidyPad(null, "kick")).length === 0 && Object.keys(tidyPad({ peak: 0, dur: 0 }, "kick")).length === 0, "a silent or unheard sample is left as it is");
}

console.log("the automatic kit");
{
  // three kicks, two snares, hats and an unnamed one heard as a clap
  const names = ["A/Kick 1", "A/Kick 2", "B/Kick 3", "A/Snare 1", "B/Snare 2", "A/Hat", "A/Open Hat", "B/Sample 7"];
  const samples = names.map((p, i) => ({ id: "s" + i, name: p.split("/")[1], path: p }));
  const heard = { s7: "clap" };
  const roleOf = (s) => (s.id in heard ? heard[s.id] : null) || ({ Kick: "kick", Snare: "snare", Hat: "hat", Open: "openhat" })[s.name.split(" ")[0]];
  const kits = Array.from({ length: 40 }, (_, k) => buildKit(samples, { roleOf, rng: seeded(k + 1) }));
  const at = (kit, role) => kit[ROLES.indexOf(role)] && kit[ROLES.indexOf(role)].name;
  check(kits.every((k) => /^Kick/.test(at(k, "kick")) && /^Snare/.test(at(k, "snare")) && at(k, "hat") === "Hat" && at(k, "openhat") === "Open Hat"), "every roll puts kicks, snares and hats on their pads");
  check(kits.every((k) => at(k, "clap") === "Sample 7"), "the sample its sound named a clap is on the clap pad");
  check(new Set(kits.map((k) => at(k, "kick"))).size === 3, "the kick pad sees each of the three kicks over 40 rolls");
  check(kits.every((k) => /^Kick/.test(at(k, "sub")) && at(k, "sub") !== at(k, "kick")), "the 808 pad gets another kick");
  const again = buildKit(samples, { roleOf, rng: seeded(5) });
  check(JSON.stringify(again) === JSON.stringify(kits[4]), "the same seed, the same kit");
  check(kits.every((k) => k.filter(Boolean).length === 8 && new Set(k.filter(Boolean).map((p) => p.id)).size === 8), "each sample on one pad");
  check(buildKit(samples, { roleOf })[0].name === "Kick 1", "without dice: the first kick");
  check(kits[0][ROLES.indexOf("clap")].role === "clap", "each pad says its sample's role");
}

console.log("a pad as it plays");
{
  const ramp = new Float32Array(1000).map((_, i) => i / 1000);
  const plain = renderPad([ramp], R, { start: 0, end: 1, decay: 1 });
  check(plain[0].length === 1000 && plain[0][999] === ramp[999], "untouched: the whole sample");
  const trim = renderPad([ramp], R, { start: 0.25, end: 0.75, decay: 1 });
  check(trim[0].length === 500 && Math.abs(trim[0][0] - 0.25) < 1e-6, "trimmed: start to end (" + trim[0].length + " samples)");
  check(trim[0][trim[0].length - 1] < 0.01, "a trimmed end fades out (no click)");
  const rev = renderPad([ramp], R, { start: 0, end: 0.5, reverse: true, decay: 1 });
  check(Math.abs(rev[0][0] - 0.999) < 1e-6 && rev[0].length === 500, "reversed: the trim is of the reversed sample, as the rack plays it");
  const long = new Float32Array(R).fill(0.5);
  const dec = renderPad([long, long], R, { start: 0, end: 1, decay: 0.5 });
  const hold = Math.round(R * 0.25);
  check(dec.length === 2 && dec[0][hold - 1] === 0.5 && dec[0].length === hold + Math.round(0.04 * R), "decay: held for decay² of it, then 40 ms down (" + dec[0].length + ")");
  check(dec[1][dec[1].length - 1] < 0.02, "and it ends at nothing");
  const up = renderPad([long], R, { start: 0, end: 1, decay: 0.5, pitch: 12 });
  check(up[0].length === hold + Math.round(0.08 * R), "pitched up an octave, the 40 ms fade is of twice as many samples (it plays twice as fast)");
}

console.log("Ableton Move's preset");
{
  const pads = Array.from({ length: 16 }, (_, i) => ({ name: "Pad " + (i + 1), sample: "s" + i, gain: 0.8, pan: 0, pitch: 0, decay: 1, choke: i === 2 || i === 3 ? 1 : 0, mute: i === 9 }));
  pads[0].gain = 0.4; pads[1].pan = -0.5; pads[4].pitch = -3;
  const cells = pads.map((pad, i) => (i < 14 ? { pad, file: `${String(i + 1).padStart(2, "0")} Pad ${i + 1}.wav` } : null));
  const p = movePreset(cells);
  check(p.kind === "instrumentRack" && p.$schema.includes("devicePreset") && p.chains.length === 1, "an Instrument Rack preset");
  const [rack, sat] = p.chains[0].devices;
  check(rack.kind === "drumRack" && sat.kind === "saturator" && p.chains[0].devices.length === 2, "holding a Drum Rack, then one effect");
  check(rack.returnChains.length === 1 && rack.returnChains[0].devices.length === 1 && rack.returnChains[0].devices[0].kind === "reverb", "one return chain with one effect");
  check(rack.chains.length === 16 && rack.chains.every((c, i) => c.drumZoneSettings.receivingNote === 36 + i && c.devices[0].kind === "drumCell"), "16 Drum Sampler pads on notes 36 to 51");
  const cell = (i) => rack.chains[i].devices[0];
  check(cell(0).deviceData.sampleUri === "Samples/01%20Pad%201.wav" && cell(15).deviceData.sampleUri === null, "samples by their path in the bundle; empty pads have none");
  check(Math.abs(cell(0).parameters.Volume - (-18.0206)) < 0.001 && cell(1).parameters.Volume === -12, "levels: the default pad at Move's -12 dB, half its level 6 dB under (" + cell(0).parameters.Volume + ")");
  check(cell(1).parameters.Pan === -0.5 && cell(4).parameters.Voice_Transpose === -3, "pan and pitch");
  check(rack.chains[2].drumZoneSettings.chokeGroup === 1 && rack.chains[0].drumZoneSettings.chokeGroup === null, "choke groups: the hats share one, the rest none");
  check(rack.chains[9].mixer.speakerOn === false && rack.chains[0].mixer.speakerOn === true, "a muted pad is off");
  check(cell(0).parameters.Voice_Envelope_Hold === 60 && cell(0).parameters.Voice_PlaybackLength === 1, "each sample plays to its end (trim and decay are in its WAV)");
  check(Object.keys(cell(0).parameters).length === 43, "every Drum Sampler parameter Move's kits have (" + Object.keys(cell(0).parameters).length + ")");
  check(padDb({ gain: 1.25 }) < 0 && padDb({ gain: 0 }) === -36, "levels stay in range");
  check(fileSafe("Kit: “808” / beats?") === "Kit 808 beats" && fileSafe("") === "Kit", "file names: safe characters only");
}

console.log("Ableton Live's Drum Rack");
{
  const rackTpl = readFileSync(new URL("../app/js/ableton/live-rack.xml", import.meta.url), "utf8");
  const padTpl = readFileSync(new URL("../app/js/ableton/live-pad.xml", import.meta.url), "utf8");
  const pads = Array.from({ length: 16 }, (_, i) => ({ name: i === 0 ? "Kick & <Co>" : "Pad " + (i + 1), gain: 0.8, pan: 0, pitch: i === 1 ? 2 : 0, choke: i === 2 ? 1 : 0, mute: i === 3 }));
  const cells = pads.map((pad, i) => (i < 12 ? { pad, file: `${i + 1} Pad.wav`, frames: 1000 + i, rate: 44100, size: 3044 } : null));
  const xml = liveRackXml(rackTpl, padTpl, cells, { now: 1.7e12 });
  check(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<Ableton MajorVersion="5"') && xml.includes("<GroupDevicePreset>") && xml.includes("<DrumGroupDevice"), "a Live Drum Rack preset");
  check(!/\{\{[A-Z]+\}\}/.test(xml), "no placeholder left");
  const branches = xml.split("<DrumBranchPreset ").slice(1);
  check(branches.length === 12, "a pad for each sample, the empty ones left out");
  const val = (b, tag) => (b.match(new RegExp("<" + tag + ' Value="([^"]*)"')) || [])[1];
  check(branches.every((b, i) => val(b, "ReceivingNote") === String(92 - i)), "notes 36 up (Live keeps 128 - the note: 92 down)");
  const sampleRef = (b) => b.slice(b.indexOf("<SampleRef>"));
  check(branches.every((b, i) => val(sampleRef(b), "RelativePath") === `Samples/${i + 1} Pad.wav` && val(sampleRef(b), "RelativePathType") === "1"), "samples relative to the preset");
  check(val(branches[0], "Name") === "Kick &amp; &lt;Co&gt;", "names escaped");
  check(val(branches[5], "DefaultDuration") === "1005" && val(branches[5], "SampleEnd") === "1004", "each sample's length");
  check(val(branches[2], "ChokeGroup") === "1" && val(branches[0], "ChokeGroup") === "0", "choke groups");
  check(branches[3].includes('<Speaker>\n\t\t\t\t\t\t\t\t\t<LomId Value="0" />\n\t\t\t\t\t\t\t\t\t<Manual Value="false" />'), "a muted pad's chain is off");
  check(/<TransposeKey>\s*<LomId Value="0" \/>\s*<Manual Value="2" \/>/.test(branches[1]), "pitch");
  const opens = (xml.match(/<[A-Za-z][\w.]*(\s[^>]*)?(?<!\/)>/g) || []).filter((t) => !t.startsWith("<?")).length;
  const closes = (xml.match(/<\/[A-Za-z][\w.]*>/g) || []).length;
  check(opens === closes, `tags balanced (${opens} opened, ${closes} closed)`);
}

console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
