// The sample library's browser: folders (tap to open; the path above goes back), samples (▶ hears one, a tap picks it),
// a search over every folder, and imports: a folder (its subfolders kept), a zip of one (on an iPad: Compress the
// folder in Files, then pick the zip), or files. Used by the sample picker and the kit builder.
import { h } from "../util.js";
import { menu, toast, confirmBox } from "./controls.js";
import { BUILTIN_ROOT } from "../library.js";
import { sweepSamples } from "../storage.js";

export class LibraryBrowser {
  /** o: { onPick(item), selectable (keep the picked one highlighted), folder (to open first), dragData } */
  constructor(app, o = {}) {
    this.app = app;
    this.o = o;
    this.lib = app.library;
    this.folder = o.folder ?? (localStorage.getItem("minidaw.libFolder") || "");
    this.query = "";
    this.selected = null;
    this.search = h("input", { class: "text lib-search", type: "search", placeholder: "Search every folder", "aria-label": "Search the library",
      oninput: () => { this.query = this.search.value.trim(); this.render(); } });
    const importBtn = h("button", { type: "button", class: "btn small primary", onclick: (e) => this.importMenu(e.currentTarget) }, "Import ▾");
    this.crumbs = h("div", { class: "lib-crumbs" });
    this.list = h("div", { class: "lib-list", role: "list" });
    this.el = h("div", { class: "lib" }, h("div", { class: "lib-top" }, this.search, importBtn), this.crumbs, this.list);
    this.off = this.lib.on(() => this.render());
    if (this.folder && !this.lib.under(this.folder).length) this.folder = "";
    this.render();
  }

  open(folder) {
    this.folder = folder;
    this.query = "";
    this.search.value = "";
    try { localStorage.setItem("minidaw.libFolder", folder); } catch (_) { /* private mode */ }
    this.render();
    if (this.o.onFolder) this.o.onFolder(folder);
  }

  render() {
    const lib = this.lib;
    this.crumbs.textContent = "";
    const parts = this.folder ? this.folder.split("/") : [];
    this.crumbs.append(h("button", { type: "button", class: "lib-crumb", onclick: () => this.open("") }, "Library"));
    parts.forEach((name, i) => {
      const path = parts.slice(0, i + 1).join("/");
      this.crumbs.append(h("span", { class: "lib-sep" }, "›"), h("button", { type: "button", class: "lib-crumb", onclick: () => this.open(path) }, name));
    });
    this.list.textContent = "";
    if (this.query) {
      const found = lib.search(this.query);
      if (!found.length) this.list.append(h("p", { class: "dim lib-empty" }, "Nothing called that."));
      for (const it of found) this.list.append(this.row(it, true));
      return;
    }
    const { folders, samples } = lib.list(this.folder);
    for (const f of folders) {
      const el = h("div", { class: "lib-folder", role: "listitem" },
        h("button", { type: "button", class: "lib-folder-btn", "aria-label": "Folder " + f.name, onclick: () => this.open(f.path) },
          h("span", { class: "lib-icon" }, "📁"), h("span", { class: "lib-name" }, f.name), h("span", { class: "dim lib-count" }, f.count + " ›")),
        f.path === BUILTIN_ROOT || f.path.startsWith(BUILTIN_ROOT + "/") ? null :
          h("button", { type: "button", class: "icon-btn small", "aria-label": "More for " + f.name, onclick: (e) => this.folderMenu(f, e.currentTarget) }, "⋯"));
      this.list.append(el);
    }
    for (const it of samples) this.list.append(this.row(it, false));
    if (!folders.length && !samples.length) this.list.append(h("p", { class: "dim lib-empty" }, "An empty folder."));
    if (!this.folder && !lib.items.length) {
      this.list.append(h("p", { class: "dim lib-empty" }, "Import a folder of samples (its subfolders stay as they are), a zip of one, or files: Import ▾. On an iPad, compress the folder in Files and import the zip. Folders can be dropped here too."));
    }
  }

  row(it, showFolder) {
    const sel = this.selected && this.selected.id === it.id;
    const pick = () => {
      if (this.o.selectable) { this.selected = it; this.render(); }
      if (this.o.onPick) this.o.onPick(it);
    };
    const el = h("div", { class: "lib-sample" + (sel ? " sel" : ""), role: "listitem", draggable: "true" },
      h("button", { type: "button", class: "icon-btn lib-play", "aria-label": "Hear " + it.name, onclick: (e) => { e.stopPropagation(); this.preview(it); } }, "▶"),
      h("button", { type: "button", class: "lib-sample-btn", "aria-label": it.name, onclick: pick },
        h("span", { class: "lib-name" }, it.name),
        showFolder ? h("span", { class: "dim lib-path" }, it.folder) : it.bpm ? h("span", { class: "dim lib-path" }, it.bpm + " BPM") : null),
      it.builtin ? null : h("button", { type: "button", class: "icon-btn small lib-more", "aria-label": "More for " + it.name, onclick: (e) => { e.stopPropagation(); this.sampleMenu(it, e.currentTarget); } }, "⋯"));
    el.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/x-minidaw-sample", it.id); e.dataTransfer.effectAllowed = "copy"; });
    return el;
  }

  async preview(it) {
    const app = this.app;
    this.stopPreview();
    const b = await app.samples.load(it.id, app.ctx);
    if (!b) { toast("Couldn't load " + it.name); return; }
    const src = app.ctx.createBufferSource();
    src.buffer = b;
    src.connect(app.engine.master.input);
    src.start();
    src.stop(app.ctx.currentTime + Math.min(b.duration, 6));
    this.previewing = src;
  }
  stopPreview() { if (this.previewing) { try { this.previewing.stop(); } catch (_) { /* ended */ } this.previewing = null; } }

  importMenu(anchor) {
    menu(anchor, [
      { label: "A folder (with its subfolders)…", onClick: () => this.importFolder() },
      { label: "A zip of a folder…", hint: "iPad", onClick: () => this.importZip() },
      { label: "Audio files…", onClick: () => this.importLoose() },
    ], { title: "Import samples" });
  }

  pick(attrs) {
    return new Promise((resolve) => {
      const input = h("input", { type: "file", style: { display: "none" }, ...attrs });
      input.addEventListener("change", () => { resolve([...input.files]); input.remove(); });
      document.body.append(input);
      input.click();
    });
  }
  async importFolder() {
    const files = await this.pick({ webkitdirectory: true, multiple: true });
    if (files.length) await this.run(() => this.lib.importFiles(files, this.progress()));
  }
  async importZip() {
    const [file] = await this.pick({ accept: ".zip,application/zip" });
    if (file) await this.run(() => this.lib.importZip(file, this.progress()));
  }
  async importLoose() {
    const files = await this.pick({ multiple: true, accept: "audio/*,.wav,.aif,.aiff,.mp3,.m4a,.flac,.ogg,.caf" });
    if (files.length) await this.run(() => this.lib.add(files.map((f) => ({ path: "Imported/" + f.name, file: f })), this.progress()));
  }
  progress() { return (n, total) => { this.crumbs.dataset.progress = `Importing ${n} of ${total}…`; }; }
  async run(job) {
    try {
      const r = await job();
      delete this.crumbs.dataset.progress;
      toast(`${r.added.length} sample${r.added.length === 1 ? "" : "s"} added` + (r.skipped ? `, ${r.skipped} skipped (not audio, or already there)` : ""));
      if (r.roots.length === 1) this.open(r.roots[0]);
      if (this.o.onImported) this.o.onImported(r);
      return r;
    } catch (e) {
      delete this.crumbs.dataset.progress;
      toast("Import failed: " + (e.message || e), 5000);
      return null;
    }
  }

  folderMenu(f, anchor) {
    const items = [{ label: "Open", onClick: () => this.open(f.path) }];
    if (this.o.folderActions) items.push(...this.o.folderActions(f));
    items.push("-", { label: "Remove from the library", danger: true, onClick: async () => {
      if (!(await confirmBox("Remove " + f.name, `Remove “${f.name}” and its ${f.count} sample${f.count === 1 ? "" : "s"} from the library? Projects using them keep them.`, "Remove", true))) return;
      await this.lib.removeFolder(f.path);
      await this.freed(f.count);
    } });
    menu(anchor, items, { title: f.path });
  }

  /** After `count` samples left the library: the ones nothing else uses are deleted from the browser's storage */
  async freed(count) {
    const gone = await sweepSamples(this.app).catch((e) => { console.error(e); return 0; });
    const kept = Math.max(0, count - gone);
    toast(`Removed from the library${gone ? `: ${gone} sample${gone === 1 ? "" : "s"} deleted from storage` : ""}${kept ? ` (${kept} kept: a project or a kit uses ${kept === 1 ? "it" : "them"})` : ""}`, 5000);
  }
  sampleMenu(it, anchor) {
    menu(anchor, [{ label: "Remove from the library", danger: true, onClick: async () => {
      if (!(await confirmBox("Remove " + it.name, `Remove “${it.name}” from the library? A project or kit that uses it keeps it; otherwise it is deleted.`, "Remove", true))) return;
      if (this.selected && this.selected.id === it.id) this.selected = null;
      await this.lib.removeItem(it.id);
      await this.freed(1);
    } }], { title: it.name });
  }

  dispose() { this.off(); this.stopPreview(); }
}
