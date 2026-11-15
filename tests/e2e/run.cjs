// node tests/e2e/run.cjs [flow names...]: minidaw's user flows in Chromium at an iPad's size, with touch.
//
// The rules, so a pass means something:
//   - Everything is done the way a person does it: taps, drags, long presses, typing, the file chooser, downloads,
//     file drops (built from real WAV / MIDI bytes). No flow calls the app's functions to make something happen.
//   - What is checked is what a person would notice: sound (the level at the app's own meters, i.e. its analysers
//     on the real audio graph), what's on screen, what survives a reload, and exported files, decoded here in node.
//     Reading the project's state is allowed as an observation (where a canvas shows it), never to change it.
//   - Every flow starts from a fresh browser profile (the demo song) and fails on any page error.
// Needs Playwright with its Chromium (require("playwright")). Results and screenshots: test-results/e2e/.
const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { makeWav, makeMidi, readWav, makeZip, kitFiles, writeKitFolder, anonymousDrums, readZip, fakeMidi } = require("./files.cjs");

const ROOT = path.join(__dirname, "..", "..");
const APP = path.join(ROOT, "app");
const OUT = path.join(ROOT, "test-results", "e2e");
const IPAD = { width: 1180, height: 820 };

// ---- a static server for app/ (no python needed) ----
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".wasm": "application/wasm", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png", ".bin": "application/octet-stream", ".p8bank": "application/octet-stream" };
function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
      if (p.endsWith("/")) p += "index.html";
      const file = path.join(APP, path.normalize(p));
      if (!file.startsWith(APP) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
      fs.createReadStream(file).pipe(res);
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

// ---- helpers: acting like a person ----
class User {
  constructor(page, base) { this.page = page; this.base = base; }
  async boot({ sw = false } = {}) {
    const p = this.page;
    await p.goto(this.base + (sw ? "/" : "/?nosw"));
    await p.getByRole("button", { name: "Start" }).waitFor({ state: "visible" });
    await p.waitForFunction(() => !document.getElementById("boot-start").disabled);
    await p.getByRole("button", { name: "Start" }).tap();
    await p.locator(".topbar").waitFor();
    await this.until(() => [...window.minidaw.engine.channels.values()].every((c) => c.kind === null || c.instrument || c.error), "the instruments load", 20000);
  }
  /** Wait until fn() (run in the page) is true */
  async until(fn, what, timeout = 8000, arg) {
    try { await this.page.waitForFunction(fn, arg, { timeout, polling: 50 }); }
    catch (e) { throw new Error("timed out waiting for " + what); }
  }
  button(name, scope) { return (scope || this.page).getByRole("button", { name }).first(); }
  async tap(name, scope) { await this.button(name, scope).tap(); }
  async tapAt(x, y) { await this.page.touchscreen.tap(x, y); }
  async doubleTapAt(x, y) { await this.page.touchscreen.tap(x, y); await this.page.waitForTimeout(80); await this.page.touchscreen.tap(x, y); }
  async longPressAt(x, y, ms = 650) { const m = this.page.mouse; await m.move(x, y); await m.down(); await this.page.waitForTimeout(ms); await m.up(); }
  async drag(x0, y0, x1, y1, steps = 12) {
    const m = this.page.mouse;
    await m.move(x0, y0); await m.down();
    for (let i = 1; i <= steps; i++) { await m.move(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps); await this.page.waitForTimeout(10); }
    await m.up();
  }
  async box(locator) { await locator.waitFor({ state: "visible" }); return locator.boundingBox(); }
  /** A finger's swipe: real touch events, so the browser may take it for a scroll (as on an iPad) */
  async swipe(x0, y0, x1, y1, steps = 10) {
    const cdp = this.cdp || (this.cdp = await this.page.context().newCDPSession(this.page));
    const pt = (x, y) => [{ x: Math.round(x), y: Math.round(y), id: 1 }];
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pt(x0, y0) });
    for (let i = 1; i <= steps; i++) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pt(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps) }); await this.page.waitForTimeout(16); }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await this.page.waitForTimeout(120);
  }
  /** A tab: the views (Arrange, Session, Mixer) or the panel's (Device, Clip, Keys) */
  async tab(name) { await this.page.locator(".seg-btn", { hasText: new RegExp("^" + name + "$") }).first().tap(); }
  /** A button in the open sheet's footer (Done, Import, Export, OK) */
  async sheetButton(name) { await this.page.locator(".sheet-foot .btn", { hasText: new RegExp("^" + name + "$") }).last().tap(); }
  async menuItem(label) { await this.page.locator(".menu-item", { hasText: label }).first().tap(); }
  /** A file through the system's file chooser, after `trigger` opens it */
  async chooseFile(trigger, file) {
    const [chooser] = await Promise.all([this.page.waitForEvent("filechooser"), trigger()]);
    await chooser.setFiles(file);
  }
  /** Files dropped (as from the Finder or the iPad's Files app) at a point */
  async dropFiles(x, y, files) {
    await this.page.evaluate(({ x, y, files }) => {
      const dt = new DataTransfer();
      for (const f of files) dt.items.add(new File([new Uint8Array(f.bytes)], f.name, { type: f.type }));
      const el = document.elementFromPoint(x, y) || document.body;
      for (const t of ["dragenter", "dragover", "drop"]) el.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt }));
    }, { x, y, files: files.map((f) => ({ ...f, bytes: Array.from(f.bytes) })) });
  }
  // ---- observing ----
  /** The loudest level (0..1) a track's meter (or the master's, name null) shows over `ms` */
  async level(trackName, ms = 1500) {
    return this.page.evaluate(async ({ trackName, ms }) => {
      const a = window.minidaw;
      const t = trackName && a.store.project.tracks.find((x) => x.name === trackName);
      if (trackName && !t) throw new Error("no track " + trackName);
      let pk = 0;
      const end = performance.now() + ms;
      while (performance.now() < end) {
        pk = Math.max(pk, t ? a.engine.trackPeak(t.id) : a.engine.masterPeak());
        await new Promise((r) => setTimeout(r, 30));
      }
      return pk;
    }, { trackName, ms });
  }
  state(fn, arg) { return this.page.evaluate(fn, arg); }
  track(name) { return this.state((n) => { const t = window.minidaw.store.project.tracks.find((x) => x.name === n); return t && JSON.parse(JSON.stringify(t)); }, name); }
  /** Where the arrangement draws song beat `beat` on track `name`'s lane (page coordinates), scrolled into view the
   *  way a person would (the mouse wheel over the tracks) */
  async lanePoint(name, beat) {
    for (let i = 0; i < 20; i++) {
      const r = await this.state(({ name, beat }) => {
        const a = window.minidaw, v = a.views.arrange;
        const row = v.rows().find((x) => x.track.name === name && !x.lane);
        const c = v.lanes.getBoundingClientRect();
        if (!row) return null;
        const y = c.top + row.y - v.scroll.scrollTop + row.h / 2;
        return { x: c.left + v.bx(beat), y, top: c.top + 10, bottom: c.top + v.scroll.clientHeight - 10 };
      }, { name, beat });
      if (!r) throw new Error("no lane for " + name);
      if (r.y >= r.top && r.y <= r.bottom) return { x: r.x, y: r.y };
      const h = await this.box(this.page.locator(".arr-headers"));
      await this.page.mouse.move(h.x + 60, Math.min(r.bottom, h.y + h.height) - 20);
      await this.page.mouse.wheel(0, r.y > r.bottom ? 60 : -60);
      await this.page.waitForTimeout(60);
    }
    throw new Error(name + "'s lane can't be scrolled into view");
  }
  /** In the sample library (a sheet): from the top, into folders, then a sample picked */
  async libraryPick(folders, sample) {
    const lib = this.page.locator(".lib").last();
    await lib.locator(".lib-crumb", { hasText: /^Library$/ }).tap();
    for (const f of folders) await lib.getByRole("button", { name: "Folder " + f, exact: true }).tap();
    await lib.getByRole("button", { name: sample, exact: true }).tap();
  }
  /** A step of a row in the step sequencer */
  step(pad, n) { return this.page.getByRole("button", { name: `${pad} step ${n}`, exact: true }); }
  /** The open piano roll's layout (the Kick row, beats 1-4), once it stays the same over a few frames */
  async settledRoll() {
    let last = "";
    for (let i = 0; i < 40; i++) {
      const g = await this.state(async () => {
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const pr = window.minidaw.views.panel.child;
        if (!pr || !pr.surf || !pr.surf.w) return null;
        return { kickY: pr.py(36) + pr.rowH / 2, beatX: [0, 1, 2, 3].map((b) => pr.bx(b) + 6), w: pr.surf.w };
      });
      const key = JSON.stringify(g);
      if (g && key === last) return g;
      last = key;
    }
    throw new Error("the piano roll never settled");
  }
  header(name) { return this.page.locator(".th", { has: this.page.locator(".th-name", { hasText: new RegExp("^" + name + "$") }) }); }
}

const db = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
const near = (a, b, eps) => Math.abs(a - b) <= eps;

// ---- the flows ----
const FLOWS = {
  async "first start: the demo plays and stops"(u) {
    await u.boot();
    for (const n of ["Drums", "Bass", "Pad", "Pluck", "Lead", "Tops"]) await u.header(n).waitFor();
    assert.ok((await u.level(null, 400)) < 0.001, "silent before Play");
    await u.tap("Play (space)");
    const lvl = await u.level(null, 2000);
    assert.ok(db(lvl) > -24, `the demo is audible (${db(lvl).toFixed(1)} dBFS)`);
    const pos = await u.page.locator(".tb-bars").textContent();
    assert.notStrictEqual(pos, "1.1.1", "the position moves");
    await u.tap("Stop (twice: to the start)");
    await u.page.waitForTimeout(600);
    assert.strictEqual(await u.page.locator(".tb-bars").textContent(), "1.1.1", "Stop goes back to where play started");
    assert.ok((await u.level(null, 600)) < 0.02, "quiet after Stop");
  },

  async "a beat from scratch: new project, draw kicks, hear them"(u) {
    await u.boot();
    await u.tap("Projects and settings");
    await u.menuItem("New project");
    await u.header("Drums").waitFor();
    await u.header("Crest").waitFor();
    const p = await u.lanePoint("Drums", 0.5);
    await u.doubleTapAt(p.x, p.y);
    // a Drum Rack's clip opens in the step sequencer: kicks on steps 1, 5, 9 and 13
    for (const n of [1, 5, 9, 13]) await u.step("Kick", n).tap();
    const notes = await u.state(() => window.minidaw.store.selectedClip.notes.map((n) => [n.p, n.t]));
    assert.deepStrictEqual(notes, [[36, 0], [36, 1], [36, 2], [36, 3]], "four kicks on the beats, got " + JSON.stringify(notes));
    await u.tap("Play (space)");
    const lvl = await u.level("Drums", 2000);
    assert.ok(db(lvl) > -30, `the kicks are heard (${db(lvl).toFixed(1)} dBFS)`);
    assert.ok(await u.page.locator(".tb-back").isHidden(), "nothing takes the track off the arrangement");
  },

  async "drum pads: choose a sample, trim it, tune it, hear it"(u) {
    await u.boot();
    await u.header("Drums").locator(".th-name").tap();
    await u.tab("Device");
    await u.button("Pad 2: Snare").tap();
    await u.page.locator(".drum-pad-title", { hasText: "Pad 2 · Snare" }).waitFor();
    // a different sample from the picker
    await u.tap("Sample: Snare");
    await u.libraryPick(["Built-in", "Drum kit"], "Clap");
    await u.page.locator(".drum-pad-title", { hasText: "Pad 2 · Clap" }).waitFor();
    // trim: drag the end marker to about a third
    const wave = await u.box(u.page.locator(".drum-wave"));
    await u.drag(wave.x + wave.width - 9, wave.y + 40, wave.x + 8 + (wave.width - 16) * 0.33, wave.y + 40);
    // tune: the Pitch knob up
    const knob = await u.box(u.page.locator(".drum-knobs .knob", { hasText: "Pitch" }));
    await u.drag(knob.x + knob.width / 2, knob.y + 20, knob.x + knob.width / 2, knob.y - 20);
    const pad = (await u.track("Drums")).instrument.state.pads[1];
    assert.strictEqual(pad.sample, "builtin:clap");
    assert.ok(near(pad.end, 0.33, 0.03), "the end trimmed to a third (" + pad.end + ")");
    assert.ok(pad.pitch > 0, "pitched up (" + pad.pitch + ")");
    assert.ok(/\+\d+ st/.test(await u.page.locator(".drum-knobs .knob", { hasText: "Pitch" }).textContent()), "the knob shows the pitch");
    // the edits are undoable as steps
    await u.tap("Undo");
    assert.strictEqual((await u.track("Drums")).instrument.state.pads[1].pitch, 0, "Undo takes the pitch back");
    // tap the waveform: the pad sounds
    await u.tapAt(wave.x + wave.width / 2, wave.y + 30);
    assert.ok(db(await u.level("Drums", 600)) > -40, "tapping the waveform plays the pad");
  },

  async "drum pads: import a file, drop a file, pad menu"(u) {
    await u.boot();
    await u.header("Drums").locator(".th-name").tap();
    await u.tab("Device");
    await u.button("Pad 6: Low Tom").tap();
    // long press: the pad's menu, then import through the file chooser
    const tom = await u.box(u.button("Pad 6: Low Tom"));
    await u.longPressAt(tom.x + tom.width / 2, tom.y + tom.height / 2);
    await u.page.locator(".menu-title", { hasText: "Pad 6" }).waitFor();
    await u.chooseFile(() => u.menuItem("Import an audio file"), { name: "My Tom.wav", mimeType: "audio/wav", buffer: makeWav({ freq: 110, seconds: 0.4 }) });
    await u.page.locator(".drum-pad-title", { hasText: "Pad 6 · My Tom" }).waitFor();
    // drop a file onto pad 8
    const hi = await u.box(u.button("Pad 8: High Tom"));
    await u.dropFiles(hi.x + hi.width / 2, hi.y + hi.height / 2, [{ name: "Blip.wav", type: "audio/wav", bytes: makeWav({ freq: 880, seconds: 0.2 }) }]);
    await u.page.locator(".pad", { hasText: "Blip" }).waitFor();
    const pads = (await u.track("Drums")).instrument.state.pads;
    assert.strictEqual(pads[5].name, "My Tom");
    assert.strictEqual(pads[7].name, "Blip");
    assert.ok(!pads[5].sample.startsWith("builtin:") && !pads[7].sample.startsWith("builtin:"), "the pads hold the imported samples");
    await u.button("Pad 8: Blip").tap();
    assert.ok(db(await u.level("Drums", 500)) > -30, "the dropped sample plays");
    // copy pad 8 onto pad 16 through the menus
    const p8 = await u.box(u.button("Pad 8: Blip"));
    await u.longPressAt(p8.x + p8.width / 2, p8.y + p8.height / 2);
    await u.menuItem("Copy pad");
    const p16 = await u.box(u.button("Pad 16: Zap"));
    await u.longPressAt(p16.x + p16.width / 2, p16.y + p16.height / 2);
    await u.menuItem("Paste pad");
    assert.strictEqual((await u.track("Drums")).instrument.state.pads[15].name, "Blip", "pasted onto pad 16");
  },

  async "drum pads: a trimmed pad sounds shorter"(u) {
    await u.boot();
    await u.header("Drums").locator(".th-name").tap();
    await u.tab("Device");
    const kick = u.button("Pad 1: Kick");
    // how long the pad sounds: a tap, then the meter followed until it falls 40 dB below its peak
    const ring = async () => {
      const b = await u.box(kick);
      await u.page.waitForTimeout(700);
      const [series] = await Promise.all([
        u.state(async () => {
          const a = window.minidaw, id = a.store.project.tracks.find((t) => t.name === "Drums").id, out = [], t0 = performance.now();
          while (performance.now() - t0 < 900) { out.push([performance.now() - t0, a.engine.trackPeak(id)]); await new Promise((r) => requestAnimationFrame(r)); }
          return out;
        }),
        u.tapAt(b.x + b.width / 2, b.y + b.height / 2),
      ]);
      const pk = Math.max(...series.map((x) => x[1]));
      const on = series.filter((x) => x[1] > pk * 0.01);
      return { pk, ms: on.length ? on[on.length - 1][0] - on[0][0] : 0 };
    };
    const full = await ring();
    const wave = await u.box(u.page.locator(".drum-wave"));
    await u.drag(wave.x + wave.width - 9, wave.y + 40, wave.x + 8 + (wave.width - 16) * 0.08, wave.y + 40);
    const end = (await u.track("Drums")).instrument.state.pads[0].end;
    assert.ok(end < 0.12, "the end marker moved to under 12 % (" + end + ")");
    const short = await ring();
    assert.ok(full.pk > 0.05 && short.pk > 0.05, "the pad sounds both times");
    assert.ok(short.ms < full.ms * 0.5, `trimmed, it rings ${short.ms.toFixed(0)} ms, the whole kick ${full.ms.toFixed(0)} ms`);
  },

  async "a drum clip leads to the pad sounds"(u) {
    await u.boot();
    const p = await u.lanePoint("Drums", 1);
    await u.doubleTapAt(p.x, p.y);
    // tap the Snare row's name in the steps, then Pad sounds: that pad's editor
    await u.page.locator(".st-name", { hasText: "Snare" }).tap();
    await u.tap("Pad sounds");
    await u.page.locator(".drum-pad-title", { hasText: "Pad 2 · Snare" }).waitFor({ timeout: 3000 });
  },

  async "a synth: add a track, pick a preset, turn a knob, play the keys"(u) {
    await u.boot();
    await u.tap("Add a track");
    await u.menuItem("Crest track");
    await u.until(() => { const t = window.minidaw.store.selectedTrack; return t && t.instrument && t.instrument.kind === "crest" && window.minidaw.engine.instrument(t.id); }, "the Crest track to load");
    await u.page.locator(".dev-preset-btn").tap();
    await u.page.locator(".pb-cats .chip", { hasText: "Bass" }).tap();
    await u.page.locator(".pb-item", { hasText: "Sub Bass" }).tap();
    await u.sheetButton("Done");
    await u.page.locator(".dev-preset-name", { hasText: "Sub Bass" }).waitFor();
    const engineName = await u.state(() => window.minidaw.engine.instrument(window.minidaw.store.ui.selTrack).get("preset_name"));
    assert.strictEqual(engineName, "Sub Bass", "the engine runs the preset");
    const cut0 = Number(await u.state(() => window.minidaw.engine.instrument(window.minidaw.store.ui.selTrack).get("flt_cut")));
    const k = await u.box(u.page.locator(".dev-knobs .knob", { hasText: "Cutoff" }));
    await u.drag(k.x + k.width / 2, k.y + 20, k.x + k.width / 2, k.y + 60);
    await u.page.waitForTimeout(100);
    const cut1 = Number(await u.state(() => window.minidaw.engine.instrument(window.minidaw.store.ui.selTrack).get("flt_cut")));
    assert.ok(cut1 < cut0 - 0.05, `the Cutoff knob turned the engine's cutoff down (${cut0} -> ${cut1})`);
    await u.tab("Keys");
    const key = await u.box(u.page.locator(".kb-key.white").nth(3));
    await u.page.mouse.move(key.x + key.width / 2, key.y + key.height * 0.8);
    await u.page.mouse.down();
    const lvl = await u.level("Crest", 700);
    await u.page.mouse.up();
    assert.ok(db(lvl) > -45, `the keys play it (${db(lvl).toFixed(1)} dBFS; silence is below -90)`);
  },

  async "an instrument's own editor drives its track"(u) {
    await u.boot();
    await u.header("Bass").locator(".th-name").tap();
    await u.tab("Device");
    await u.tap("Edit Crest");
    const frame = u.page.frameLocator(".editor-frame");
    await frame.getByText("Dirty Bass").first().waitFor({ timeout: 10000 });
    // the editor's own next-patch arrow
    const before = await u.state(() => window.minidaw.engine.instrument(window.minidaw.store.ui.selTrack).get("preset"));
    await frame.getByRole("button", { name: /^Next/ }).first().tap();
    await u.page.waitForTimeout(500);
    const after = await u.state(() => window.minidaw.engine.instrument(window.minidaw.store.ui.selTrack).get("preset"));
    assert.notStrictEqual(after, before, `the editor changed the track's patch (${before} -> ${after})`);
    await u.page.locator(".editor-head").getByRole("button", { name: "Done" }).tap();
    await u.page.locator(".editor-veil").waitFor({ state: "detached" });
    await u.page.waitForTimeout(300);
    const shown = await u.page.locator(".dev-preset-name").textContent();
    const name = await u.state(() => window.minidaw.engine.instrument(window.minidaw.store.ui.selTrack).get("preset_name"));
    assert.strictEqual(shown, name, "the device panel shows the patch the editor chose");
  },

  async "session: tap clips to play just them, tap again to stop"(u) {
    await u.boot();
    await u.tab("Session");
    const clip = (name, n = 0) => u.page.getByRole("button", { name: name + ": tap to play or stop" }).nth(n);
    await clip("Beat A").tap();
    const [d, b, pad] = [await u.level("Drums", 1500), await u.level("Bass", 600), await u.level("Pad", 600)];
    assert.ok(db(d) > -35, `the tapped clip plays (${db(d).toFixed(1)} dBFS)`);
    assert.ok(b < 0.002 && pad < 0.002, "and nothing else: no arrangement under it");
    await clip("Chords").tap();
    assert.ok(db(await u.level("Pad", 3000)) > -40, "a second clip joins on the bar");
    await clip("Beat A").tap();
    await u.page.waitForTimeout(2500);
    assert.ok((await u.level("Drums", 700)) < 0.002, "tapped again, the drums stop");
    assert.ok(db(await u.level("Pad", 800)) > -40, "while the chords play on");
    // the pencil: the clip in its editor
    await u.page.getByRole("button", { name: "Edit Fill" }).tap();
    await u.page.locator(".st-grid").waitFor();
    assert.strictEqual(await u.state(() => window.minidaw.store.selectedClip.name), "Fill", "✎ opens that clip");
  },

  async "step sequencer: steps, accents, a ratchet, painting, pages, swing"(u) {
    await u.boot();
    await u.tab("Session");
    // a new clip in an empty slot of the Drums (double tap), in the steps
    const slot = u.page.locator('.ses-slot[data-scene="5"]').first();
    await slot.dblclick();
    await u.page.locator(".st-grid").waitFor();
    for (const n of [1, 5, 9, 13]) await u.step("Kick", n).tap();
    await u.tap("Accent");
    for (const n of [5, 13]) await u.step("Snare", n).tap();
    await u.tap("Accent");
    // paint closed hats along steps 9-12: one drag
    const a = await u.box(u.step("Closed Hat", 9)), b = await u.box(u.step("Closed Hat", 12));
    await u.drag(a.x + a.width / 2, a.y + a.height / 2, b.x + b.width / 2, b.y + b.height / 2);
    // a ratchet on hat step 3: hold for the step's menu
    const h3 = await u.box(u.step("Closed Hat", 3));
    await u.longPressAt(h3.x + h3.width / 2, h3.y + h3.height / 2);
    await u.menuItem("Ratchet ×3");
    const notes = await u.state(() => window.minidaw.store.selectedClip.notes.map((n) => [n.p, +n.t.toFixed(3), n.v]).sort((x, y) => x[0] - y[0] || x[1] - y[1]));
    const of = (p) => notes.filter((n) => n[0] === p);
    assert.deepStrictEqual(of(36).map((n) => n[1]), [0, 1, 2, 3], "kicks on the beats");
    assert.ok(of(37).length === 2 && of(37).every((n) => n[2] === 127), "accented snares on 2 and 4");
    assert.deepStrictEqual(of(38).map((n) => n[1]), [0.5, 0.583, 0.667, 2, 2.25, 2.5, 2.75], "a ratchet of three on step 3, and the painted run on 9-12");
    await u.tap("Undo");
    assert.strictEqual((await u.state(() => window.minidaw.store.selectedClip.notes.filter((n) => n.p === 38).length)), 4, "Undo takes the ratchet back as one step");
    // two bars: page 2
    await u.page.locator(".st-toolbar").getByTitle("A bar longer").tap();
    await u.button("Page 2").tap();
    await u.step("Kick", 17).tap();
    assert.ok(await u.state(() => window.minidaw.store.selectedClip.notes.some((n) => n.p === 36 && n.t === 4)), "page 2's first step is beat 5");
    // swing: the knob up
    const k = await u.box(u.page.locator(".st-toolbar .knob", { hasText: "Swing" }));
    await u.drag(k.x + k.width / 2, k.y + 20, k.x + k.width / 2, k.y - 30);
    assert.ok(await u.state(() => window.minidaw.store.selectedClip.swing > 0.15), "swing set");
    // play it: heard, and the playhead walks the steps
    await u.page.getByRole("button", { name: /^Recorded|^Drums: tap to play or stop/ }).first().tap().catch(async () => { await u.tap("Play (space)"); });
    await u.until(() => !!document.querySelector(".st-cell.now"), "the playhead in the steps", 4000);
    assert.ok(db(await u.level("Drums", 1500)) > -35, "the beat plays");
  },

  async "kit builder: a folder with subfolders becomes a kit"(u) {
    await u.boot();
    await u.header("Drums").locator(".th-name").tap();
    await u.tab("Device");
    await u.tap("Kit builder…");
    const lib = u.page.locator(".kb .lib");
    await lib.waitFor();
    await u.tap("Import ▾");
    const dir = writeKitFolder(OUT, "Studio Kit");
    await u.chooseFile(() => u.menuItem("A folder (with its subfolders)"), dir);
    await u.page.locator(".toast", { hasText: "8 samples added, 1 skipped" }).waitFor({ timeout: 10000 });
    // the folders as they were
    await lib.locator(".lib-crumb", { hasText: /^Studio Kit$/ }).waitFor();
    const folders = await lib.locator(".lib-folder .lib-name").allTextContents();
    assert.deepStrictEqual(folders, ["Claps", "Hats", "Kicks", "Perc", "Snares"], "the subfolders kept");
    await u.tap("Build from this folder");
    await u.until(() => window.minidaw.store.project.tracks.find((t) => t.name === "Drums").instrument.state.pads[0].name !== "Kick", "the pads to change", 8000);
    const pads = (await u.track("Drums")).instrument.state.pads.map((p) => p.name);
    assert.deepStrictEqual(pads.slice(0, 5), ["Kick 01", "Snare Tight", "Closed Hat", "Open Hat", "Clap 02"], "kick, snare, hats and clap on their pads: " + pads.slice(0, 5));
    assert.strictEqual(pads[14], "Kick 02", "the second kick on the 808 pad");
    assert.ok(pads.includes("Conga") && pads.includes("Shaker Loop"), "the rest on pads too");
    await u.button("Kit pad 1: Kick 01").tap();
    assert.ok(db(await u.level("Drums", 600)) > -35, "the kit plays");
    // one sample by hand: pick it, then a pad
    await lib.getByRole("button", { name: "Folder Perc", exact: true }).tap();
    await lib.getByRole("button", { name: "Conga", exact: true }).tap();
    await u.page.getByRole("button", { name: /^Kit pad 16:/ }).tap();
    await u.until(() => window.minidaw.store.project.tracks.find((t) => t.name === "Drums").instrument.state.pads[15].name === "Conga", "pad 16", 8000);
    assert.strictEqual((await u.track("Drums")).instrument.state.pads[15].name, "Conga", "pad 16 is the conga");
    // save it, go back to the default kit, load it again
    await u.tap("Save kit…");
    await u.page.locator(".sheet input.text").last().fill("Studio");
    await u.sheetButton("OK");
    await u.tap("Default kit");
    await u.until(() => window.minidaw.store.project.tracks.find((t) => t.name === "Drums").instrument.state.pads[0].name === "Kick", "the default kit", 8000);
    assert.strictEqual((await u.track("Drums")).instrument.state.pads[0].name, "Kick", "the default kit");
    await u.tap("Kits ▾");
    await u.menuItem("Studio");
    await u.until(() => window.minidaw.store.project.tracks.find((t) => t.name === "Drums").instrument.state.pads[0].name === "Kick 01", "the saved kit", 8000);
    assert.strictEqual((await u.track("Drums")).instrument.state.pads[0].name, "Kick 01", "the saved kit back");
    // search every folder
    await lib.locator(".lib-search").fill("open hat");
    const found = await lib.locator(".lib-sample").allTextContents();
    assert.ok(found.some((t) => t.includes("Open Hat") && t.includes("Studio Kit/Hats")), "search finds it in its subfolder: " + JSON.stringify(found));
    assert.ok(found.every((t) => /open hat/i.test(t)), "and only open hats");
    await u.sheetButton("Done");
  },

  async "kit builder: a zip (the iPad way), and a zip dropped on the drums"(u) {
    await u.boot();
    await u.tap("Add a track");
    await u.menuItem("Drum Rack from a sample folder");
    const lib = u.page.locator(".kb .lib");
    await lib.waitFor();
    await u.tap("Import ▾");
    const zip = makeZip(kitFiles().map((f) => ({ path: "Zip Kit/" + f.path, bytes: f.bytes })));
    await u.chooseFile(() => u.menuItem("A zip of a folder"), { name: "Zip Kit.zip", mimeType: "application/zip", buffer: zip });
    await lib.locator(".lib-crumb", { hasText: /^Zip Kit$/ }).waitFor({ timeout: 10000 });
    await u.tap("Build from this folder");
    await u.until(() => window.minidaw.store.selectedTrack.instrument.state.pads[0].name !== "Kick", "the pads to change", 8000);
    const pads = await u.state(() => window.minidaw.store.selectedTrack.instrument.state.pads.map((p) => p.name));
    assert.deepStrictEqual(pads.slice(0, 2), ["Kick 01", "Snare Tight"], "the zip's kit: " + pads.slice(0, 4));
    await u.sheetButton("Done");
    // a zip dropped on the demo's Drums: a kit right away
    const hd = await u.box(u.header("Drums").first()); // the demo's (the new kit's track is a "Drums" too, after it)
    await u.dropFiles(hd.x + 60, hd.y + 20, [{ name: "Dropped.zip", type: "application/zip", bytes: makeZip(kitFiles().map((f) => ({ path: "Dropped/" + f.path, bytes: f.bytes }))) }]);
    await u.until(() => window.minidaw.store.project.tracks.find((t) => t.name === "Drums").instrument.state.pads[1].name === "Snare Tight", "the dropped kit on the Drums", 10000);
  },

  async "auto kit: samples without names placed by their sound, tidied, and another kit on each press"(u) {
    await u.boot();
    await u.header("Drums").locator(".th-name").tap();
    await u.tab("Device");
    await u.tap("Kit builder…");
    const lib = u.page.locator(".kb .lib");
    await lib.waitFor();
    const drums = anonymousDrums();
    const dir = path.join(OUT, "Mystery Pack");
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    for (const d of drums) fs.writeFileSync(path.join(dir, d.path), d.bytes);
    await u.tap("Import ▾");
    await u.chooseFile(() => u.menuItem("A folder (with its subfolders)"), dir);
    await u.page.locator(".toast", { hasText: `${drums.length} samples added` }).waitFor({ timeout: 10000 });
    await lib.locator(".lib-crumb", { hasText: /^Mystery Pack$/ }).waitFor();
    await u.tap("Auto kit");
    await u.page.locator(".kb-status", { hasText: "Auto kit from Mystery Pack" }).waitFor({ timeout: 15000 });
    const pads = async () => u.state(() => window.minidaw.store.project.tracks.find((t) => t.name === "Drums").instrument.state.pads);
    const name = (d) => d.path.replace(".wav", "");
    const kicks = drums.filter((d) => d.is === "kick").map(name);
    const is = (role) => name(drums.find((d) => d.is === role));
    let ps = await pads();
    assert.ok(kicks.includes(ps[0].name), "a kick on pad 1: " + ps[0].name);
    assert.deepStrictEqual([ps[1].name, ps[2].name, ps[3].name, ps[5].name], [is("snare"), is("hat"), is("openhat"), is("tomlo")], "snare, hats and the low tom on their pads: " + ps.slice(0, 6).map((p) => p.name));
    assert.ok(kicks.includes(ps[14].name) && ps[14].name !== ps[0].name, "another kick on the 808 pad: " + ps[14].name);
    assert.match(await u.page.locator(".kb-status").textContent(), /7 pads, 0 known by name, 7 by their sound/);
    // tidied: the snare peaks at -1 dB at full velocity, the open hat 4 dB under; the kick with 80 ms of silence starts on its sound
    const snare = ps[1], open = ps[3];
    assert.ok(Math.abs(20 * Math.log10(snare.gain * 1.25 * 0.6) + 1) < 0.3, "the snare's level evened out (gain " + snare.gain + ")");
    assert.ok(Math.abs(20 * Math.log10(open.gain * 1.25 * 0.5) + 5) < 0.3, "the open hat's, 4 dB lower (gain " + open.gain + ")");
    const late = ps.find((p) => p.name === "Sample 02");
    assert.ok(late && near(late.start, 0.079 / 0.48, 0.01), "the late kick trimmed to where it starts: " + (late && late.start));
    await u.button("Kit pad 1: " + ps[0].name).tap();
    assert.ok(db(await u.level("Drums", 600)) > -35, "the kit plays");
    // again: another kick each time some of the time, but always a kick
    const seen = new Set([ps[0].name]);
    for (let k = 0; k < 10 && seen.size < 2; k++) {
      await u.tap("Auto kit");
      await u.page.waitForTimeout(250);
      ps = await pads();
      assert.ok(kicks.includes(ps[0].name) && ps[1].name === is("snare"), "every roll fits its pads: " + ps[0].name);
      seen.add(ps[0].name);
    }
    assert.ok(seen.size >= 2, "Auto kit again makes another kit: " + [...seen]);
    // from the library's top: every folder, the built-in kit too
    await lib.locator(".lib-crumb", { hasText: /^Library$/ }).tap();
    await u.tap("Auto kit");
    await u.page.locator(".kb-status", { hasText: "Auto kit from the library: 16 pads" }).waitFor({ timeout: 15000 });
    ps = await pads();
    assert.ok(ps.every((p) => p.sample), "all 16 pads filled from the whole library");
    assert.ok(["Kick", ...kicks].includes(ps[0].name), "still a kick on pad 1: " + ps[0].name);
    // Tidy pads on the default kit: nothing to trim, the levels evened out
    await u.tap("Default kit");
    await u.until(() => window.minidaw.store.project.tracks.find((t) => t.name === "Drums").instrument.state.pads[0].name === "Kick", "the default kit", 8000);
    await u.tap("Tidy pads");
    await u.page.locator(".kb-status", { hasText: "Tidied" }).waitFor({ timeout: 8000 });
    ps = await pads();
    assert.ok(ps.every((p) => p.start === 0), "the built-in sounds start at once: nothing trimmed");
    assert.ok(ps[0].gain !== 0.8 && ps[2].gain < ps[0].gain * 1.5, "levels set from the sounds: kick " + ps[0].gain + ", hat " + ps[2].gain);
    await u.sheetButton("Done");
  },

  async "export the kit for Ableton Move and for Ableton Live"(u) {
    await u.boot();
    await u.header("Drums").locator(".th-name").tap();
    await u.tab("Device");
    // pad 1 reversed, by its toggle: the export should play it as it plays here
    assert.strictEqual(await u.state(() => window.minidaw.store.ui.drumPad || 0), 0, "pad 1 is the one being edited");
    await u.page.locator(".drum-edit .tog", { hasText: /^Reverse$/ }).tap();
    await u.until(() => window.minidaw.store.project.tracks.find((t) => t.name === "Drums").instrument.state.pads[0].reverse === true, "pad 1 reversed");
    await u.tap("Kit builder…");
    await u.tap("Export ▾");
    await u.menuItem("For Ableton Move");
    await u.page.locator(".sheet input.text").last().fill("Night Kit");
    const [move] = await Promise.all([u.page.waitForEvent("download", { timeout: 30000 }), u.sheetButton("OK")]);
    assert.strictEqual(move.suggestedFilename(), "Night Kit.ablpresetbundle");
    const mfile = path.join(OUT, "Night Kit.ablpresetbundle");
    await move.saveAs(mfile);
    const files = readZip(fs.readFileSync(mfile));
    const byPath = new Map(files.map((f) => [f.path, f.bytes]));
    assert.ok(byPath.has("Preset.ablpreset"), "Preset.ablpreset at the top: " + [...byPath.keys()].slice(0, 3));
    const preset = JSON.parse(byPath.get("Preset.ablpreset").toString("utf8"));
    const rack = preset.chains[0].devices[0];
    assert.strictEqual(preset.kind, "instrumentRack");
    assert.strictEqual(rack.kind, "drumRack");
    assert.strictEqual(rack.chains.length, 16);
    const wavs = rack.chains.map((c, i) => {
      assert.strictEqual(c.drumZoneSettings.receivingNote, 36 + i, "pad " + (i + 1) + "'s note");
      const uri = c.devices[0].deviceData.sampleUri;
      const bytes = byPath.get(decodeURIComponent(uri));
      assert.ok(bytes, "pad " + (i + 1) + "'s sample is in the bundle: " + uri);
      return readWav(bytes);
    });
    assert.strictEqual([...byPath.keys()].filter((p) => p.startsWith("Samples/")).length, 16, "16 samples");
    assert.ok(wavs.every((w) => w.rate === 44100 && w.frames > 1000 && w.peak() > 0.1), "every sample a real sound");
    assert.ok(wavs[0].rms(wavs[0].frames / 44100 - 0.02, wavs[0].frames / 44100) > 4 * wavs[0].rms(0, 0.02), "pad 1's kick reversed in its WAV: loud at its end");
    assert.ok(wavs[1].rms(0, 0.02) > 4 * wavs[1].rms(wavs[1].frames / 44100 - 0.02, wavs[1].frames / 44100), "pad 2's snare as it is: loud at its start");
    assert.deepStrictEqual(rack.chains.map((c) => c.drumZoneSettings.chokeGroup).slice(0, 4), [null, null, 1, 1], "the hats choke each other");
    await u.page.locator(".kb-status", { hasText: "Move Manager" }).waitFor();
    await u.sheetButton("Done");
    // Live, from the top bar's Export menu
    await u.tap("Export, record the output");
    await u.menuItem("Drums: Drum Rack for Ableton Live");
    await u.page.locator(".sheet input.text").last().fill("Night Kit");
    const [live] = await Promise.all([u.page.waitForEvent("download", { timeout: 30000 }), u.sheetButton("OK")]);
    const lfile = path.join(OUT, "night-live.zip");
    await live.saveAs(lfile);
    const lz = new Map(readZip(fs.readFileSync(lfile)).map((f) => [f.path, f.bytes]));
    assert.ok(lz.has("Night Kit/Night Kit.adg") && lz.has("Night Kit/Read me.txt"), "the .adg in its folder: " + [...lz.keys()].slice(0, 3));
    const xml = require("zlib").gunzipSync(lz.get("Night Kit/Night Kit.adg")).toString("utf8");
    assert.ok(xml.startsWith("<?xml") && xml.includes("<DrumGroupDevice"), "a gzipped Live Drum Rack");
    const branches = xml.split("<DrumBranchPreset ").slice(1);
    assert.strictEqual(branches.length, 16, "16 pads");
    for (const [i, b] of branches.entries()) {
      const rel = b.slice(b.indexOf("<SampleRef>")).match(/<RelativePath Value="([^"]*)"/)[1];
      assert.ok(lz.has("Night Kit/" + rel), "pad " + (i + 1) + "'s sample beside the .adg: " + rel);
      assert.strictEqual(b.match(/<ReceivingNote Value="(\d+)"/)[1], String(92 - i), "pad " + (i + 1) + "'s note");
      assert.strictEqual(+b.match(/<DefaultDuration Value="(\d+)"/)[1], readWav(lz.get("Night Kit/" + rel)).frames, "its length");
    }
  },

  async "keys: pads in the song's key, one-finger chords, and Keys stays as tracks change"(u) {
    await u.boot();
    await u.header("Bass").locator(".th-name").tap();
    await u.tab("Keys");
    const keySel = u.page.getByLabel("Key", { exact: true }), scaleSel = u.page.getByLabel("Scale", { exact: true });
    assert.deepStrictEqual([await keySel.inputValue(), await scaleSel.inputValue()], ["9", "minor"], "the demo is in A minor");
    await u.page.locator(".keys-layout .seg-btn", { hasText: "Pads" }).tap();
    const padNotes = () => u.page.locator(".npad").evaluateAll((els) => els.map((e) => +e.dataset.note));
    let notes = await padNotes();
    assert.ok(notes.length >= 16 && notes.length % 8 === 0, "rows of 8 pads: " + notes.length);
    assert.ok(notes.every((n) => [9, 11, 0, 2, 4, 5, 7].includes(n % 12)), "the pads hold only A minor's notes");
    const roots = await u.page.locator(".npad.root").evaluateAll((els) => els.map((e) => +e.dataset.note % 12));
    assert.ok(roots.length >= 2 && roots.every((r) => r === 9), "the As are marked");
    const pad = await u.box(u.page.locator(".npad.root").last());
    await u.page.mouse.move(pad.x + pad.width / 2, pad.y + pad.height * 0.8);
    await u.page.mouse.down();
    const lvl = await u.level("Bass", 600);
    await u.page.mouse.up();
    assert.ok(db(lvl) > -45, `a pad plays the bass (${db(lvl).toFixed(1)} dBFS)`);
    // another key: the pads follow, and it's the song's (two undo steps bring A minor back)
    await keySel.selectOption("2");
    await u.page.getByLabel("Scale", { exact: true }).selectOption("dorian");
    notes = await padNotes();
    assert.ok(notes.every((n) => [2, 4, 5, 7, 9, 11, 0].includes(n % 12)) && notes.some((n) => n % 12 === 11), "D dorian's notes: " + [...new Set(notes.map((n) => n % 12))]);
    assert.deepStrictEqual(await u.state(() => [window.minidaw.store.project.key, window.minidaw.store.project.scale]), [2, "dorian"], "the key is the project's");
    await u.tap("Undo"); await u.tap("Undo");
    await u.until(() => document.querySelector('[aria-label="Scale"]').value === "minor" && document.querySelector('[aria-label="Key"]').value === "9", "undo to bring A minor back");
    // picking another track keeps the Keys: it's the one played now
    await u.header("Lead").locator(".th-name").tap();
    assert.strictEqual(await u.state(() => window.minidaw.store.ui.panel), "keys", "still on Keys");
    await u.page.locator(".npad").first().waitFor();
    await u.header("Drums").locator(".th-name").tap();
    assert.strictEqual(await u.page.locator(".keys-pads .pad").count(), 16, "a Drum Rack: its 16 pads");
    await u.header("Bass").locator(".th-name").tap();
    // chords: one pad, one chord of the key
    await u.page.locator(".keys-layout .seg-btn", { hasText: "Chords" }).tap();
    const names = await u.page.locator(".chord:not(.seventh) b").allTextContents();
    assert.deepStrictEqual(names, ["Am", "B°", "C", "Dm", "Em", "F", "G"], "A minor's triads");
    assert.strictEqual(await u.page.locator(".chord.seventh b").first().textContent(), "Am7", "and its sevenths above them");
    for (const name of ["Chord Am", "Chord F"]) {
      const b = await u.box(u.page.getByLabel(name, { exact: true }));
      await u.tapAt(b.x + b.width / 2, b.y + b.height * 0.7);
      await u.page.waitForTimeout(450);
    }
    await u.page.waitForTimeout(400);
    await u.tap("Capture");
    const bass = await u.track("Bass");
    const pl = bass.arrangement.find((x) => x.start === 0);
    const clip = pl && await u.state((id) => window.minidaw.store.project.clips[id], pl.clipId);
    // Capture holds what was just played: the pad from before, then the two chords
    const played = clip ? [...clip.notes].sort((x, y) => x.t - y.t || x.p - y.p) : [];
    assert.strictEqual(played.length, 7, "the pad's note and two chords of three: " + JSON.stringify(played.map((n) => n.p)));
    assert.deepStrictEqual(played.slice(1).map((n) => n.p), [57, 60, 64, 65, 69, 72], "A C E, then F A C");
    assert.ok(Math.abs(played[1].t - played[3].t) < 0.01 && played[4].t > played[3].t + 0.5, "a chord's notes start together, the second chord after the first");
  },

  async "a new song by touch: New clip, steps, Loop clip, a bigger panel"(u) {
    await u.boot();
    await u.tap("Projects and settings");
    await u.menuItem("New project");
    await u.until(() => window.minidaw.store.project.tracks.length === 3 && !Object.keys(window.minidaw.store.project.clips).length, "the new project");
    await u.tab("Clip");
    await u.page.getByRole("button", { name: /New clip on Drums at the playhead/ }).tap();
    await u.step("Kick", 1).tap();
    await u.step("Kick", 9).tap();
    await u.step("Snare", 5).tap();
    const drums = await u.track("Drums");
    assert.deepStrictEqual(drums.arrangement.map((x) => [x.start, x.length]), [[0, 4]], "a one-bar clip at bar 1");
    // Loop clip: it plays round and round, with the loop over it
    await u.tap("▶ Loop clip");
    assert.ok(db(await u.level("Drums", 1200)) > -35, "the beat is heard");
    await u.page.waitForTimeout(1600); // 2.8 s at 120: past the bar's end
    const st = await u.state(() => ({ playing: window.minidaw.transport.playing, loop: window.minidaw.store.project.loop, s: window.minidaw.transport.now().s }));
    assert.ok(st.playing && st.loop.on && st.loop.start === 0 && st.loop.end === 4 && st.s < 4, "it loops over the clip: " + JSON.stringify(st));
    await u.page.locator(".st-cell.now").first().waitFor();
    await u.tap("■ Stop");
    await u.until(() => !window.minidaw.transport.playing, "the stop");
    await u.page.getByRole("button", { name: "▶ Loop clip" }).waitFor();
    // Bigger: the panel over most of the screen, more of the pads' rows in sight; Smaller: back
    const rowsSeen = () => u.page.locator(".st-name").evaluateAll((els) => els.filter((e) => { const r = e.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }).length);
    const h0 = (await u.box(u.page.locator(".panel"))).height, rows0 = await rowsSeen();
    await u.tap("⤢ Bigger");
    const h1 = (await u.box(u.page.locator(".panel"))).height, rows1 = await rowsSeen();
    assert.ok(h1 > IPAD.height * 0.55 && rows1 >= rows0 + 5, `a taller panel shows more rows (${rows0} -> ${rows1}, ${Math.round(h0)} -> ${Math.round(h1)} px)`);
    const tallBox = await u.box(u.page.locator(".panel"));
    assert.ok(tallBox.y + tallBox.height <= IPAD.height + 0.5, "all of it on the screen: its bottom at " + (tallBox.y + tallBox.height));
    assert.ok(await u.header("Drums").isVisible(), "the arrangement's first track is still in sight");
    await u.tap("⤡ Smaller");
    assert.ok(near((await u.box(u.page.locator(".panel"))).height, h0, 3), "and back to the size it had");
    // in the session the button fills the track's next empty slot; a synth's clip opens in the piano roll
    await u.tab("Session");
    await u.page.locator(".ses-head", { hasText: "Crest" }).tap();
    await u.tab("Clip");
    await u.page.getByRole("button", { name: /New clip in Crest's next empty slot/ }).tap();
    await u.page.locator(".pr-canvas").waitFor();
    const crest = await u.track("Crest");
    assert.ok(crest.slots[0] && !crest.slots[1], "a clip in Crest's first slot");
    // turned to portrait and made bigger, then turned back: the panel never takes more than the screen has
    await u.page.setViewportSize({ width: 820, height: 1180 });
    await u.tap("⤢ Bigger");
    let pb = await u.box(u.page.locator(".panel"));
    assert.ok(pb.height > 700 && pb.y + pb.height <= 1180.5, `portrait: a tall panel that ends on the screen (${Math.round(pb.height)} px, bottom ${pb.y + pb.height})`);
    await u.page.setViewportSize(IPAD);
    await u.page.waitForTimeout(300);
    pb = await u.box(u.page.locator(".panel"));
    assert.ok(pb.y + pb.height <= IPAD.height + 0.5 && pb.y > 150, `back in landscape it fits again (top ${pb.y}, bottom ${pb.y + pb.height})`);
  },

  async "MIDI: a keyboard plays the track, a Launchpad Pro Mk3 runs the session (stand-in devices)"(u) {
    await u.page.addInitScript(fakeMidi);
    await u.boot();
    const midi = (fn, ...args) => u.state(({ fn, args }) => window.__midi[fn](...args), { fn, args });
    await u.header("Bass").locator(".th-name").tap();
    await midi("plug", ["Keystation 49"]);
    await u.page.locator(".toast", { hasText: "MIDI: Keystation 49 connected" }).waitFor();
    await midi("from", "Keystation 49", [0x90, 45, 100]);
    assert.ok(db(await u.level("Bass", 500)) > -45, "a key on the keyboard plays the selected track");
    // let go after another track was picked: the note ends where it began (nothing hangs)
    await u.header("Lead").locator(".th-name").tap();
    await midi("from", "Keystation 49", [0x80, 45, 0]);
    await u.page.waitForTimeout(2500);
    assert.ok((await u.level("Bass", 400)) < 0.003, "the bass note ended though Lead is selected now");
    // the Launchpad: three ports; its DAW port becomes the session's grid (SysEx asked for once)
    const LP = "Launchpad Pro MK3 LPProMK3 ";
    await midi("plug", [LP + "MIDI", LP + "DIN", LP + "DAW"]);
    await u.page.locator(".toast", { hasText: "MIDI: Launchpad Pro Mk3 connected" }).waitFor();
    await u.until(() => window.__midi.sent("Launchpad Pro MK3 LPProMK3 DAW").length >= 3, "the Launchpad to be set up");
    assert.deepStrictEqual(await u.state(() => window.__midi.asked), [false, true], "plain MIDI first, SysEx once a Launchpad is there");
    const H = [0xf0, 0x00, 0x20, 0x29, 0x02, 0x0e];
    const leds = async () => { // what the Launchpad shows: its LED messages, in order, the last word on each LED
      const m = new Map();
      for (const msg of await midi("sent", LP + "DAW")) if (msg[6] === 3 && msg.length > 8) { let i = 7; while (i < msg.length - 1) { const n = { 0: 3, 1: 4, 2: 3, 3: 5 }[msg[i]]; m.set(msg[i + 1], msg.slice(i, i + n)); i += n; } }
      return m;
    };
    const sent = await midi("sent", LP + "DAW");
    assert.deepStrictEqual([sent[0], sent[1]], [[...H, 0x10, 1, 0xf7], [...H, 0, 0, 0, 0, 0xf7]], "into DAW mode, on the Session layout");
    assert.strictEqual((await midi("sent", LP + "MIDI")).length, 0, "nothing is sent to its other ports");
    let l = await leds();
    assert.strictEqual(l.get(81)[0], 3, "top left (Drums, scene 1: Beat A): lit in colour");
    assert.deepStrictEqual(l.get(82), [0, 82, 0], "Bass has no clip in scene 1: off");
    // the pad of Bass in scene 2: its clip plays, heard, lit, and shown on the screen's session
    await midi("from", LP + "DAW", [0x90, 72, 100]);
    await midi("from", LP + "DAW", [0x90, 72, 0]);
    assert.ok(db(await u.level("Bass", 1500)) > -35, "the pad launched the bassline");
    l = await leds();
    assert.deepStrictEqual(l.get(72), [2, 72, 21], "the pad pulses green");
    assert.deepStrictEqual(l.get(20).slice(2), [0, 127, 0], "Play is lit");
    await u.tab("Session");
    await u.page.locator(".ses-slot.playing", { hasText: "Bassline" }).waitFor();
    // the right column launches a scene: scene 3, "Full", brings the lead in on the next bar
    await midi("from", LP + "DAW", [0xb0, 69, 127]);
    await u.page.locator(".ses-slot.playing", { hasText: "Hook" }).waitFor({ timeout: 6000 });
    assert.ok(db(await u.level("Lead", 2500)) > -45, "the scene's lead plays");
    // a note from the Launchpad's Note mode (its MIDI port) is a keyboard's: it plays, and isn't a pad of the session
    const launched = await u.state(() => JSON.stringify([...window.minidaw.transport.session].map(([k, v]) => [k, v.playing && v.playing.scene])));
    await midi("from", LP + "MIDI", [0x90, 81, 100]);
    await midi("from", LP + "MIDI", [0x80, 81, 0]);
    assert.strictEqual(await u.state(() => JSON.stringify([...window.minidaw.transport.session].map(([k, v]) => [k, v.playing && v.playing.scene]))), launched, "the session is as it was");
    // Record Arm, then the fifth track button: Lead is armed (as its ● on the screen); Play stops it all
    await midi("from", LP + "DAW", [0xb0, 1, 127]);
    await midi("from", LP + "DAW", [0xb0, 105, 127]);
    assert.strictEqual((await u.track("Lead")).mixer.arm, true, "Lead is armed");
    await midi("from", LP + "DAW", [0xb0, 20, 127]);
    await u.until(() => !window.minidaw.transport.playing, "the Launchpad's Play to stop it");
    l = await leds();
    assert.deepStrictEqual(l.get(20).slice(2), [0, 14, 0], "Play is dim again");
    // unplugged: said, and its DAW mode was left
    await midi("unplug", "LPProMK3");
    await u.page.locator(".toast", { hasText: "MIDI: Launchpad Pro Mk3 disconnected" }).waitFor();
    assert.strictEqual(await u.state(() => window.minidaw.midi.launchpad.connected), false, "the grid is let go");
  },

  async "fingers: the steps scroll and paint, the session redraws, a smaller iPad's top bar"(u) {
    await u.boot();
    // the step sequencer: a swipe up scrolls its rows and changes nothing; along a row it paints
    const beat = await u.lanePoint("Drums", 1);
    await u.tapAt(beat.x, beat.y);
    await u.step("Kick", 1).waitFor();
    const notes = () => u.state(() => window.minidaw.store.selectedClip.notes.length);
    const undoable = () => u.state(() => window.minidaw.store.undoStack.length);
    const n0 = await notes(), u0 = await undoable();
    const cell = await u.box(u.step("Clap", 7));
    await u.swipe(cell.x + cell.width / 2, cell.y + cell.height / 2, cell.x + cell.width / 2, cell.y - 150);
    const scrolled = await u.state(() => document.querySelector(".st-scroll").scrollTop);
    assert.ok(scrolled > 60, "a finger's swipe scrolls the rows (" + scrolled + " px)");
    assert.deepStrictEqual([await notes(), await undoable()], [n0, u0], "and it set no step and made no undo step");
    await u.state(() => { document.querySelector(".st-scroll").scrollTop = 0; });
    const a = await u.box(u.step("Snare", 2)), b = await u.box(u.step("Snare", 4));
    await u.swipe(a.x + a.width / 2, a.y + a.height / 2, b.x + b.width / 2, b.y + b.height / 2);
    assert.strictEqual(await notes(), n0 + 3, "a swipe along a row paints its steps");
    assert.strictEqual(await undoable(), u0 + 1, "as one undo step");
    // a tap that rolls a little (9 px) is still a tap
    const k = await u.box(u.step("Kick", 3));
    await u.swipe(k.x + k.width / 2 - 4, k.y + k.height / 2, k.x + k.width / 2 + 5, k.y + k.height / 2, 3);
    assert.strictEqual(await notes(), n0 + 4, "a fingertip that rolls as it lands still sets the step");
    // the session shows its own edits at once
    await u.tab("Session");
    const col = await u.state(() => window.minidaw.store.project.tracks.findIndex((t) => t.name === "Bass"));
    const empty = u.page.locator(`.ses-slot[data-scene="0"]`).nth(col);
    const eb = await u.box(empty);
    await u.doubleTapAt(eb.x + 30, eb.y + eb.height / 2);
    await u.page.locator(".pr-canvas").waitFor();
    assert.ok(await u.page.locator(`.ses-slot.clip[data-scene="0"]`).nth(col).isVisible().catch(() => false) || (await u.page.locator(`.ses-slot[data-scene="0"]`).nth(col).getAttribute("class")).includes("clip"), "the new clip is in its slot on the screen");
    const rows0 = await u.page.locator(".ses-scene").count();
    await u.tap("+ Scene");
    assert.strictEqual(await u.page.locator(".ses-scene").count(), rows0 + 1, "+ Scene adds a row");
    // a clip deleted while it plays: gone from the grid, and silent
    const arp = u.page.locator(".ses-slot.clip", { hasText: "Arp" }).first();
    await arp.tap();
    assert.ok(db(await u.level("Pluck", 1500)) > -45, "the arp plays");
    const ab = await u.box(arp);
    await u.longPressAt(ab.x + 40, ab.y + ab.height / 2);
    await u.menuItem("Delete");
    await u.page.waitForTimeout(2600);
    const after = await u.state(() => { const a = window.minidaw, t = a.store.project.tracks.find((x) => x.name === "Pluck"), s = a.transport.session.get(t.id); return { playing: s && s.playing, queued: s && s.queued, follow: s && s.follow, slots: t.slots.filter(Boolean).length, tr: a.transport.playing }; });
    assert.ok((await u.level("Pluck", 600)) < 0.01, "deleted while playing: it stops " + JSON.stringify(after));
    // a mixer fader: a double tap resets it (a tap changes nothing and makes no undo step)
    await u.tab("Mixer");
    const strip = u.page.locator(".strip", { has: u.page.locator(".strip-name", { hasText: /^Lead$/ }) });
    const slot = await u.box(strip.locator(".fader-slot"));
    const u1 = await undoable();
    await u.tapAt(slot.x + slot.width / 2, slot.y + slot.height / 2);
    assert.strictEqual(await undoable(), u1, "a tap on a fader is not an undo step");
    await u.doubleTapAt(slot.x + slot.width / 2, slot.y + slot.height / 2);
    await u.until(() => Math.abs(window.minidaw.store.project.tracks.find((t) => t.name === "Lead").mixer.vol - Math.SQRT1_2) < 1e-6, "the double tap to reset the fader to 0 dB");
    // deleting the selected track: the panel goes to its neighbour, not to "add a track"
    await u.tab("Arrange");
    await u.header("Lead").locator(".th-name").tap();
    const hb = await u.box(u.header("Lead"));
    await u.longPressAt(hb.x + 60, hb.y + 14);
    await u.menuItem("Delete track");
    await u.until(() => !window.minidaw.store.project.tracks.some((t) => t.name === "Lead"), "the track to go");
    assert.ok(await u.page.locator(".th.sel").count() === 1 && !(await u.page.locator(".panel-body").textContent()).includes("Add a track"), "a neighbour is selected and shown");
    // a 1024-wide iPad with a session clip playing: every tab is whole and takes a tap
    await u.page.setViewportSize({ width: 1024, height: 768 });
    await u.tab("Session");
    await u.page.locator(".ses-slot.clip").first().tap();
    await u.page.locator(".tb-back").waitFor();
    for (const name of ["Arrange", "Session", "Mixer"]) {
      const tb = await u.box(u.page.locator(".tb-views .seg-btn", { hasText: new RegExp("^" + name + "$") }));
      assert.ok(tb.x >= 0 && tb.x + tb.width <= 1024 && tb.width >= 44, `${name} is whole on a 1024-wide screen (${Math.round(tb.x)}..${Math.round(tb.x + tb.width)})`);
    }
    await u.tab("Mixer");
    assert.strictEqual(await u.state(() => window.minidaw.store.ui.view), "mixer", "and Mixer opens");
  },

  async "keeping work: an edit just before a reload, a full disk said, a duplicated track on its own"(u) {
    await u.boot();
    // an edit, and the page reloaded at once (before the autosave's 2.5 s): it's there afterwards
    await u.header("Drums").locator(".th-btn.mute").tap();
    await u.until(() => window.minidaw.store.project.tracks[0].mixer.mute === true, "the mute");
    await u.page.reload();
    await u.boot();
    assert.strictEqual((await u.track("Drums")).mixer.mute, true, "the edit made just before leaving was saved");
    // a duplicated track has its own clips: changing the copy leaves the original alone
    const hb = await u.box(u.header("Bass"));
    await u.longPressAt(hb.x + 60, hb.y + 14);
    await u.menuItem("Duplicate track");
    await u.until(() => window.minidaw.store.project.tracks.some((t) => t.name === "Bass 2"), "the copy");
    const pair = await u.state(() => { const p = window.minidaw.store.project, a = p.tracks.find((t) => t.name === "Bass"), b = p.tracks.find((t) => t.name === "Bass 2"); return { a: a.arrangement.map((x) => [x.id, x.clipId]), b: b.arrangement.map((x) => [x.id, x.clipId]), notes: p.clips[b.arrangement[0].clipId].notes.length }; });
    assert.ok(pair.b.length === pair.a.length && pair.b.every(([id, clip], i) => id !== pair.a[i][0] && clip !== pair.a[i][1]) && pair.notes > 0, "the copy's clips and placements are its own: " + JSON.stringify(pair));
    const spot = await u.lanePoint("Bass 2", 34);
    await u.tapAt(spot.x, spot.y);
    await u.tap("+12");
    const pitches = await u.state(() => { const p = window.minidaw.store.project; const lo = (n) => Math.min(...p.clips[p.tracks.find((t) => t.name === n).arrangement[0].clipId].notes.map((x) => x.p)); return [lo("Bass"), lo("Bass 2")]; });
    assert.strictEqual(pitches[1], pitches[0] + 12, "the copy went up an octave, the original stayed: " + pitches);
    // the disk is full (the browser refuses the write): it's said, and "Saved" is not
    u.expectErrors = [/quota has been exceeded/i, /^save /]; // the refused write, and the app's own log of the failed save
    await u.page.evaluate(() => {
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...a) { if (this.name === "projects") throw new DOMException("The quota has been exceeded.", "QuotaExceededError"); return put.apply(this, a); };
    });
    await u.tap("Projects and settings");
    await u.menuItem("Save now");
    await u.page.locator(".toast", { hasText: "Not saved" }).waitFor({ timeout: 8000 });
    assert.strictEqual(await u.page.locator(".toast", { hasText: /^Saved$/ }).count(), 0, "it doesn't say Saved");
    assert.ok((await u.page.locator(".toast", { hasText: "Not saved" }).first().textContent()).includes("Save current as file"), "and says how to keep the work");
  },

  async "session: launch a scene, stop a track, back to the arrangement"(u) {
    await u.boot();
    await u.tab("Session");
    await u.page.locator(".ses-scene", { hasText: "Groove" }).tap();
    assert.ok(db(await u.level("Bass", 2500)) > -35, "the scene's bass plays");
    await u.page.locator(".ses-slot.playing").first().waitFor();
    assert.ok(await u.page.locator(".tb-back").isVisible(), "→ Arrangement shows while session clips play");
    const bassCol = await u.state(() => window.minidaw.store.project.tracks.findIndex((t) => t.name === "Bass"));
    await u.page.locator(".ses-stop").nth(bassCol).tap();
    await u.page.waitForTimeout(2600); // the stop waits for the bar
    assert.ok((await u.level("Bass", 800)) < 0.01, "the stopped track is silent");
    await u.tap("Stop (twice: to the start)");
    await u.page.waitForTimeout(300);
    assert.ok(await u.page.locator(".tb-back").isHidden(), "after Stop every track is on the arrangement again");
    await u.tab("Arrange");
    await u.tap("Play (space)");
    assert.ok(db(await u.level("Drums", 1500)) > -35, "the arrangement plays");
  },

  async "mixer: solo, mute and a fader"(u) {
    await u.boot();
    await u.tab("Session");
    await u.page.locator(".ses-scene", { hasText: "Full" }).tap();
    await u.page.waitForTimeout(800);
    await u.tab("Mixer");
    const strip = (n) => u.page.locator(".strip", { has: u.page.locator(".strip-name", { hasText: new RegExp("^" + n + "$") }) });
    await strip("Drums").getByRole("button", { name: "S", exact: true }).tap();
    await u.page.waitForTimeout(150);
    const [d, b] = [await u.level("Drums", 900), await u.level("Bass", 900)];
    assert.ok(db(d) > -35 && b < 0.003, `solo: only the drums (drums ${db(d).toFixed(1)}, bass ${db(b).toFixed(1)} dBFS)`);
    await strip("Drums").getByRole("button", { name: "S", exact: true }).tap();
    await strip("Drums").getByRole("button", { name: "M", exact: true }).tap();
    await u.page.waitForTimeout(150);
    assert.ok((await u.level("Drums", 800)) < 0.003, "mute silences the drums");
    assert.ok(db(await u.level("Bass", 1500)) > -40, "and the rest plays on");
    // pull the Bass fader right down
    const before = await u.level("Bass", 1500);
    const slot = await u.box(strip("Bass").locator(".fader-slot"));
    const thumb = await u.box(strip("Bass").locator(".fader-thumb"));
    await u.drag(slot.x + slot.width / 2, thumb.y + thumb.height / 2, slot.x + slot.width / 2, slot.y + slot.height + 40);
    const after = await u.level("Bass", 1500);
    assert.ok(after < before * 0.1, `the fader down: ${db(before).toFixed(1)} -> ${db(after).toFixed(1)} dBFS`);
    assert.strictEqual(await strip("Bass").locator(".fader-val").textContent(), "-∞");
  },

  async "record into the arrangement with a count-in, then undo"(u) {
    await u.boot();
    await u.header("Lead").getByTitle("Arm for recording").tap();
    await u.header("Lead").locator(".th-name").tap();
    await u.tap("Record on the armed tracks");
    await u.page.locator(".countin").waitFor({ state: "visible" });
    assert.strictEqual((await u.page.locator(".ci-label").textContent()).trim(), "Count-in");
    await u.page.locator(".countin").waitFor({ state: "hidden", timeout: 5000 });
    for (const key of ["a", "d", "g"]) { await u.page.keyboard.down(key); await u.page.waitForTimeout(250); await u.page.keyboard.up(key); await u.page.waitForTimeout(150); }
    await u.page.waitForTimeout(300);
    await u.tap("Stop (twice: to the start)");
    const lead = await u.track("Lead");
    const pl = lead.arrangement.find((x) => x.start === 0);
    assert.ok(pl, "a clip at bar 1 on Lead");
    const clip = await u.state((id) => window.minidaw.store.project.clips[id], pl.clipId);
    assert.deepStrictEqual(clip.notes.map((n) => n.p), [60, 64, 67], "the three notes played (A, D, G keys: C, E, G)");
    assert.ok(clip.notes[0].t < clip.notes[1].t && clip.notes[1].t < clip.notes[2].t, "in order");
    assert.ok(!clip.rec, "no recording left over");
    await u.tap("Undo");
    assert.ok(!(await u.track("Lead")).arrangement.some((x) => x.start === 0), "one Undo takes the whole take away");
  },

  async "session: a fixed-length loop recorded into a slot plays on"(u) {
    await u.boot();
    // long press Record: the settings; no count-in, 1-bar session clips
    const rec = await u.box(u.button("Record on the armed tracks"));
    await u.longPressAt(rec.x + rec.width / 2, rec.y + rec.height / 2);
    const row = (label) => u.page.locator(".rs-row", { hasText: label });
    await row("Count-in").getByRole("button", { name: "Off" }).tap();
    await row("Session clip length").getByRole("button", { name: "1 bar" }).tap();
    await u.sheetButton("Done");
    await u.header("Lead").getByTitle("Arm for recording").tap();
    await u.tab("Session");
    const col = await u.state(() => window.minidaw.store.project.tracks.findIndex((t) => t.name === "Lead"));
    const slot = u.page.locator(`.ses-slot[data-scene="5"]`).nth(col);
    await slot.tap(); // an armed track's empty slot records
    await u.tab("Keys");
    await u.until(() => window.minidaw.recording.state === "rec", "the recording to start", 4000);
    const key = await u.box(u.page.locator(".kb-key.white").nth(2));
    for (let i = 0; i < 3; i++) { await u.tapAt(key.x + key.width / 2, key.y + key.height * 0.7); await u.page.waitForTimeout(300); }
    await u.until(() => window.minidaw.recording.state === "idle", "the 1-bar take to end by itself", 6000);
    const lead = await u.track("Lead");
    const clip = await u.state((id) => window.minidaw.store.project.clips[id], lead.slots[5]);
    assert.ok(clip && clip.length === 4 && clip.notes.length >= 3, "a 1-bar clip with the notes");
    await u.page.locator(".ses-slot.playing").filter({ hasText: clip.name }).waitFor({ timeout: 3000 }).catch(() => {});
    assert.ok(await u.state((id) => { const s = window.minidaw.transport.session.get(id); return !!(s && s.playing); }, lead.id), "it plays on as a loop");
    assert.ok(db(await u.level("Lead", 2500)) > -45, "and is heard");
  },

  async "capture what was played without recording"(u) {
    await u.boot();
    await u.header("Bass").locator(".th-name").tap();
    await u.tab("Keys");
    assert.ok(await u.button("Capture").isDisabled(), "nothing to capture yet");
    const keys = u.page.locator(".kb-key.white");
    for (const i of [0, 2, 4]) { const k = await u.box(keys.nth(i)); await u.tapAt(k.x + k.width / 2, k.y + k.height * 0.7); await u.page.waitForTimeout(350); }
    await u.page.waitForTimeout(500);
    await u.tap("Capture");
    const bass = await u.track("Bass");
    const pl = bass.arrangement.find((x) => x.start === 0);
    const clip = pl && await u.state((id) => window.minidaw.store.project.clips[id], pl.clipId);
    assert.ok(clip && clip.name === "Captured" && clip.notes.length === 3, "a clip with the three notes");
    await u.page.locator(".pr-canvas").waitFor();
  },

  async "MIDI files: as new tracks, and onto a track"(u) {
    await u.boot();
    await u.tap("Add a track");
    await u.chooseFile(() => u.menuItem("Tracks from a MIDI file"), { name: "Song.mid", mimeType: "audio/midi", buffer: makeMidi() });
    await u.page.locator(".imp-row").first().waitFor();
    assert.deepStrictEqual(await u.page.locator(".imp-name").allTextContents(), ["Keys", "Beat"]);
    await u.sheetButton("Import");
    await u.until(() => window.minidaw.store.project.tracks.some((t) => t.name === "Beat" && t.instrument.kind === "drumrack"), "the new tracks");
    const beat = await u.track("Beat");
    const notes = await u.state((id) => window.minidaw.store.project.clips[id].notes.map((n) => n.p), beat.arrangement[0].clipId);
    assert.ok(notes.every((p) => p >= 36 && p < 52), "General MIDI drums land on the pads");
    // drop the file on Lead's lane at bar 3: a part, then the clip
    const p = await u.lanePoint("Lead", 8.5);
    await u.dropFiles(p.x, p.y, [{ name: "Song.mid", type: "audio/midi", bytes: makeMidi() }]);
    await u.page.locator(".smp-name", { hasText: "Keys" }).tap();
    const lead = await u.track("Lead");
    assert.ok(lead.arrangement.some((x) => x.start === 8), "a clip at bar 3 on Lead");
  },

  async "an audio track: a loop at the playhead, warped, heard"(u) {
    await u.boot();
    await u.header("Tops").locator(".th-name").tap();
    await u.tab("Device");
    await u.tap("Add a sample at the playhead");
    await u.libraryPick(["Built-in", "Loops"], "Breakbeat 96");
    const tops = await u.track("Tops");
    const pl = tops.arrangement.find((x) => x.start === 0);
    const clip = pl && await u.state((id) => window.minidaw.store.project.clips[id], pl.clipId);
    assert.ok(clip && clip.warp && clip.bpm === 96 && clip.length === 8, "a 2-bar warped clip at bar 1");
    await u.page.locator(".ac-canvas").waitFor();
    await u.tap("Play (space)");
    assert.ok(db(await u.level("Tops", 1500)) > -30, "the loop is heard");
  },

  async "automation: draw a lane, the track follows it"(u) {
    await u.boot();
    await u.header("Bass").getByTitle("Show an automation lane").tap();
    await u.menuItem("Pan");
    await u.until(() => window.minidaw.store.project.tracks.find((t) => t.name === "Bass").lanes.includes("pan"), "the Pan lane");
    const lane = await u.state(() => {
      const a = window.minidaw, v = a.views.arrange, r = v.rows().find((x) => x.track.name === "Bass" && x.lane === "pan");
      const c = v.lanes.getBoundingClientRect();
      return { top: c.top + r.y - v.scroll.scrollTop, h: r.h, x32: c.left + v.bx(32), x40: c.left + v.bx(40) };
    });
    await u.tapAt(lane.x32, lane.top + 6);              // hard right at bar 9
    await u.tapAt(lane.x40, lane.top + lane.h - 6);     // hard left at bar 11
    const pts = (await u.track("Bass")).automation.pan;
    assert.ok(pts && pts.length >= 2, "points on the lane");
    // play from bar 9: the panner follows, right then left
    const ruler = await u.box(u.page.locator(".arr-ruler"));
    await u.tapAt(lane.x32 + 2, ruler.y + 26);
    await u.tap("Play (space)");
    await u.page.waitForTimeout(300);
    const id = (await u.track("Bass")).id;
    const pan1 = await u.state((id) => window.minidaw.engine.channel(id).panner.pan.value, id);
    await u.page.waitForTimeout(3300);
    const pan2 = await u.state((id) => window.minidaw.engine.channel(id).panner.pan.value, id);
    assert.ok(pan1 > 0.6 && pan2 < -0.3, `the pan follows the lane (${pan1.toFixed(2)} -> ${pan2.toFixed(2)})`);
  },

  async "export the loop as a WAV"(u) {
    await u.boot();
    // the loop: a tap on the ruler's loop brace (the demo's, bars 9 to 16) turns it on
    const ruler = await u.box(u.page.locator(".arr-ruler"));
    const x9 = (await u.lanePoint("Drums", 34)).x;
    await u.tapAt(x9, ruler.y + 7);
    const loop = await u.state(() => window.minidaw.store.project.loop);
    assert.ok(loop.on && loop.start === 32 && loop.end === 64, "the loop is on, bars 9 to 16");
    await u.tap("Export, record the output");
    await u.menuItem("Export mix");
    await u.page.locator(".seg-btn", { hasText: "Loop region" }).tap();
    const [download] = await Promise.all([u.page.waitForEvent("download", { timeout: 60000 }), u.sheetButton("Export")]);
    const file = path.join(OUT, "export.wav");
    await download.saveAs(file);
    const wav = readWav(fs.readFileSync(file));
    const secs = wav.frames / wav.rate;
    const expect = 32 * 60 / 122 + 2;
    assert.strictEqual(wav.rate, 44100);
    assert.strictEqual(wav.channels, 2);
    assert.ok(near(secs, expect, 0.05), `the loop plus a 2 s tail (${secs.toFixed(2)} s, ${expect.toFixed(2)} expected)`);
    const rms = wav.rms(0, 32 * 60 / 122), tail = wav.rms(secs - 0.3, secs);
    assert.ok(db(rms) > -30 && wav.peak() <= 1, `the mix is in it, unclipped (rms ${db(rms).toFixed(1)} dBFS, peak ${wav.peak().toFixed(3)})`);
    assert.ok(tail < rms * 0.25, `the tail fades (${db(tail).toFixed(1)} dBFS at the end)`);
  },

  async "a reload keeps the project and the sounds"(u) {
    await u.boot();
    await u.page.locator(".tb-bpm").tap();
    await u.page.locator(".sheet input.text").fill("133");
    await u.sheetButton("OK");
    await u.header("Bass").locator(".th-name").tap();
    await u.tab("Device");
    await u.page.getByTitle("Next preset").tap();
    await u.page.waitForTimeout(400);
    const name = await u.page.locator(".dev-preset-name").textContent();
    await u.page.keyboard.press("Meta+s");
    await u.page.locator(".toast", { hasText: "Saved" }).waitFor();
    await u.page.reload();
    await u.boot();
    assert.strictEqual(await u.page.locator(".tb-bpm").textContent(), "133", "the tempo");
    await u.header("Bass").locator(".th-name").tap();
    await u.tab("Device");
    const engineName = await u.state(() => window.minidaw.engine.instrument(window.minidaw.store.ui.selTrack).get("preset_name"));
    assert.strictEqual(engineName, name, "the Bass sound (" + name + ")");
  },

  async "undo and redo a clip"(u) {
    await u.boot();
    const p = await u.lanePoint("Lead", 2);
    await u.doubleTapAt(p.x, p.y);
    assert.strictEqual((await u.track("Lead")).arrangement.length, 2, "a new clip");
    await u.tap("Undo");
    assert.strictEqual((await u.track("Lead")).arrangement.length, 1, "undone");
    await u.tap("Redo");
    assert.strictEqual((await u.track("Lead")).arrangement.length, 2, "redone");
  },

  async "iPad portrait: the controls fit"(u) {
    await u.page.setViewportSize({ width: 820, height: 1180 });
    await u.boot();
    const tb = (label) => u.page.locator(`.topbar [aria-label^="${label}"]`);
    const tabs = (n) => u.page.locator(".seg-btn", { hasText: new RegExp("^" + n + "$") });
    const controls = [["Play", tb("Play")], ["Stop", tb("Stop")], ["Record", tb("Record")], ["Capture", tb("Capture")], ["Loop", tb("Loop")],
      ["Metronome", tb("Metronome")], ["Undo", tb("Undo")], ["Redo", tb("Redo")], ["Add a track", tb("Add a track")], ["Export", tb("Export")],
      ["Projects", tb("Projects")], ...["Arrange", "Session", "Mixer", "Device", "Clip", "Keys"].map((n) => [n, tabs(n)])];
    const boxes = [];
    for (const [n, loc] of controls) {
      assert.strictEqual(await loc.count(), 1, n + " is one control");
      const b = await u.box(loc);
      assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.width <= 820 && b.y + b.height <= 1180, n + " is on screen");
      assert.ok(b.width >= 28 && b.height >= 28, n + " is big enough to tap");
      boxes.push([n, b]);
    }
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const [na, a] = boxes[i], [nb, b] = boxes[j];
      const overlap = a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1 && a.y < b.y + b.height - 1 && b.y < a.y + a.height - 1;
      assert.ok(!overlap, `${na} and ${nb} don't overlap`);
    }
  },

  async "offline: it starts with the network gone"(u, { context }) {
    await u.boot({ sw: true });
    // an active worker has the whole app (it caches everything before it activates)
    await u.until(() => navigator.serviceWorker.controller && navigator.serviceWorker.controller.state === "activated", "the service worker to take over", 60000);
    const cached = await u.state(async () => {
      const list = await (await fetch("precache.json")).json();
      const c = await caches.open((await caches.keys()).find((k) => k.startsWith("minidaw-")));
      let n = 0;
      for (const f of list.files) if (await c.match(f)) n++;
      return [n, list.files.length];
    });
    assert.strictEqual(cached[0], cached[1], `every file is cached (${cached[0]} of ${cached[1]})`);
    await context.setOffline(true);
    await u.page.reload();
    await u.boot({ sw: true });
    assert.strictEqual(await u.state(() => [...window.minidaw.engine.channels.values()].filter((c) => c.instrument).length), 5, "all five instruments load offline");
    await u.tap("Play (space)");
    assert.ok(db(await u.level(null, 1500)) > -30, "and it plays");
  },
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const only = process.argv.slice(2).map((s) => s.toLowerCase());
  const names = Object.keys(FLOWS).filter((n) => !only.length || only.some((o) => n.toLowerCase().includes(o)));
  const srv = await serve();
  const base = "http://127.0.0.1:" + srv.address().port;
  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  const results = [];
  for (const name of names) {
    const context = await browser.newContext({ viewport: IPAD, hasTouch: true, acceptDownloads: true });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    const t0 = Date.now();
    let err = null;
    try {
      const user = new User(page, base);
      await Promise.race([FLOWS[name](user, { context }), new Promise((_, rej) => setTimeout(() => rej(new Error("the flow took over 120 s")), 120000))]);
      // errors a flow brings about on purpose (a disk made full) are its own to name: user.expectErrors = [/.../]
      const unexpected = errors.filter((e) => !(user.expectErrors || []).some((re) => re.test(e)));
      if (unexpected.length) throw new Error("page errors: " + unexpected.join(" | "));
    } catch (e) {
      err = e;
      await page.screenshot({ path: path.join(OUT, name.replace(/[^\w]+/g, "-") + ".png") }).catch(() => {});
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    results.push({ name, ok: !err, secs, error: err && (err.message || String(err)) });
    console.log(`${err ? "FAIL" : "pass"}  ${name}  (${secs} s)${err ? "\n      " + (err.message || err).split("\n")[0] : ""}`);
    await context.close();
  }
  await browser.close();
  srv.close();
  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 1));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} of ${results.length} flows passed`);
  process.exit(failed ? 1 : 0);
})();
