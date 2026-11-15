// The kit builder: the sample library beside a Drum Rack's 16 pads. Tap a sample (it plays) and then a pad to put it
// there, or drag it onto a pad. "Auto kit" makes a whole kit from a folder (its subfolders too) or the whole library:
// each pad gets a sample of its role (kick, snare, hats...: by name, js/kitmap.js, or else by its sound,
// js/kitsound.js), picked at random among those that fit, so pressing it again makes another kit; the silence before
// each sample is trimmed and the levels evened out. "Build from this folder" is the same without the dice and the
// tidying: the first sample of each role. "Fill in order" puts them on pads 1 to 16 as they come. Kits can be saved,
// loaded on any Drum Rack, and exported for Ableton Move or Live (js/ableton/kit.js).
import { h, saveFile } from "../util.js";
import { sheet, menu, toast, prompt } from "./controls.js";
import { LibraryBrowser } from "./library.js";
import { buildKit, classify, seeded, ROLES } from "../kitmap.js";
import { tidyPad, bufferFeatures, roleOfSound } from "../kitsound.js";
import { exportKit } from "../ableton/kit.js";
import { kits } from "../library.js";
import { defaultDrumState, DRUM_BASE_NOTE } from "../model.js";

export function openKitBuilder(app, trackId, { folder } = {}) {
  const store = app.store;
  const track = () => store.track(trackId);
  if (!track() || !track().instrument || track().instrument.kind !== "drumrack") return;
  let placing = null;
  const status = h("div", { class: "kb-status" });
  const pads = h("div", { class: "kb-pads" });
  const lib = new LibraryBrowser(app, {
    folder,
    selectable: true,
    onPick: (it) => { placing = it; lib.preview(it); paint(); },
    folderActions: (f) => [
      { label: "Auto kit from this folder", onClick: () => build(f.path, { auto: true }) },
      { label: "Build a kit from this folder", onClick: () => build(f.path) },
      { label: "Fill the pads in order", onClick: () => fill(f.path) },
    ],
  });

  const setPads = (fn, reason = "pad") => store.update((p) => fn(p.tracks.find((x) => x.id === trackId).instrument.state.pads), reason);
  const place = async (i, it) => {
    await app.samples.load(it.id, app.ctx);
    setPads((ps) => Object.assign(ps[i], { sample: it.id, name: it.name.slice(0, 14), start: 0, end: 1, reverse: false, mute: false }));
    play(i);
  };
  const play = (i) => { const inst = app.engine.instrument(trackId); if (inst) inst.noteOn(DRUM_BASE_NOTE + i, 110, 0); };

  let rounds = 0;
  const say = (text) => { status.textContent = text; status.classList.remove("placing"); };
  /** Listen to the samples their names don't place (once each: the library keeps what it heard) */
  const listen = async (items) => {
    if (!items.length) return;
    await app.library.analyze(items, app.ctx, (d, n) => say(`Listening to the samples: ${d} / ${n}`));
  };
  /** A kit from a folder (its subfolders too; "" the whole library). auto: a random pick among each role's samples,
   *  the silence trimmed and the levels evened out */
  async function build(path, { auto = false } = {}) {
    const items = app.library.under(path);
    if (!items.length) { toast("No samples in " + (path || "the library")); return; }
    const byId = new Map(items.map((it) => [it.id, it]));
    await listen(items.filter((it) => !classify(app.library.path(it))));
    const rng = auto ? seeded((Date.now() + 7919 * ++rounds) >>> 0) : null;
    const kit = buildKit(items.map((it) => ({ id: it.id, name: it.name, path: app.library.path(it) })), { roleOf: (s) => app.library.roleOf(byId.get(s.id)), rng });
    const chosen = kit.filter(Boolean);
    if (auto) await listen(chosen.map((k) => byId.get(k.id)));
    await app.samples.loadAll(chosen.map((k) => k.id), app.ctx);
    setPads((ps) => kit.forEach((k, i) => {
      if (!k) return;
      const fresh = { sample: k.id, name: k.name.slice(0, 14), start: 0, end: 1, reverse: false, mute: false };
      if (auto) Object.assign(fresh, { gain: 0.8, pan: 0, pitch: 0, decay: 1 }, tidyPad(app.library.sound(byId.get(k.id)), k.role || ROLES[i]));
      Object.assign(ps[i], fresh);
    }), auto ? "auto kit" : "kit");
    const named = chosen.filter((k) => classify(app.library.path(byId.get(k.id)))).length;
    const where = path.split("/").pop() || "the library";
    say(auto
      ? `Auto kit from ${where}: ${chosen.length} pads, ${named} known by name, ${chosen.length - named} by their sound. Levels evened out, silence trimmed. Auto kit again for another.`
      : `${chosen.length} pads from ${where}: ${named} by name, ${chosen.length - named} by their sound.`);
    toast(`${chosen.length} pads from ${where}`);
    paint(false);
  }
  /** The pads as they are, tidied: each sample's silence trimmed, the levels evened out */
  async function tidy() {
    const ps = track().instrument.state.pads;
    await app.samples.loadAll(ps.map((p) => p.sample), app.ctx);
    const known = new Map(app.library.all().map((it) => [it.id, it]));
    await listen(ps.map((p) => known.get(p.sample)).filter(Boolean));
    const sounds = ps.map((p) => { const it = known.get(p.sample); const b = app.samples.buffer(p.sample); return (it && app.library.sound(it)) || (b ? bufferFeatures(b) : null); });
    setPads((pads) => pads.forEach((p, i) => {
      const f = sounds[i];
      const t = tidyPad(f, classify(p.name) || roleOfSound(f) || ROLES[i]);
      if (p.reverse) delete t.start; // the silence is at the other end
      Object.assign(p, t);
    }), "tidy pads");
    say("Tidied: each pad starts where its sound does, and the pads' levels are even.");
    paint(false);
  }
  const exportAs = (format) => exportKitAs(app, trackId, format, say);

  async function fill(path) {
    const items = app.library.under(path).slice(0, 16);
    if (!items.length) { toast("No samples in " + (path || "the library")); return; }
    await app.samples.loadAll(items.map((it) => it.id), app.ctx);
    setPads((ps) => items.forEach((it, i) => Object.assign(ps[i], { sample: it.id, name: it.name.slice(0, 14), start: 0, end: 1, reverse: false, mute: false })));
    toast(`Pads 1 to ${items.length} from ${path.split("/").pop()}`);
    paint();
  }

  function paint(hint = true) {
    const t = track();
    if (!t) return;
    if (placing) status.textContent = `Tap a pad to put “${placing.name}” there`;
    else if (hint) status.textContent = "Tap a sample to hear it and pick it, then tap a pad. Or let Auto kit make a whole kit from this folder.";
    status.classList.toggle("placing", !!placing);
    pads.textContent = "";
    const ps = t.instrument.state.pads;
    for (let row = 3; row >= 0; row--) for (let col = 0; col < 4; col++) {
      const i = row * 4 + col;
      const el = h("button", { type: "button", class: "pad kb-pad" + (placing ? " target" : ""), style: { "--tc": t.color }, "aria-label": `Kit pad ${i + 1}: ${ps[i].name}` },
        h("span", { class: "pad-name" }, ps[i].name), h("span", { class: "pad-note" }, String(i + 1)));
      el.addEventListener("click", async () => {
        if (placing) { const it = placing; placing = null; lib.selected = null; lib.render(); await place(i, it); paint(); }
        else play(i);
      });
      el.addEventListener("dragover", (e) => { if ([...e.dataTransfer.types].includes("text/x-minidaw-sample")) { e.preventDefault(); el.classList.add("over"); } });
      el.addEventListener("dragleave", () => el.classList.remove("over"));
      el.addEventListener("drop", async (e) => {
        const id = e.dataTransfer.getData("text/x-minidaw-sample");
        if (!id) return;
        e.preventDefault();
        e.stopPropagation();
        const it = app.library.all().find((x) => x.id === id);
        if (it) { await place(i, it); paint(); }
      });
      pads.append(el);
    }
  }

  const btn = (label, fn, cls = "") => h("button", { type: "button", class: "btn small " + cls, onclick: fn }, label);
  const actions = h("div", { class: "kb-actions" },
    btn("Auto kit", () => build(lib.folder, { auto: true }), "primary"),
    btn("Build from this folder", () => build(lib.folder)),
    btn("Tidy pads", () => tidy()),
    btn("Fill in order", () => fill(lib.folder)),
    btn("Default kit", async () => { const d = defaultDrumState(); await app.samples.loadAll(d.pads.map((p) => p.sample), app.ctx); setPads((ps) => d.pads.forEach((p, i) => Object.assign(ps[i], p))); paint(); }),
    btn("Save kit…", async () => {
      const name = await prompt("Kit name", track().name + " kit");
      if (!name) return;
      await kits.save(name, track().instrument.state.pads);
      toast("Saved the kit “" + name + "”");
    }),
    btn("Kits ▾", async (e) => {
      const anchor = e.currentTarget;
      const list = await kits.list();
      if (!list.length) { toast("No saved kits yet: Save kit… keeps this one"); return; }
      menu(anchor, [
        ...list.map((k) => ({ label: k.name, onClick: async () => {
          await app.samples.loadAll(k.pads.map((p) => p.sample), app.ctx);
          setPads((ps) => k.pads.forEach((p, i) => Object.assign(ps[i], JSON.parse(JSON.stringify(p)))));
          toast("Loaded “" + k.name + "”");
          paint();
        } })),
        "-",
        { label: "Delete a kit…", onClick: () => menu(anchor, list.map((k) => ({ label: k.name, danger: true, onClick: () => kits.remove(k.id).then(() => toast("Deleted “" + k.name + "”")) })), { title: "Delete" }) },
      ], { title: "Saved kits" });
    }),
    btn("Export ▾", (e) => menu(e.currentTarget, [
      { label: "For Ableton Move (.ablpresetbundle)", onClick: () => exportAs("move") },
      { label: "For Ableton Live (Drum Rack .adg)", onClick: () => exportAs("live") },
    ], { title: "Export the kit" })));
  const body = h("div", { class: "kb" }, h("div", { class: "kb-lib" }, lib.el), h("div", { class: "kb-right" }, status, pads, actions));
  const s = sheet("Kit builder · " + track().name, body, { wide: true, full: true, actions: [{ label: "Done", primary: true }], onClose: () => lib.dispose() });
  paint();
  return { build, fill, tidy, exportAs, close: s.close };
}

/** Export a Drum Rack's kit for Ableton: asks its name, saves the file, says how to load it (say(text), else a toast) */
export async function exportKitAs(app, trackId, format, say = (t) => toast(t, 6000)) {
  const t = app.store.track(trackId);
  if (!t) return;
  const name = await prompt(format === "move" ? "Kit name on Move" : "Drum Rack name in Live", t.name + " kit");
  if (!name) return;
  try {
    say("Exporting…");
    const r = await exportKit(app, trackId, format, name);
    await saveFile(r.blob, r.name);
    say(format === "move"
      ? `Saved ${r.name}. In Move Manager, drop it on the Presets tab and press Upload.`
      : `Saved ${r.name}. Unzip it and drag the .adg into Live (keep its Samples folder beside it).`);
  } catch (e) {
    console.error(e);
    say("Export failed: " + (e.message || e));
  }
}
