// Browsers: an instrument's presets (by category, with search), and samples (the built-in kit and loops, or a file).
import { h } from "../util.js";
import { sheet, toast } from "./controls.js";
import { LibraryBrowser } from "./library.js";

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

/**
 * Pick a sample from the library (its folders, the built-in kit and loops, imports): -> {id, name, duration, bpm?} | null.
 * kinds ["loop"] or ["oneshot"]: the built-in folder to start in, the first time.
 */
export function pickSample(app, { title = "Choose a sample", kinds = ["loop", "oneshot"] } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const first = kinds.length === 1 ? (kinds[0] === "loop" ? "Built-in/Loops" : "Built-in/Drum kit") : undefined;
    const lib = new LibraryBrowser(app, {
      folder: localStorage.getItem("minidaw.libFolder") || first,
      onPick: async (it) => {
        const b = await app.samples.load(it.id, app.ctx);
        if (!b) { toast("Couldn't load " + it.name); return; }
        done = true;
        s.close();
        resolve({ id: it.id, name: it.name, duration: b.duration, bpm: it.bpm });
      },
    });
    const s = sheet(title, lib.el, { wide: true, onClose: () => { lib.dispose(); if (!done) resolve(null); } });
  });
}
