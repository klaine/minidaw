// Projects (list, open, rename, duplicate, delete, import and export as a file), the export dialog, recording the
// output live, and the help sheet.
import { h, saveFile, pickFiles, deepCopy, uid } from "../util.js";
import { sheet, prompt, confirmBox, toast, segmented } from "./controls.js";
import { db } from "../db.js";
import { migrate } from "../model.js";
import { exportAudio } from "../audio/export.js";
import { Capture } from "../audio/recorder.js";
import { encodeWav } from "../audio/wav.js";

const b64 = {
  enc(buf) { const u8 = new Uint8Array(buf); let s = ""; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192)); return btoa(s); },
  dec(s) { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u.buffer; },
};

export async function openProjects(app) {
  await app.save();
  const list = h("div", { class: "proj-list" });
  const s = sheet("Projects", h("div", {},
    h("div", { class: "proj-actions" },
      h("button", { type: "button", class: "btn primary", onclick: () => { s.close(); app.newProject(); } }, "New project"),
      h("button", { type: "button", class: "btn", onclick: () => importProject(app, s) }, "Import file…"),
      h("button", { type: "button", class: "btn", onclick: () => exportProjectFile(app) }, "Save current as file…"),
    ),
    list), { wide: true });
  async function fill() {
    list.textContent = "";
    const items = await db.listProjects();
    if (!items.length) list.append(h("p", { class: "dim" }, "No saved projects yet."));
    for (const it of items) {
      const cur = it.id === app.store.project.id;
      list.append(h("div", { class: "proj-row" + (cur ? " current" : "") },
        h("button", { type: "button", class: "proj-open", onclick: async () => {
          if (cur) { s.close(); return; }
          const p = await db.loadProject(it.id);
          if (p) { s.close(); await app.openProject(migrate(p)); }
        } }, h("div", { class: "proj-name" }, it.name), h("div", { class: "proj-meta" }, `${it.tracks} tracks · ${new Date(it.updatedAt).toLocaleString()}`)),
        h("button", { type: "button", class: "btn small", onclick: async () => {
          const name = await prompt("Rename project", it.name);
          if (!name) return;
          if (cur) { app.store.update((p) => { p.name = name; }, "name"); await app.save(); }
          else { const p = await db.loadProject(it.id); p.name = name; await db.saveProject(p); }
          fill();
        } }, "Rename"),
        h("button", { type: "button", class: "btn small", onclick: async () => {
          const p = cur ? deepCopy(app.store.project) : await db.loadProject(it.id);
          p.id = uid("p"); p.name = p.name + " copy"; p.updatedAt = Date.now();
          await db.saveProject(p);
          fill();
        } }, "Duplicate"),
        h("button", { type: "button", class: "btn small danger", disabled: cur, onclick: async () => {
          if (!(await confirmBox("Delete project", `Delete “${it.name}”? This can't be undone.`, "Delete", true))) return;
          await db.deleteProject(it.id);
          fill();
        } }, "Delete")));
    }
  }
  fill();
}

/** The project as one file: its JSON with the user's samples in it */
export async function exportProjectFile(app) {
  await app.save();
  const p = deepCopy(app.store.project);
  const ids = new Set();
  for (const c of Object.values(p.clips)) if (c.type === "audio" && !c.sampleId.startsWith("builtin:")) ids.add(c.sampleId);
  for (const t of p.tracks) if (t.instrument && t.instrument.kind === "drumrack") for (const pad of t.instrument.state.pads) if (!pad.sample.startsWith("builtin:")) ids.add(pad.sample);
  const samples = [];
  for (const id of ids) {
    const rec = await db.loadSample(id);
    if (rec) samples.push({ id, name: rec.name, type: rec.type, data: b64.enc(rec.bytes) });
  }
  const blob = new Blob([JSON.stringify({ minidaw: 1, project: p, samples })], { type: "application/json" });
  await saveFile(blob, (p.name || "project").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") + ".minidaw.json");
}

async function importProject(app, s) {
  const [file] = await pickFiles(".json,.minidaw,application/json");
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const p = migrate(data.project || data);
    for (const smp of data.samples || []) await db.saveSample({ id: smp.id, name: smp.name, type: smp.type, bytes: b64.dec(smp.data), createdAt: Date.now() });
    p.id = uid("p");
    p.updatedAt = Date.now();
    await db.saveProject(p);
    s.close();
    await app.openProject(p);
  } catch (e) {
    toast("Not a minidaw project: " + e.message, 4000);
  }
}

export function exportDialog(app, { stems }) {
  const p = app.store.project;
  let range = p.loop.on ? "loop" : "song", bits = 16;
  const status = h("p", { class: "dim export-status" }, stems ? "One WAV per track that has clips in the arrangement, and the mix, in a zip." : "The arrangement, rendered offline with every instrument, effect and automation.");
  const body = h("div", { class: "export" },
    h("label", { class: "field" }, h("span", {}, "Range"), segmented([{ value: "song", label: "Whole arrangement" }, { value: "loop", label: "Loop region" }], range, (v) => { range = v; })),
    h("label", { class: "field" }, h("span", {}, "Format"), segmented([{ value: "16", label: "16-bit" }, { value: "24", label: "24-bit" }, { value: "32", label: "32-bit float" }], "16", (v) => { bits = +v; })),
    status);
  let busy = false;
  sheet(stems ? "Export stems" : "Export mix", body, {
    actions: [{ label: "Cancel" }, { label: "Export", primary: true, onClick: async () => {
      if (busy) return false;
      busy = true;
      try {
        const t0 = performance.now();
        const r = await exportAudio(app.store.project, app.engine, app.samples, { range, stems, bits, onProgress: (t) => { status.textContent = t; } });
        status.textContent = `Done in ${((performance.now() - t0) / 1000).toFixed(1)} s.`;
        await saveFile(r.blob, r.name);
      } catch (e) {
        console.error(e);
        status.textContent = "Export failed: " + (e.message || e);
        busy = false;
        return false;
      }
      busy = false;
      return true;
    } }],
  });
}

/** Record what you hear (the master, after the limiter) as a WAV: start, then stop to save */
export async function recordOutput(app) {
  if (app.outputRec) {
    const rec = app.outputRec;
    app.outputRec = null;
    const chans = await rec.stop();
    rec.dispose();
    app.topbar.update();
    if (!chans[0].length) return;
    const secs = chans[0].length / app.ctx.sampleRate;
    const blob = new Blob([encodeWav(chans, app.ctx.sampleRate, 16)], { type: "audio/wav" });
    toast(`Recorded ${secs.toFixed(1)} s`);
    await saveFile(blob, (app.store.project.name || "minidaw").replace(/\W+/g, "-") + "-live-" + new Date().toISOString().slice(11, 19).replace(/:/g, "") + ".wav");
    return;
  }
  const rec = new Capture(app.ctx, app.engine.master.out, 2);
  await rec.start();
  app.outputRec = rec;
  app.topbar.update();
  toast("Recording the output: play, then choose Stop recording in the Export menu");
}

export function settingsSheet(app) {
  const midi = app.midi && app.midi.names.length ? app.midi.names.join(", ") : navigator.requestMIDIAccess ? "none connected" : "not in this browser (Safari has no Web MIDI)";
  const ctx = app.ctx;
  const lat = ctx ? Math.round(((ctx.outputLatency || 0) + (ctx.baseLatency || 0)) * 1000) : 0;
  sheet("Settings and help", h("div", { class: "help" },
    h("p", {}, `Audio: ${ctx ? ctx.sampleRate : "-"} Hz, about ${lat} ms output latency. MIDI inputs: ${midi}.`),
    h("h3", {}, "Gestures"),
    h("ul", {},
      h("li", {}, "Tap to select, double tap to create or open, long press for the menu (right click with a mouse)."),
      h("li", {}, "Drag clips and notes to move them, their right edge to resize. Two fingers pan, pinch zooms."),
      h("li", {}, "Knobs and faders: drag up or down; double tap resets. Shift with a mouse drags finer."),
      h("li", {}, "The piano roll has Draw (tap adds, tap a note removes) and Select (drag a box, move many) tools."),
      h("li", {}, "Drag the bar above the bottom panel to resize it; double tap it to fold it.")),
    h("h3", {}, "Session and arrangement"),
    h("p", {}, "Session clips launch on the next bar (Launch quantization in the menu). A launched clip takes its track off the arrangement until you tap Arrangement in the top bar. Long press a session clip to copy it into the arrangement."),
    h("h3", {}, "Recording"),
    h("p", {}, "Arm a track (●) and press Record: from a stop it counts in first (long press Record for the count-in, click, quantize, replace or overdub, and the session's clip length). Notes appear in the clip as you play, and a whole take is one undo."),
    h("p", {}, "In the session, tap an armed track's empty slot to record a loop there from the next bar; tap it again to stop, or set a fixed length and it stops by itself and plays on. Armed tracks with a playing clip overdub into it."),
    h("p", {}, "Capture (next to Record) turns what you just played into a clip, even when nothing was recording. Audio tracks record the microphone or audio input: arming one shows its level, Monitor plays it through. Export → Record the output captures what you hear."),
    h("h3", {}, "MIDI and audio files"),
    h("p", {}, "Drop a MIDI file on an instrument track (its lane, a session slot or its header), or use Import MIDI in the device panel. Dropped elsewhere, or from Add track → Tracks from a MIDI file, it becomes new tracks, one per part. On a Drum Rack, General MIDI drums land on the pads. Audio files dropped on an audio track become clips there. Long press a MIDI clip to save it as a .mid file."),
    h("h3", {}, "Keys"),
    h("p", {}, "Computer keyboard: A W S E D F T G Y H U J K O L P plays notes, Z / X shifts the octave, Space plays and stops, Tab switches Arrange and Session, ⌘Z undoes."),
    h("h3", {}, "Instruments"),
    h("p", {}, "Crest, Amino, Bizar and PRO-8000 V are the instruments' own engines and editors, built from their repositories. Each MIDI track runs its own instance: tap Edit in the device panel for the full editor."),
    h("p", {}, "Crest, Amino and Bizar follow the song's tempo by themselves. PRO-8000 V gets MIDI clock while playing: set its clock source to MIDI in its editor (System) for its arpeggiator and sequencer to follow."),
    h("p", { class: "dim" }, "Projects and samples are kept in this browser's storage. Save a project as a file to move it to another device.")), { wide: true });
}
