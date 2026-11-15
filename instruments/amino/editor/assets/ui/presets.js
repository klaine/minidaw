/* Amino's side of the shared preset browser (presetbrowser.js): the factory
 * library from ui_presets.json, the device's browse category (pb_cat, shared
 * with Move's Category page), undo steps and the Load Layer tab.  Mounted into
 * the header placeholder once the library has loaded (layout.js presetNav).
 */
import { BrowseModel, presetHeader, storedFavourites } from "./presetbrowser.js";
import { loadLibrary } from "./library.js";
import { snapshot } from "./history.js";
import { wireValue } from "./format.js";
import { ECHO_HOLD_MS } from "./store.js";

const FAV_KEY = "amino.favourites.v2";

/** Amino 1.1 kept favourites by bare name; carry them over once as "<bank>/<name>". */
function favourites() {
  try {
    if (localStorage.getItem(FAV_KEY) === null) {
      const old = JSON.parse(localStorage.getItem("amino.favourites") || "[]");
      localStorage.setItem(FAV_KEY, JSON.stringify(old.map((name) => "factory/" + name)));
    }
  } catch (e) { /* no storage */ }
  return storedFavourites(FAV_KEY);
}

export async function mountPresetNav(store, slot) {
  const lib = await loadLibrary();
  const model = new BrowseModel(lib, favourites());
  const presets = model.presets;

  // The device reports preset -1 once the sound is edited; stepping still
  // continues from the preset it started as.
  let last = -1;
  const reported = () => {
    const i = parseInt(store.get("preset"), 10);
    return Number.isInteger(i) && i >= 0 && i < presets.length ? i : -1;
  };
  const current = () => {
    const i = reported();
    if (i >= 0) return (last = i);
    if (last < 0) {
      const name = (store.get("preset_name") || "").trim().toLowerCase();
      last = presets.findIndex((p) => p.name.toLowerCase() === name);
    }
    return last;
  };
  const send = (i) => {
    last = i;
    store.values.preset = String(i);
    store.send("preset", i);
  };
  /** Put back an edited sound: one state write, and the cache follows at once. */
  const restore = (snap) => {
    const blob = { name: snap.preset_name || "" };
    for (const key in snap) {
      if (key !== "preset_name" && snap[key] !== undefined) blob[key] = wireValue(store.metaFor(key) || {}, snap[key]);
    }
    store.send("state", JSON.stringify(blob));
    const hold = store.now() + ECHO_HOLD_MS;
    for (const key in snap) {
      if (snap[key] === undefined || store.values[key] === snap[key]) continue;
      store.values[key] = snap[key];
      store.holdUntil[key] = hold;
      store.repaint(key);
    }
    store.values.preset = "-1";
    store.repaint("preset");
  };

  // One undo step per visit to the browser: the first audition records it and
  // later ones rename it, so ↑↓ through twenty presets is one Undo.
  let visit = null; // { index, snap, entry }
  const host = {
    noun: "preset",
    current,
    edited: () => current() >= 0 && reported() < 0,
    name: () => store.get("preset_name") || "",
    load(i, { audition = false } = {}) {
      if (i === reported()) return; // already loaded and unedited: nothing to do or undo
      const h = store.history;
      const label = "Load " + presets[i].name;
      if (audition && visit && visit.entry) {
        visit.entry.label = label;
        h?.emit();
      } else {
        h?.bulk(label);
        if (audition && visit && h) visit.entry = h.undos[h.undos.length - 1];
      }
      h?.resetCompare();
      send(i);
    },
    begin() { visit = { index: reported(), snap: snapshot(store), entry: null }; },
    keep() { visit = null; },
    revert() {
      if (!visit) return;
      if (visit.index >= 0) send(visit.index); else restore(visit.snap);
      const h = store.history;
      if (h && visit.entry && h.undos[h.undos.length - 1] === visit.entry) {
        h.undos.pop();
        h.emit();
      }
      visit.entry = null;
    },
    onChange(fn) {
      store.bind("preset", fn);
      store.bind("preset_name", fn);
    },
    views: [{
      label: "Load layer",
      placeholder: "Search layer sources",
      unit: "sources · the chosen layer replaces the focused one",
      rows: (q) => lib.layerSources.map((label, i) => {
        const [name, layer] = label.split("/");
        return { i, label, num: layer, name, note: "" };
      }).filter((r) => !q || r.label.toLowerCase().includes(q)),
      pick(r) {
        store.history?.bulk("Load layer " + r.label);
        store.send("layer_load_src", String(r.i));
        return "Loaded " + r.label + " into layer " + store.layer;
      },
    }],
  };

  // The category is the device's: Move's Category page and the chips set the
  // same pb_cat (0 = All, n = categories[n - 1]).
  model.onChange((what) => {
    if (what !== "scope") return;
    const n = String(model.scope.cat ? model.categories.findIndex((c) => c.id === model.scope.cat) + 1 : 0);
    if (store.get("pb_cat") === n) return;
    store.values.pb_cat = n;
    store.holdUntil.pb_cat = store.now() + ECHO_HOLD_MS;
    store.send("pb_cat", n);
  });
  store.bind("pb_cat", (v) => {
    const c = model.categories[parseInt(v, 10) - 1];
    model.setScope({ cat: c ? c.id : "" });
  });

  const nav = presetHeader(model, host);
  nav.classList.add("preset-nav");
  slot.replaceWith(nav);
  return nav;
}
