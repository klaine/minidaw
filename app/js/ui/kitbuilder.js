// The kit builder: the sample library beside a Drum Rack's 16 pads. Tap a sample (it plays) and then a pad to put it
// there, or drag it onto a pad; "Build from this folder" puts a whole folder (its subfolders too) on the pads by what
// each sample is (kick, snare, hats...: js/kitmap.js); "Fill in order" puts them on pads 1 to 16 as they come. Kits
// can be saved, and loaded on any Drum Rack.
import { h } from "../util.js";
import { sheet, menu, toast, prompt } from "./controls.js";
import { LibraryBrowser } from "./library.js";
import { buildKit } from "../kitmap.js";
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

  async function build(path) {
    const items = app.library.under(path);
    if (!items.length) { toast("No samples in " + (path || "the library")); return; }
    const kit = buildKit(items.map((it) => ({ id: it.id, name: it.name, path: app.library.path(it) })));
    await app.samples.loadAll(kit.filter(Boolean).map((k) => k.id), app.ctx);
    setPads((ps) => kit.forEach((k, i) => { if (k) Object.assign(ps[i], { sample: k.id, name: k.name.slice(0, 14), start: 0, end: 1, reverse: false, mute: false }); }));
    toast(`${kit.filter(Boolean).length} pads from ${path.split("/").pop() || "the library"}`);
    paint();
  }
  async function fill(path) {
    const items = app.library.under(path).slice(0, 16);
    if (!items.length) { toast("No samples in " + (path || "the library")); return; }
    await app.samples.loadAll(items.map((it) => it.id), app.ctx);
    setPads((ps) => items.forEach((it, i) => Object.assign(ps[i], { sample: it.id, name: it.name.slice(0, 14), start: 0, end: 1, reverse: false, mute: false })));
    toast(`Pads 1 to ${items.length} from ${path.split("/").pop()}`);
    paint();
  }

  function paint() {
    const t = track();
    if (!t) return;
    status.textContent = placing ? `Tap a pad to put “${placing.name}” there` : "Tap a sample to hear it and pick it, then tap a pad. Or build a whole kit from a folder.";
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
    btn("Build from this folder", () => build(lib.folder), "primary"),
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
    }));
  const body = h("div", { class: "kb" }, h("div", { class: "kb-lib" }, lib.el), h("div", { class: "kb-right" }, status, pads, actions));
  const s = sheet("Kit builder · " + track().name, body, { wide: true, full: true, actions: [{ label: "Done", primary: true }], onClose: () => lib.dispose() });
  paint();
  return { build, fill, close: s.close };
}
