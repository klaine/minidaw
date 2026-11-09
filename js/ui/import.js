// Importing files: MIDI files onto instrument tracks (in the arrangement at a bar, or into a session slot), or as new
// tracks (one per part of the file), and audio files onto audio tracks. Files can be dropped anywhere (a track's lane,
// a slot, a header; elsewhere they become new tracks) or picked from the menus. Also a clip as a MIDI file.
import { h, uid, pickFiles, saveFile } from "../util.js";
import { sheet, toast, select } from "./controls.js";
import { parseMidi, writeMidi, toDrumRack, isMidiFile, isAudioFile } from "../midifile.js";
import { newTrack, newMidiClip, newAudioClip, guessBpm, INSTRUMENT_KINDS, DRUM_BASE_NOTE } from "../model.js";
import { placeClip } from "../recording.js";

export const MIDI_ACCEPT = ".mid,.midi,.smf,.kar,audio/midi,audio/x-midi,audio/mid,application/x-midi";
const round = (x) => Math.round(x * 10000) / 10000;
const baseName = (f) => (f.name || "MIDI").replace(/\.[^.]+$/, "");

async function readMidi(file) {
  try {
    const f = parseMidi(await file.arrayBuffer());
    if (!f.parts.length) { toast(file.name + " has no notes", 3500); return null; }
    return f;
  } catch (e) {
    toast(file.name + ": " + (e.message || e), 4000);
    return null;
  }
}

/** The notes of some parts as one list, for a track (a Drum Rack gets General MIDI drums mapped onto its pads) */
function notesFor(parts, track) {
  const drum = track.instrument && track.instrument.kind === "drumrack";
  const out = [];
  for (const part of parts) {
    const notes = drum ? toDrumRack(part.notes, part.channel, DRUM_BASE_NOTE) : part.notes;
    for (const n of notes) out.push({ p: n.p, t: round(n.t), d: round(n.d), v: n.v });
  }
  return out.sort((a, b) => a.t - b.t || a.p - b.p);
}

/** Whole bars that hold the notes (at least one) */
function lengthFor(notes, sig = 4) {
  const end = notes.reduce((m, n) => Math.max(m, n.t + n.d), 0);
  return Math.max(sig, Math.ceil(end / sig - 1e-6) * sig);
}

/** Which parts of a file: all of them merged, or one; asks only when there's more than one */
function chooseParts(f, title) {
  if (f.parts.length === 1) return Promise.resolve(f.parts);
  return new Promise((resolve) => {
    let done = false;
    const pick = (parts) => { done = true; s.close(); resolve(parts); };
    const rows = f.parts.map((p) => h("button", { type: "button", class: "smp-name", onclick: () => pick([p]) },
      `${p.name} · ${p.notes.length} notes`));
    const s = sheet(title, h("div", { class: "smp" },
      h("p", { class: "dim" }, `This file has ${f.parts.length} parts. Import one of them, or all of them as one clip.`),
      h("button", { type: "button", class: "btn primary", onclick: () => pick(f.parts) }, `All ${f.parts.length} parts, merged`),
      ...rows), { onClose: () => { if (!done) resolve(null); } });
  });
}

/**
 * A MIDI file onto a MIDI track: at song beat `start` in the arrangement, or into session slot `scene`.
 * Several files go one after the other (arrangement) or into the slots below (session).
 */
export async function importMidiToTrack(app, trackId, { start, scene } = {}, files = null) {
  files = files || await pickFiles(MIDI_ACCEPT, true);
  if (!files || !files.length) return;
  const store = app.store;
  let at = start ?? Math.floor(app.transport.position / 4) * 4;
  let slot = scene;
  for (const file of files) {
    const track = store.track(trackId);
    if (!track || track.type !== "midi") return;
    const f = await readMidi(file);
    if (!f) continue;
    const parts = await chooseParts(f, "Import " + file.name);
    if (!parts) continue;
    const notes = notesFor(parts, track);
    const sig = store.project.sig || 4;
    const length = lengthFor(notes, sig);
    const name = parts.length === 1 && f.parts.length > 1 ? parts[0].name : baseName(file);
    store.update((p) => {
      const t = p.tracks.find((x) => x.id === trackId);
      const c = newMidiClip(p, t, length, name);
      c.notes = notes;
      if (slot !== undefined && slot !== null) {
        let i = slot;
        while (i < t.slots.length && t.slots[i]) i++;
        if (i >= t.slots.length) { p.scenes.push({ name: "" }); for (const x of p.tracks) x.slots.push(null); i = t.slots.length - 1; }
        t.slots[i] = c.id;
        slot = i + 1;
      } else {
        placeClip(t, { id: uid("a"), clipId: c.id, start: at, length, offset: 0 });
        at += length;
      }
      store.ui.selTrack = t.id;
      store.ui.selClip = c.id;
      store.ui.panel = "clip";
    }, "clips");
    toast(`${file.name}: ${notes.length} notes on ${track.name}`);
  }
}

/** A MIDI file as new tracks, one per part, each with an instrument chosen here */
export async function importMidiAsTracks(app, files = null) {
  files = files || await pickFiles(MIDI_ACCEPT, true);
  if (!files || !files.length) return;
  for (const file of files) {
    const f = await readMidi(file);
    if (!f) continue;
    await new Promise((resolve) => {
      const synths = INSTRUMENT_KINDS.filter((k) => k.kind !== "drumrack");
      const choice = f.parts.map((p, i) => ({ part: p, on: true, kind: p.channel === 9 ? "drumrack" : synths[i % synths.length].kind }));
      let useTempo = false;
      const rows = choice.map((c) => h("div", { class: "imp-row" },
        h("label", { class: "imp-check" }, h("input", { type: "checkbox", checked: true, onchange: (e) => { c.on = e.target.checked; } }),
          h("span", { class: "imp-name" }, c.part.name), h("span", { class: "dim" }, ` · ${c.part.notes.length} notes`)),
        select(INSTRUMENT_KINDS.map((k) => ({ value: k.kind, label: k.name })), c.kind, (v) => { c.kind = v; })));
      const session = app.store.ui.view === "session";
      const where = session ? "into the first empty scene of the session" : `in the arrangement at bar ${Math.floor(app.transport.position / 4) + 1}`;
      const body = h("div", { class: "imp" },
        h("p", { class: "dim" }, `New tracks ${where}, one per part, each with the instrument you choose.`),
        ...rows,
        f.bpm && Math.abs(f.bpm - app.store.project.bpm) > 0.01
          ? h("label", { class: "imp-check imp-tempo" }, h("input", { type: "checkbox", onchange: (e) => { useTempo = e.target.checked; } }), ` Use the file's tempo (${f.bpm} BPM)`)
          : null);
      sheet("Import " + file.name, body, {
        wide: true,
        onClose: resolve,
        actions: [{ label: "Cancel" }, { label: "Import", primary: true, onClick: async () => {
          const chosen = choice.filter((c) => c.on);
          if (!chosen.length) return false;
          const store = app.store;
          const sig = store.project.sig || 4;
          const start = Math.floor(app.transport.position / sig) * sig;
          let firstId = null, firstClip = null;
          store.update((p) => {
            if (useTempo && f.bpm) p.bpm = Math.max(40, Math.min(240, f.bpm));
            const sel = store.selectedTrack;
            let at = sel ? p.tracks.findIndex((x) => x.id === sel.id) + 1 : p.tracks.length;
            // the session: the first scene with no clips at all (a new one when there is none)
            let row = -1;
            if (session) {
              row = p.scenes.findIndex((_, i) => p.tracks.every((t) => !t.slots[i]));
              if (row < 0) { p.scenes.push({ name: "" }); for (const x of p.tracks) x.slots.push(null); row = p.scenes.length - 1; }
            }
            for (const c of chosen) {
              const t = newTrack(p, "midi", c.kind);
              t.name = c.part.name.slice(0, 32);
              const notes = notesFor([c.part], t);
              const clip = newMidiClip(p, t, lengthFor(notes, sig), t.name);
              clip.notes = notes;
              if (session) { if (row >= 0) t.slots[row] = clip.id; }
              else t.arrangement.push({ id: uid("a"), clipId: clip.id, start, length: clip.length, offset: 0 });
              p.tracks.splice(at++, 0, t);
              if (!firstId) { firstId = t.id; firstClip = clip.id; }
            }
            store.ui.selTrack = firstId;
            store.ui.selClip = firstClip;
            store.ui.panel = "clip";
          }, "tracks");
          const pads = store.project.tracks.flatMap((t) => (t.instrument && t.instrument.kind === "drumrack" ? t.instrument.state.pads.map((x) => x.sample) : []));
          await app.samples.loadAll(pads, app.ctx);
          toast(`${chosen.length} track${chosen.length > 1 ? "s" : ""} from ${file.name}`);
          return true;
        } }],
      });
    });
  }
}

/** Audio files onto an audio track (or new audio tracks), in the arrangement at `start` or into slot `scene` */
async function importAudio(app, files, target) {
  const store = app.store;
  let trackId = target && target.track && target.track.type === "audio" ? target.track.id : null;
  let at = target && target.start !== undefined ? target.start : Math.floor(app.transport.position / 4) * 4;
  let slot = target ? target.scene : undefined;
  const session = store.ui.view === "session";
  for (const file of files) {
    let s;
    try { toast("Loading " + file.name + "…"); s = await app.samples.importFile(file, app.ctx); }
    catch (e) { toast(file.name + " couldn't be decoded: " + (e.message || e), 4000); continue; }
    const bpm = guessBpm(s.duration);
    store.update((p) => {
      let t = trackId && p.tracks.find((x) => x.id === trackId);
      if (!t) { t = newTrack(p, "audio"); t.name = s.name.slice(0, 32); p.tracks.push(t); trackId = t.id; if (session && slot === undefined) slot = 0; }
      const c = newAudioClip(p, t, s, bpm);
      if (slot !== undefined && slot !== null) {
        let i = slot;
        while (i < t.slots.length && t.slots[i]) i++;
        if (i >= t.slots.length) { p.scenes.push({ name: "" }); for (const x of p.tracks) x.slots.push(null); i = t.slots.length - 1; }
        t.slots[i] = c.id;
        slot = i + 1;
      } else {
        placeClip(t, { id: uid("a"), clipId: c.id, start: at, length: c.length, offset: 0 });
        at += c.length;
      }
      store.ui.selTrack = t.id;
      store.ui.selClip = c.id;
      store.ui.panel = "clip";
    }, "clips");
  }
}

/** An audio file onto a Drum Rack pad (its trim back to the whole sample) */
async function audioToPad(app, track, i, file) {
  let s;
  try { toast("Loading " + file.name + "…"); s = await app.samples.importFile(file, app.ctx); }
  catch (e) { toast(file.name + " couldn't be decoded: " + (e.message || e), 4000); return; }
  app.store.update((p) => {
    const pad = p.tracks.find((x) => x.id === track.id).instrument.state.pads[i];
    Object.assign(pad, { sample: s.id, name: s.name.slice(0, 14), start: 0, end: 1, reverse: false });
  }, "pad");
  app.store.select({ selTrack: track.id, panel: "device", drumPad: i });
  toast(`${s.name} on pad ${i + 1}`);
}

/** Where a drop lands: {track, start} in the arrangement, {track, scene} in the session, {track} on a header */
function dropTarget(app, x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  const store = app.store;
  const pad = el.closest("[data-pad][data-track]");
  if (pad) return { track: store.track(pad.dataset.track), pad: Number(pad.dataset.pad) };
  if (el.closest(".arr-canvas")) return app.views.arrange.dropTarget(x, y);
  const slot = el.closest("[data-scene][data-track]");
  if (slot) return { track: store.track(slot.dataset.track), scene: Number(slot.dataset.scene) };
  const head = el.closest("[data-track]");
  if (head) return { track: store.track(head.dataset.track) };
  if (el.closest(".panel")) {
    const t = store.selectedTrack;
    if (!t) return null;
    const ss = store.ui.selSlot;
    return store.ui.view === "session" && ss && ss.trackId === t.id ? { track: t, scene: ss.scene } : { track: t };
  }
  return null;
}

/** Files dropped on the app */
export async function dropFiles(app, files, x, y) {
  const target = dropTarget(app, x, y);
  const midi = files.filter(isMidiFile), audio = files.filter((f) => !isMidiFile(f) && isAudioFile(f));
  if (!midi.length && !audio.length) { toast("Drop MIDI files (.mid) or audio files here"); return; }
  if (target && target.pad !== undefined && audio.length) { await audioToPad(app, target.track, target.pad, audio[0]); return; }
  if (midi.length) {
    if (target && target.track && target.track.type === "midi") await importMidiToTrack(app, target.track.id, { start: target.start, scene: target.scene }, midi);
    else await importMidiAsTracks(app, midi);
  }
  if (audio.length) await importAudio(app, audio, target);
}

/** Drag and drop of files anywhere in the app (also from the Files app on an iPad) */
export function setupDrop(app) {
  const hint = h("div", { class: "drop-hint", hidden: true }, "Drop MIDI files on an instrument track (or anywhere for new tracks), audio files on an audio track");
  document.body.append(hint);
  let depth = 0;
  const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes("Files");
  window.addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; depth++; hint.hidden = false; });
  window.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; hint.hidden = true; } });
  window.addEventListener("dragover", (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
  window.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    hint.hidden = true;
    const files = [...e.dataTransfer.files];
    if (files.length) dropFiles(app, files, e.clientX, e.clientY).catch((err) => { console.error(err); toast("Import failed: " + (err.message || err), 4000); });
  });
}

/** A MIDI clip as a .mid file */
export function exportClipMidi(app, clip, track) {
  const drum = track && track.instrument && track.instrument.kind === "drumrack";
  const bytes = writeMidi(clip, { bpm: app.store.project.bpm, name: clip.name, channel: drum ? 9 : 0, sig: app.store.project.sig || 4 });
  const safe = (clip.name || "clip").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || "clip";
  return saveFile(new Blob([bytes], { type: "audio/midi" }), safe + ".mid");
}
