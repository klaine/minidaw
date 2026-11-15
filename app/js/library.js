// The sample library: every sample this browser keeps, in folders. Folders come with what's imported: a folder from
// the computer (its subfolders kept), a zip of one (the iPad's Files app makes those), files dropped or picked. The
// samples' bytes are in IndexedDB's samples store (js/db.js); the library is their index (misc "library"), without the
// bytes, so it lists hundreds without loading them. The built-in kit and loops are a folder of their own.
import { db } from "./db.js";
import { uid } from "./util.js";
import { BUILTIN_SAMPLES } from "./audio/samples.js";
import { unzip } from "./unzip.js";
import { natural } from "./kitmap.js";

export const AUDIO_EXT = /\.(wav|wave|aif|aiff|aifc|mp3|m4a|aac|flac|ogg|oga|opus|caf)$/i;
export const BUILTIN_ROOT = "Built-in";
const MIME = { wav: "audio/wav", wave: "audio/wav", aif: "audio/aiff", aiff: "audio/aiff", aifc: "audio/aiff", mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", caf: "audio/x-caf" };
const clean = (p) => String(p || "").split("/").map((x) => x.trim()).filter(Boolean).join("/");
const dirname = (p) => { const i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); };
const basename = (p) => p.slice(p.lastIndexOf("/") + 1);
const stem = (name) => name.replace(/\.[^.]+$/, "");

export class Library {
  constructor(samples) {
    this.samples = samples;
    this.items = [];   // { id, name, folder, size, type, addedAt }
    this.listeners = new Set();
    this.builtin = BUILTIN_SAMPLES.map((b) => ({ id: b.id, name: b.name, folder: BUILTIN_ROOT + "/" + (b.kind === "loop" ? "Loops" : "Drum kit"), builtin: true, bpm: b.bpm }));
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const fn of this.listeners) fn(); }

  async load() {
    const v = await db.get("library").catch(() => null);
    this.items = (v && v.items) || [];
    for (const it of this.items) this.samples.info.set(it.id, { id: it.id, name: it.name });
  }
  save() { return db.set("library", { items: this.items }); }

  all() { return [...this.builtin, ...this.items]; }
  path(it) { return (it.folder ? it.folder + "/" : "") + it.name; }

  /** The folders directly in `folder` ("" for the top) with how many samples each holds, and its own samples */
  list(folder = "") {
    folder = clean(folder);
    const pre = folder ? folder + "/" : "";
    const sub = new Map(), samples = [];
    for (const it of this.all()) {
      if (it.folder === folder) { samples.push(it); continue; }
      if (folder && !it.folder.startsWith(pre)) continue;
      const rest = it.folder.slice(pre.length);
      if (!rest) continue;
      const name = rest.split("/")[0];
      sub.set(name, (sub.get(name) || 0) + 1);
    }
    return {
      folders: [...sub].map(([name, count]) => ({ name, path: pre + name, count })).sort((a, b) => (a.path === BUILTIN_ROOT ? -1 : b.path === BUILTIN_ROOT ? 1 : natural(a.name, b.name))),
      samples: samples.sort((a, b) => natural(a.name, b.name)),
    };
  }
  /** Every sample in a folder and its subfolders */
  under(folder) {
    folder = clean(folder);
    return this.all().filter((it) => it.folder === folder || it.folder.startsWith(folder + "/")).sort((a, b) => natural(this.path(a), this.path(b)));
  }
  search(q) {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    return this.all().filter((it) => { const s = this.path(it).toLowerCase(); return words.every((w) => s.includes(w)); })
      .sort((a, b) => natural(this.path(a), this.path(b))).slice(0, 300);
  }

  /** A sample already saved elsewhere (a pad's import, a recording): listed in its folder */
  async remember({ id, name, folder, size, type }) {
    if (this.items.some((it) => it.id === id)) return;
    this.items.push({ id, name, folder: clean(folder), size: size || 0, type: type || "audio/wav", addedAt: Date.now() });
    await this.save();
    this.emit();
  }

  /**
   * Files into the library: [{ path: "Kit/Kicks/BD.wav", bytes?: ArrayBuffer|Uint8Array, file?: File }]. Not audio:
   * skipped; the same name and size in the same folder: skipped. -> { added: [items], skipped, roots: [top folders] }
   */
  async add(entries, onProgress) {
    const added = [];
    let skipped = 0, n = 0;
    const roots = new Set();
    const audio = entries.filter((e) => AUDIO_EXT.test(e.path));
    skipped += entries.length - audio.length;
    for (const e of audio) {
      n++;
      const path = clean(e.path);
      const folder = dirname(path) || "Imported";
      const name = stem(basename(path));
      const raw = e.bytes || (await e.file.arrayBuffer());
      const bytes = raw instanceof Uint8Array ? raw.slice().buffer : raw;
      const size = bytes.byteLength;
      if (this.items.some((it) => it.folder === folder && it.name === name && it.size === size)) { skipped++; continue; }
      const id = uid("s");
      const ext = (path.match(/\.([^.]+)$/) || [])[1] || "wav";
      const type = (e.file && e.file.type) || MIME[ext.toLowerCase()] || "audio/wav";
      await db.saveSample({ id, name, bytes, type, folder, createdAt: Date.now() });
      const it = { id, name, folder, size, type, addedAt: Date.now() };
      this.items.push(it);
      this.samples.info.set(id, { id, name });
      added.push(it);
      roots.add(folder.split("/")[0]);
      if (onProgress && n % 8 === 0) onProgress(n, audio.length);
    }
    await this.save();
    this.emit();
    return { added, skipped, roots: [...roots] };
  }

  /** Files from a file input: a folder's (webkitdirectory: their relative paths) or picked files ("Imported") */
  importFiles(files, onProgress) {
    return this.add([...files].map((f) => ({ path: f.webkitRelativePath || "Imported/" + f.name, file: f })), onProgress);
  }

  /** A zip: its folders under a folder named after it (unless it holds a single folder already) */
  async importZip(file, onProgress) {
    const files = (await unzip(await file.arrayBuffer())).filter((f) => AUDIO_EXT.test(f.path));
    if (!files.length) return { added: [], skipped: 0, roots: [] };
    const tops = new Set(files.map((f) => f.path.split("/")[0]));
    const single = tops.size === 1 && files.every((f) => f.path.includes("/"));
    const root = stem(file.name);
    return this.add(files.map((f) => ({ path: single ? f.path : root + "/" + f.path, bytes: f.bytes })), onProgress);
  }

  /** Dropped items (folders included, read through their FileSystemEntry), zips unpacked */
  async importDropped(entries, onProgress) {
    const files = [];
    const walk = async (entry, prefix) => {
      if (entry.isFile) {
        const file = await new Promise((res, rej) => entry.file(res, rej));
        files.push({ path: prefix + entry.name, file });
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        for (;;) {
          const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
          if (!batch.length) break;
          for (const e of batch) if (!e.name.startsWith(".")) await walk(e, prefix + entry.name + "/");
        }
      }
    };
    for (const e of entries) await walk(e, "");
    const zips = files.filter((f) => /\.zip$/i.test(f.path));
    const result = await this.add(files.filter((f) => !/\.zip$/i.test(f.path)), onProgress);
    for (const z of zips) {
      const r = await this.importZip(z.file, onProgress);
      result.added.push(...r.added);
      result.skipped += r.skipped;
      result.roots.push(...r.roots);
    }
    return result;
  }

  /** Out of the library (the samples themselves stay: projects may use them) */
  async removeFolder(folder) {
    folder = clean(folder);
    this.items = this.items.filter((it) => !(it.folder === folder || it.folder.startsWith(folder + "/")));
    await this.save();
    this.emit();
  }
}

/** Saved kits: the 16 pads' samples and settings, by name */
export const kits = {
  async list() { return ((await db.get("kits").catch(() => null)) || []).sort((a, b) => natural(a.name, b.name)); },
  async save(name, pads) {
    const all = (await db.get("kits").catch(() => null)) || [];
    const kit = { id: uid("k"), name, pads: JSON.parse(JSON.stringify(pads)), savedAt: Date.now() };
    await db.set("kits", [...all.filter((k) => k.name !== name), kit]);
    return kit;
  },
  async remove(id) { const all = (await db.get("kits").catch(() => null)) || []; await db.set("kits", all.filter((k) => k.id !== id)); },
};
