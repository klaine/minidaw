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
const { makeWav, makeMidi, readWav } = require("./files.cjs");

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
    await u.page.locator(".pr-canvas").waitFor();
    // tap the Kick row at each beat of the bar
    const cv = await u.box(u.page.locator(".pr-canvas"));
    const geo = await u.state(() => { const pr = window.minidaw.views.panel.child; return { kickY: pr.py(36) + pr.rowH / 2, beatX: [0, 1, 2, 3].map((b) => pr.bx(b) + 6) }; });
    for (const x of geo.beatX) await u.tapAt(cv.x + x, cv.y + geo.kickY);
    const notes = await u.state(() => window.minidaw.store.selectedClip.notes.map((n) => [n.p, n.t]));
    assert.deepStrictEqual(notes, [[36, 0], [36, 1], [36, 2], [36, 3]], "four kicks on the beats");
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
    await u.page.locator(".smp-name", { hasText: "Clap" }).tap();
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
    await u.page.locator(".pr-canvas").waitFor();
    // tap the Snare row's name, then Pad sounds: that pad's editor
    const cv = await u.box(u.page.locator(".pr-canvas"));
    const y = await u.state(() => { const pr = window.minidaw.views.panel.child; return pr.py(37) + pr.rowH / 2; });
    await u.tapAt(cv.x + 20, cv.y + y);
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
    await u.page.locator(".smp-name", { hasText: "Breakbeat 96" }).tap();
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
      await Promise.race([FLOWS[name](new User(page, base), { context }), new Promise((_, rej) => setTimeout(() => rej(new Error("the flow took over 120 s")), 120000))]);
      if (errors.length) throw new Error("page errors: " + errors.join(" | "));
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
