// PRO-8000 V's editor inside minidaw: in place of its web/p8-web.js (loaded first, before ui/p8-shim.js and the
// firmware's editor page), the same bridge the shim, ui/p8-app.js, ui/p8-fx.js and web/p8-browser.js talk to
// (window.p8_send, window.p8_call, window.p8_web), answered by the track's engine in the DAW instead of an engine of
// the page's own. ?track=<id> names the track; window.parent.minidaw.editorBridge(id) is its bridge
// (js/ui/editor-host.js). The library is the presets' bank, kept for the session; the sound itself is saved with the
// project.
(() => {
  "use strict";
  window.__p8_web = true;
  const trackId = new URLSearchParams(location.search).get("track");
  const bridge = window.parent && window.parent.minidaw && window.parent.minidaw.editorBridge(trackId);
  const HDR = [0xF0, 0x00, 0x20, 0x32, 0x00, 0x01, 0x24, 0x00];
  const isOurs = (m) => m.length > HDR.length + 1 && HDR.every((b, i) => m[i] === b) && m[m.length - 1] === 0xF7;
  const PATCH_AREA = 98304, RECORD = 768;
  const recordIsPatch = (r) => r[0] === 0x50 && r[1] === 0x38 && r[2] === 0x50 && r[3] === 0x32;
  const recordName = (r) => {
    if (!recordIsPatch(r)) return "";
    let s = "";
    for (let i = 4; i < 20 && r[i]; i++) s += String.fromCharCode(r[i] >= 0x20 && r[i] < 0x7F ? r[i] : 32);
    return s;
  };

  const st = {
    node: null, version: "", started: false, error: "", bank: 0, slot: 0, banks: new Map(), mode: "standalone", timing: 0,
    fxInfo: null, fxDefaults: null, peak: 0,
  };
  const listeners = new Set();
  const changed = (what) => listeners.forEach((fn) => { try { fn(what); } catch (e) { console.error(e); } });
  const post = (msg) => bridge && bridge.post(msg);
  const ask = (msg) => bridge.ask(msg);

  function onEngine(d) {
    if (d.t === "midi") { if (window.__p8_receive) window.__p8_receive(d.list); }
    else if (d.t === "saved") {
      const b = st.banks.get(st.bank);
      if (!b) return;
      d.slots.forEach((s, k) => b.area.set(d.records[k], s * RECORD));
      changed("library");
      bridge.changed();
    } else if (d.t === "slot") { if (d.slot !== st.slot) { st.slot = d.slot; changed("slot"); } }
    else if (d.t === "stopped") { st.error = d.error; changed("stopped"); }
  }

  async function start() {
    if (!bridge) throw new Error("open this editor from minidaw");
    const area = new Uint8Array(await bridge.bank());
    const cats = {};
    for (const p of bridge.presets()) cats[p.slot] = p.cat.toLowerCase();
    st.banks.set(0, { name: "PRO-8000 presets", area, fx: {}, cats });
    st.slot = bridge.slot();
    st.version = bridge.version();
    st.node = true;
    bridge.listen(onEngine);
    st.fxInfo = (await ask({ t: "fxInfo" })).info;
    st.fxDefaults = bridge.fxDefaults || (await ask({ t: "fxValues" })).values;
    st.started = true;
    changed("started");
  }

  window.p8_send = (bytes) => {
    if (!st.node) return;
    const m = Array.from(bytes);
    post({ t: "send", m });
    if (isOurs(m)) bridge.changed();
  };
  const bankArea = (n) => (st.banks.get(n) || {}).area || new Uint8Array(PATCH_AREA);
  const calls = {
    status() {
      const b = st.banks.get(st.bank) || {};
      return { bank: st.bank, bankName: b.name || "", slot: st.slot, timing: st.timing, sound: "synth", mode: "standalone", hostClock: false,
        standalone: true, web: true, firmware: st.version, version: "minidaw", library: "this project",
        link: { connected: false, busy: false, progress: 0, message: "" } };
    },
    selectBank(n, slot = -1) {
      n = Math.max(0, n | 0);
      if (!st.banks.has(n)) st.banks.set(n, { name: "", area: new Uint8Array(PATCH_AREA), fx: {} });
      st.bank = n;
      st.slot = slot < 0 ? st.slot : slot;
      post({ t: "bank", area: bankArea(n).slice().buffer, slot: st.slot });
      post({ t: "fxDefaults" });
      changed("bank");
      bridge.changed();
      return true;
    },
    renameBank(n, name) { const b = st.banks.get(n); if (b) { b.name = String(name || "").slice(0, 64); changed("library"); } return true; },
    newBank() { return Math.max(-1, ...st.banks.keys()) + 1; },
    banks: () => [...st.banks.keys()].sort((a, b) => a - b).map((n) => ({ bank: n, name: st.banks.get(n).name })),
    slotNames(n) { const a = bankArea(n == null ? st.bank : n); return Array.from({ length: 128 }, (_, s) => recordName(a.subarray(s * RECORD, (s + 1) * RECORD))); },
    setTiming(ideal) { st.timing = ideal ? 1 : 0; post({ t: "timing", ideal: !!ideal }); },
    setHostClock() {}, setSound() {}, sendSound() {}, openLibraryFolder() {}, setMode() {},
    fxInfo: () => st.fxInfo && { params: JSON.stringify(st.fxInfo.params), keys: st.fxInfo.keys, presets: st.fxInfo.presets },
    fxValues: () => ask({ t: "fxValues" }).then((r) => ({ values: r.values, active: r.active })),
    fxSet(i, v) { post({ t: "fx", i, v }); bridge.changed(); },
    fxPreset(k) { post({ t: "fxPreset", k }); bridge.changed(); },
    openUrl(url) { if (/^https?:/.test(url)) window.open(url, "_blank", "noopener"); },
    audioInfo() { return { web: true, devices: [], device: "", rate: 44100, buffer: 128, running: true, actualDevice: "minidaw", actualRate: 44100, actualBuffer: 128, error: "", midi: [], midiNote: "Play it from minidaw's Keys tab or a MIDI keyboard on the track" }; },
    setMidiInput() {},
    library: () => ({ bank: st.bank, slot: st.slot, banks: [...st.banks.keys()].sort((a, b) => a - b).map((n) => {
      const b = st.banks.get(n);
      return { bank: n, name: b.name, cats: b.cats || null, names: calls.slotNames(n) };
    }) }),
    capture: (name) => ask({ t: "capture", name: name || "" }).then((r) => r.record),
    loadRecord(record, slot) { post({ t: "load", record, slot }); bridge.changed(); },
    saveExport(name, b64) {
      const bin = atob(b64), u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([u]));
      a.download = name;
      HTMLAnchorElement.prototype.click.call(a);
      return "your downloads";
    },
  };
  window.p8_call = (name, ...args) => {
    if (!st.started) return name === "status" || !calls[name] ? Promise.resolve(null) : whenStarted.then(() => window.p8_call(name, ...args));
    try { return Promise.resolve(calls[name] ? calls[name](...args) : null); } catch (e) { return Promise.reject(e); }
  };
  window.p8_web = { onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); }, state: st };
  window.__p8_realAccess = () => null;
  let started;
  const whenStarted = new Promise((r) => { started = r; });

  const boot = () => start().then(() => {
    started();
    // the editor tried its port before there was an engine: once that attempt is over, it connects (as p8-web.js)
    const tryConnect = () => {
      try {
        if (typeof connecting !== "undefined" && connecting) { setTimeout(tryConnect, 250); return; }
        if (typeof output !== "undefined" && output) return;
        connect();
      } catch (e) { setTimeout(tryConnect, 250); }
    };
    tryConnect();
  }).catch((err) => { document.title = "PRO-8000 V: " + (err.message || err); console.error(err); });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
