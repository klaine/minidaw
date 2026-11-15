// A Drum Rack's kit for Ableton: for Move (and Note) a preset bundle, for Live a Drum Rack preset with its samples.
//
// Move: <kit>.ablpresetbundle, a zip of Preset.ablpreset (Move's device preset JSON: an Instrument Rack holding a Drum
// Rack of 16 Drum Sampler cells on notes 36-51, a return chain with a reverb and a saturator after the rack, as Move's
// own kits; js/ableton/move-template.js) and Samples/, the pads' WAVs. Move Manager takes it on its Presets tab.
// Live: <kit>.zip, a folder holding <kit>.adg (a Drum Rack of Simplers in one-shot mode: Live's gzipped XML, from a
// Live 11 template, js/ableton/live-*.xml, which Live 11 and 12 open) and its Samples/, the paths relative to the .adg.
//
// Each pad's WAV is what the pad plays here: its trimmed part (start to end), reversed when it is, with its decay
// shaped in. Its level, pan, pitch, choke group and mute go into the preset's parameters. The pure functions here run in
// node's tests; exportKit is the page's.
import { encodeWav } from "../audio/wav.js";
import { padRange } from "../audio/drumrack.js";
import { zip } from "../audio/zip.js";
import { DRUM_BASE_NOTE } from "../model.js";
import { SCHEMA, LOCK, CELL, REVERB, SATURATOR } from "./move-template.js";

/** A name as a file's: letters, digits, spaces, - and _ (Move's sample URIs and Live's paths take those as they are) */
export const fileSafe = (s, fallback = "Kit") => String(s || "").normalize("NFKD").replace(/[^\w\- ]+/g, "").replace(/\s+/g, " ").trim().slice(0, 60) || fallback;

/** The audio a pad plays (at its own pitch): channels [Float32Array] -> channels, trimmed, reversed and decayed */
export function renderPad(channels, rate, pad) {
  const len = channels[0].length;
  const { start, end } = padRange(pad);
  const a = Math.floor(start * len), b = Math.max(a + 1, Math.min(len, Math.round(end * len)));
  const out = channels.map((ch) => {
    const src = pad.reverse ? ch.slice().reverse() : ch;
    return src.slice(a, b);
  });
  const n = b - a, decay = pad.decay ?? 1;
  const speed = Math.pow(2, (pad.pitch || 0) / 12);
  let fadeFrom = n, fadeLen = 0;
  if (decay < 0.999) { // as js/audio/drumrack.js: held for decay² of it, then 40 ms (at its pitch) down to nothing
    fadeFrom = Math.max(1, Math.round(Math.max(0.01 * speed * rate, n * decay * decay)));
    fadeLen = Math.round(0.04 * speed * rate);
  } else if (end < 0.999) { fadeLen = Math.round(0.003 * speed * rate); fadeFrom = n - fadeLen; }
  const stop = Math.min(n, fadeFrom + fadeLen);
  for (const ch of out) for (let i = Math.max(0, fadeFrom); i < n; i++) ch[i] *= i >= stop ? 0 : 1 - (i - fadeFrom) / Math.max(1, fadeLen);
  return out.map((ch) => ch.subarray(0, Math.max(1, stop)));
}

/** A pad's level as an Ableton device's volume: the pad's default level is Move's default, -12 dB */
export const padDb = (pad) => Math.max(-36, Math.min(0, -12 + 20 * Math.log10(Math.max(1e-4, (pad.gain ?? 0.8) / 0.8))));

const round = (v, d = 6) => Math.round(v * 10 ** d) / 10 ** d;

/**
 * Move's Preset.ablpreset: cells [{ pad, file } | null] (16, pad 1 first; file: the WAV's name in Samples/, or null for
 * an empty pad) -> the preset object
 */
export function movePreset(cells) {
  const macros = () => ({ Enabled: true, Macro0: 0, Macro1: 0, Macro2: 0, Macro3: 0, Macro4: 0, Macro5: 0, Macro6: 0, Macro7: 0 });
  const chains = cells.map((c, i) => {
    const pad = (c && c.pad) || {};
    return {
      name: c && c.file ? pad.name || "" : "",
      color: 0,
      devices: [{
        presetUri: null, kind: "drumCell", name: "",
        parameters: {
          ...CELL,
          Pan: round(Math.max(-1, Math.min(1, pad.pan || 0))),
          Volume: round(c && c.file ? padDb(pad) : -12),
          Voice_Transpose: Math.max(-48, Math.min(48, Math.round(pad.pitch || 0))),
          // the sample plays to its end (its decay is in the WAV), as Move's choke kit's cells
          Voice_Envelope_Mode: "A-H-D", Voice_Envelope_Hold: 60, Voice_Envelope_Decay: 0.0010000000474974513,
          Voice_PlaybackStart: 0, Voice_PlaybackLength: 1,
        },
        deviceData: { sampleUri: c && c.file ? "Samples/" + encodeURIComponent(c.file) : null },
      }],
      mixer: { pan: 0, "solo-cue": false, speakerOn: !pad.mute, volume: 0, sends: [{ isEnabled: true, amount: -70 }] },
      drumZoneSettings: { receivingNote: DRUM_BASE_NOTE + i, sendingNote: 60, chokeGroup: pad.choke ? pad.choke : null },
    };
  });
  return {
    $schema: SCHEMA, kind: "instrumentRack", name: "", ...LOCK.rack, parameters: macros(),
    chains: [{
      name: "", color: 0,
      devices: [
        { presetUri: null, kind: "drumRack", name: "", ...LOCK.drums, parameters: macros(), chains,
          returnChains: [{ name: "", color: 0,
            devices: [{ presetUri: null, kind: "reverb", name: "", parameters: { ...REVERB }, deviceData: {} }],
            mixer: { pan: 0, "solo-cue": false, speakerOn: true, volume: 0, sends: [{ isEnabled: false, amount: -70 }] } }] },
        { presetUri: null, kind: "saturator", name: "Saturator", parameters: { ...SATURATOR }, deviceData: {} },
      ],
      mixer: { pan: 0, "solo-cue": false, speakerOn: true, volume: 0, sends: [] },
    }],
  };
}

const xmlEsc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Live's Drum Rack XML (before gzip): rackTpl and padTpl, the templates' text; cells [{ pad, file, frames, rate, size } |
 * null] (16, pad 1 first). Empty pads are left out. Samples are referred to as Samples/<file>, next to the .adg.
 */
export function liveRackXml(rackTpl, padTpl, cells, { now = Date.now() } = {}) {
  const pads = cells.map((c, i) => {
    if (!c || !c.file) return "";
    const pad = c.pad, rel = "Samples/" + c.file;
    const v = {
      ID: i, NAME: pad.name || c.file.replace(/\.wav$/i, ""), NOTE: 128 - (DRUM_BASE_NOTE + i), // Live keeps 128 - the note
      LAST: Math.max(0, c.frames - 1), FRAMES: c.frames, RATE: c.rate, SIZE: c.size, MODDATE: Math.floor(now / 1000),
      RELTYPE: 1, REL: rel, PATH: rel,
      VOL: round(padDb(pad), 4), PAN: round(Math.max(-1, Math.min(1, pad.pan || 0)), 4),
      TRANSPOSE: Math.max(-48, Math.min(48, Math.round(pad.pitch || 0))), CHOKE: pad.choke || 0, SPEAKER: pad.mute ? "false" : "true",
    };
    return padTpl.replace(/\{\{([A-Z]+)\}\}/g, (m, k) => (k in v ? xmlEsc(v[k]) : m));
  }).join("");
  return rackTpl.replace("{{PADS}}", pads);
}

async function gzip(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * The pads' WAVs: pads, buffer(sample) -> AudioBuffer | null -> cells for movePreset / liveRackXml, and the files
 * ({ name, data }) for Samples/
 */
export function padFiles(pads, buffer) {
  const used = new Set(), cells = [], files = [];
  pads.forEach((pad, i) => {
    const b = pad && pad.sample ? buffer(pad.sample) : null;
    if (!b) { cells.push(null); return; }
    const chans = [];
    for (let c = 0; c < b.numberOfChannels; c++) chans.push(b.getChannelData(c));
    const out = renderPad(chans, b.sampleRate, pad);
    let file = `${String(i + 1).padStart(2, "0")} ${fileSafe(pad.name, "Pad")}.wav`;
    for (let k = 2; used.has(file.toLowerCase()); k++) file = file.replace(/( \d+)?\.wav$/, ` ${k}.wav`);
    used.add(file.toLowerCase());
    const data = encodeWav(out, b.sampleRate, 24);
    files.push({ name: file, data });
    cells.push({ pad, file, frames: out[0].length, rate: b.sampleRate, size: data.byteLength });
  });
  return { cells, files };
}

/** format "move" | "live", name: the kit's -> { blob, name } (the file to save) */
export async function exportKit(app, trackId, format, kitName) {
  const t = app.store.track(trackId);
  const pads = t.instrument.state.pads;
  await app.samples.loadAll(pads.map((p) => p.sample).filter(Boolean), app.ctx);
  const { cells, files } = padFiles(pads, (id) => app.samples.buffer(id));
  if (!files.length) throw new Error("the pads have no samples");
  const name = fileSafe(kitName);
  if (format === "move") {
    const preset = new TextEncoder().encode(JSON.stringify(movePreset(cells), null, 2));
    return { name: name + ".ablpresetbundle", blob: zip([{ name: "Preset.ablpreset", data: preset }, ...files.map((f) => ({ name: "Samples/" + f.name, data: f.data }))]) };
  }
  const [rackTpl, padTpl] = await Promise.all(["live-rack.xml", "live-pad.xml"].map((f) => fetch(new URL(f, import.meta.url)).then((r) => r.text())));
  const adg = await gzip(liveRackXml(rackTpl, padTpl, cells));
  const readme = new TextEncoder().encode([
    `${name}: a Drum Rack for Ableton Live 11 or 12, made in minidaw.`,
    "",
    `Keep ${name}.adg and its Samples folder together. Drag ${name}.adg from Live's browser (or your file manager) onto`,
    "a MIDI track: the pads play notes 36 to 51 (C1 up), as minidaw's. If Live says samples are missing, point it at the",
    "Samples folder here. Or drag the 16 WAVs in Samples onto an empty Drum Rack's first pad: they fill the pads in order.",
    "",
  ].join("\n"));
  const entries = [{ name: `${name}/${name}.adg`, data: adg }, ...files.map((f) => ({ name: `${name}/Samples/${f.name}`, data: f.data })), { name: `${name}/Read me.txt`, data: readme }];
  return { name: name + " (Ableton Live).zip", blob: zip(entries) };
}
