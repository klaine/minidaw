// Browsers: an instrument's presets (by category, with search), and samples (the built-in kit and loops, or a file).
import { h, pickFiles } from "../util.js";
import { sheet, toast } from "./controls.js";
import { BUILTIN_SAMPLES } from "../audio/samples.js";

/** The preset sheet: tap to hear (load), Done keeps it. onPick(i) loads preset i */
export function presetBrowser(app, meta, current, onPick) {
  const cats = ["All", ...new Set(meta.presets.map((p) => p.cat))];
  let cat = "All", query = "", sel = current;
  const list = h("div", { class: "pb-list" });
  const search = h("input", { class: "text pb-search", type: "search", placeholder: "Search " + meta.presets.length + " presets", oninput: () => { query = search.value.toLowerCase(); fill(); } });
  const catBar = h("div", { class: "pb-cats" });
  function fillCats() {
    catBar.textContent = "";
    for (const c of cats) catBar.append(h("button", { type: "button", class: "chip" + (c === cat ? " on" : ""), onclick: () => { cat = c; fillCats(); fill(); } }, c));
  }
  function fill() {
    list.textContent = "";
    meta.presets.forEach((p, i) => {
      if (cat !== "All" && p.cat !== cat) return;
      if (query && !p.name.toLowerCase().includes(query)) return;
      list.append(h("button", { type: "button", class: "pb-item" + (i === sel ? " on" : ""), onclick: () => { sel = i; onPick(i); fill(); } },
        h("span", { class: "pb-name" }, p.name), h("span", { class: "pb-cat" }, p.cat)));
    });
    if (!list.childElementCount) list.append(h("p", { class: "dim" }, "Nothing matches."));
  }
  fillCats();
  fill();
  sheet(meta.name + " presets", h("div", { class: "pb" }, search, catBar, list), { wide: true, actions: [{ label: "Done", primary: true }] });
  setTimeout(() => { const on = list.querySelector(".on"); if (on) on.scrollIntoView({ block: "center" }); }, 30);
}

/** Pick a sample: a built-in one-shot or loop (with a preview), or a file. -> {id, name, duration, bpm?} | null */
export function pickSample(app, { title = "Choose a sample", kinds = ["loop", "oneshot"] } = {}) {
  return new Promise((resolve) => {
    let done = false, preview = null;
    const stopPreview = () => { if (preview) { try { preview.stop(); } catch (_) { /* ended */ } preview = null; } };
    const play = async (id) => {
      stopPreview();
      const b = await app.samples.load(id, app.ctx);
      if (!b) return;
      const src = app.ctx.createBufferSource();
      src.buffer = b;
      src.connect(app.engine.master.input);
      src.start();
      preview = src;
    };
    const finish = async (id) => {
      const b = await app.samples.load(id, app.ctx);
      if (!b) { toast("Couldn't load that sample"); return; }
      const info = BUILTIN_SAMPLES.find((s) => s.id === id) || {};
      done = true;
      stopPreview();
      s.close();
      resolve({ id, name: app.samples.name(id), duration: b.duration, bpm: info.bpm });
    };
    const rows = (kind) => BUILTIN_SAMPLES.filter((x) => x.kind === kind).map((x) => h("div", { class: "smp-row" },
      h("button", { type: "button", class: "icon-btn", title: "Preview", onclick: () => play(x.id) }, "▶"),
      h("button", { type: "button", class: "smp-name", onclick: () => finish(x.id) }, x.name + (x.bpm ? ` · ${x.bpm} BPM` : ""))));
    const body = h("div", { class: "smp" },
      h("button", { type: "button", class: "btn primary", onclick: async () => {
        const files = await pickFiles("audio/*,.wav,.aif,.aiff,.mp3,.m4a,.flac,.ogg,.caf");
        if (!files.length) return;
        try {
          toast("Loading " + files[0].name + "…");
          const r = await app.samples.importFile(files[0], app.ctx);
          done = true; stopPreview(); s.close();
          resolve({ id: r.id, name: r.name, duration: r.duration });
        } catch (e) { toast("That file couldn't be decoded: " + (e.message || e), 4000); }
      } }, "Import an audio file…"),
      kinds.includes("loop") ? [h("h3", {}, "Loops"), ...rows("loop")] : null,
      kinds.includes("oneshot") ? [h("h3", {}, "One-shots"), ...rows("oneshot")] : null);
    const s = sheet(title, body, { onClose: () => { stopPreview(); if (!done) resolve(null); } });
  });
}
