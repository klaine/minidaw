/* Crest's side of the shared patch browser (presetbrowser.js): the factory library from ui_meta.json,
 * the Peak banks converted in this browser as banks of their own, the device's browse category (pb_cat,
 * shared with Move's Patch Category page), and the OLED screen as the header's name area. */
import { BrowseModel, presetHeader, storedFavourites } from "./presetbrowser.js";
import { h } from "./controls.js";

const CAT_HOLD_MS = 800; // after sending pb_cat, ignore the device's older reports this long

export function mountPatches(ui, { loadPreset, screen }) {
  const { store, meta, user } = ui;
  const factory = meta.library;
  const nFactory = factory.presets.length;
  const device = ui.link?.kind === "device" || !!window.schwungRemote;

  // The factory banks, then each converted Peak bank; its patches carry their category byte's id.
  const userBankId = (b) => "my:" + b.name;
  const library = () => {
    const categories = [...factory.categories], banks = [...factory.banks], presets = [...factory.presets];
    user.banks.forEach((b, k) => {
      banks.push({ id: userBankId(b), label: b.name });
      b.patches.forEach((p, j) => {
        const cat = p.cat || "";
        if (cat && !categories.some((c) => c.id === cat)) categories.push({ id: cat, label: factory.categoryLabels[cat] || cat });
        presets.push({ name: p.name, cat, bank: userBankId(b), user: [k, j] });
      });
    });
    return { ...factory, categories, banks, presets };
  };
  const model = new BrowseModel(library(), storedFavourites("crest.favourites.v1"));
  let banksSeen = user.banks.length;

  // `cur` is what this page loaded last; the device's own report wins when it names another patch.
  let cur = -1;
  const reported = () => {
    const i = parseInt(store.extra.preset ?? "-1", 10);
    return i >= 0 && i < nFactory && factory.presets[i].name === store.extra.preset_name ? i : -1;
  };
  const current = () => {
    const p = model.presets[cur];
    if (p && p.name === (store.extra.preset_name || "")) return cur;
    return reported();
  };
  // A loaded patch starts a fresh undo history, as loadPreset does (the load's report repaints Undo).
  const load = (i) => {
    const p = model.presets[i];
    if (!p) return;
    cur = i;
    if (p.user) {
      ui.loadState(user.state(p.user[0], p.user[1]));
      store.undoStack.length = store.redoStack.length = 0;
    } else loadPreset(i);
  };

  let visit = null; // the sound the drawer opened with
  const host = {
    noun: "patch",
    nouns: "patches",
    current,
    edited: () => store.undoStack.length > 0,
    name: () => store.extra.preset_name || "",
    load(i) {
      if (i === current() && !host.edited()) return;
      load(i);
    },
    begin() {
      visit = { i: current(), edited: host.edited(), blob: store.stateBlob(), undo: [...store.undoStack], redo: [...store.redoStack] };
    },
    keep() { visit = null; },
    revert() {
      if (!visit) return;
      if (visit.i >= 0 && !visit.edited) load(visit.i);
      else {
        ui.loadState(JSON.parse(visit.blob));
        cur = visit.i;
        store.undoStack.splice(0, Infinity, ...visit.undo); // the edits come back with their history
        store.redoStack.splice(0, Infinity, ...visit.redo);
      }
    },
    onChange(fn) {
      let undos = store.undoStack.length;
      store.onAny((keys) => {
        const n = store.undoStack.length;
        if (n !== undos || keys.includes("preset") || keys.includes("preset_name")) fn();
        undos = n;
      });
    },
    display: screen,
    paint(info) {
      const i = current();
      const p = model.presets[i];
      screen.setInfo(info, p ? [p.cat && model.catLabel(p.cat), model.bankLabel(model.bankOf(i))].filter(Boolean).join(" · ") : "");
    },
  };

  // The drawer's foot: load a Peak bank here (standalone), or where the Move takes them; remove one.
  const status = h("span", { class: "dim small", role: "status" });
  const file = h("input", { type: "file", accept: ".syx,application/octet-stream", hidden: true, multiple: true });
  const loadSyx = h("button", { type: "button", class: "chip", onclick: () => file.click() }, "Load Peak .syx…");
  const remove = h("button", { type: "button", class: "chip", hidden: true });
  const note = h("span", { class: "dim small" }, device
    ? "Peak banks are converted from Novation Peak SysEx. On the Move, put your own .syx banks under UserLibrary/Crest and open them from the Peak Banks page."
    : "Load your own Peak .syx bank or patch: it is converted here and stays in this browser.");
  host.tools = device ? h("div", {}, note) : h("div", {}, loadSyx, file, remove, status, note);
  const userBankInScope = () => user.banks.findIndex((b) => userBankId(b) === model.scope.bank);
  const paintTools = () => {
    const k = userBankInScope();
    remove.hidden = k < 0;
    if (k >= 0) remove.textContent = "Remove " + user.banks[k].name;
    const busy = user.banks.find((b) => b.levelled !== undefined && b.levelled < b.patches.length);
    status.textContent = busy ? `Levelling ${busy.name}: ${busy.levelled} of ${busy.patches.length}` : "";
  };
  remove.onclick = () => {
    const k = userBankInScope();
    if (k < 0) return;
    if (model.presets[cur]?.bank === userBankId(user.banks[k])) cur = -1;
    user.remove(k);
  };
  file.addEventListener("change", async () => {
    const files = [...file.files];
    file.value = "";
    for (const f of files) {
      status.textContent = "Converting " + f.name + "…";
      try {
        const k = await user.importFile(f);
        model.setScope({ bank: userBankId(user.banks[k]), cat: "" });
      } catch (err) {
        status.textContent = "";
        ui.toast("Could not load " + f.name + ": " + err.message);
      }
    }
  });
  user.onChange = () => {
    // a bank added or removed changes the library; levelling only the status line
    if (user.banks.length !== banksSeen) {
      banksSeen = user.banks.length;
      const was = model.presets[cur];
      model.setLibrary(library());
      cur = was ? model.presets.findIndex((p) => p.bank === was.bank && p.name === was.name) : -1;
    }
    paintTools();
  };
  model.onChange(paintTools);
  paintTools();

  // The category is the device's too: Move's Patch Category page and the chips set the same pb_cat
  // (0 = all patches, n = the factory library's categories[n - 1]).
  let sentAt = -Infinity;
  model.onChange((what) => {
    if (what !== "scope") return;
    const n = String(factory.categories.findIndex((c) => c.id === model.scope.cat) + 1);
    if (String(store.extra.pb_cat ?? "0") === n) return;
    store.extra.pb_cat = n;
    sentAt = performance.now();
    store.command("pb_cat", n);
  });
  store.bind("pb_cat", (v) => {
    if (v === undefined || performance.now() - sentAt < CAT_HOLD_MS) return;
    const c = factory.categories[parseInt(v, 10) - 1];
    model.setScope({ cat: c ? c.id : "" });
  });

  const nav = presetHeader(model, host);
  nav.classList.add("patch-nav");
  return nav;
}
