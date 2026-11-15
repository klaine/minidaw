// Export: the arrangement (or the loop) rendered offline, the same graph and instruments as playback, to WAV; stems
// are one render per track (soloed, with its sends' returns) in a zip.
import { AudioEngine } from "./engine.js";
import { Transport } from "./transport.js";
import { encodeWav, bufferChannels, peakOf } from "./wav.js";
import { zip } from "./zip.js";
import { arrangementEnd } from "../model.js";
import { deepCopy } from "../util.js";

export const EXPORT_RATE = 44100;

// A new graph's master compressor ducks whatever comes in its first 150 ms: the song starts after a silent lead-in,
// which is cut off the result (the first downbeat used to come out 6 to 13 dB down)
const LEAD = 0.25;

async function renderOnce(project, samples, states, from, to, tail) {
  const spb = 60 / project.bpm;
  const lead = Math.round(LEAD * EXPORT_RATE);
  const frames = Math.ceil(((to - from) * spb + tail) * EXPORT_RATE) + lead;
  const ctx = new OfflineAudioContext(2, frames, EXPORT_RATE);
  const engine = new AudioEngine(ctx, samples, { offline: true });
  engine.trackLookup = (id) => project.tracks.find((t) => t.id === id);
  await engine.sync(project, { states });
  const transport = new Transport(engine, () => project, { offline: true });
  transport.renderRange(from, to, lead / EXPORT_RATE);
  await engine.flushAll();
  const rendered = await ctx.startRendering();
  engine.dispose();
  const buffer = new AudioBuffer({ length: rendered.length - lead, numberOfChannels: rendered.numberOfChannels, sampleRate: EXPORT_RATE });
  for (let c = 0; c < rendered.numberOfChannels; c++) buffer.copyToChannel(rendered.getChannelData(c).subarray(lead), c);
  return buffer;
}

/**
 * opts: { range: "song" | "loop", stems: bool, bits: 16|24|32, tail: seconds, onProgress(text) }
 * -> { blob, name }
 */
export async function exportAudio(project0, liveEngine, samples, opts = {}) {
  const project = deepCopy(project0);
  const progress = opts.onProgress || (() => {});
  progress("Collecting instrument states…");
  const states = await liveEngine.collectStates();
  const clipSamples = Object.values(project.clips).filter((c) => c.type === "audio").map((c) => c.sampleId);
  const padSamples = project.tracks.flatMap((t) => (t.instrument && t.instrument.kind === "drumrack" ? t.instrument.state.pads.map((p) => p.sample) : []));
  await samples.loadAll([...clipSamples, ...padSamples], liveEngine.ctx);
  let from = 0, to = arrangementEnd(project);
  if (opts.range === "loop" && project.loop.end > project.loop.start) { from = project.loop.start; to = project.loop.end; }
  if (to - from <= 0) throw new Error("Nothing to export: the arrangement is empty. Put clips in the arrangement, or export the loop.");
  const tail = opts.tail ?? 2;
  const bits = opts.bits || 16;
  const safe = (s) => (s || "untitled").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || "untitled";
  const base = safe(project.name);
  if (!opts.stems) {
    progress("Rendering the mix…");
    const buf = await renderOnce(project, samples, states, from, to, tail);
    const ch = bufferChannels(buf);
    progress(`Encoding (peak ${(20 * Math.log10(peakOf(ch) + 1e-9)).toFixed(1)} dBFS)…`);
    return { blob: new Blob([encodeWav(ch, EXPORT_RATE, bits)], { type: "audio/wav" }), name: base + ".wav", buffer: buf };
  }
  const files = [];
  const tracks = project.tracks.filter((t) => t.arrangement.length);
  let i = 0;
  for (const t of tracks) {
    i++;
    progress(`Rendering stem ${i} of ${tracks.length}: ${t.name}…`);
    const solo = deepCopy(project);
    for (const x of solo.tracks) { x.mixer.solo = x.id === t.id; x.mixer.mute = false; }
    const buf = await renderOnce(solo, samples, states, from, to, tail);
    files.push({ name: `${String(i).padStart(2, "0")}-${safe(t.name)}.wav`, data: encodeWav(bufferChannels(buf), EXPORT_RATE, bits) });
  }
  progress("Rendering the mix…");
  const mix = await renderOnce(project, samples, states, from, to, tail);
  files.push({ name: `00-${base}-mix.wav`, data: encodeWav(bufferChannels(mix), EXPORT_RATE, bits) });
  return { blob: zip(files), name: base + "-stems.zip" };
}
