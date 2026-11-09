/* schwungRemote for an instrument's own editor inside minidaw: the surface Schwung's Remote UI gives (Schwung's
 * docs/MODULES.md; Amino's web/schwung-remote-api.js answers it in its own page the same way), answered by the DAW.
 * The editor runs in a same-origin iframe; ?track=<id> names the track whose engine it edits, and the DAW's bridge for
 * it is window.parent.minidaw.editorBridge(id) (js/ui/editor-host.js). Bizar's extras (schwungRemote.web: notes,
 * panic) are there too. */
(function () {
  "use strict";
  const query = new URLSearchParams(location.search);
  const component = query.get("component") || "synth";
  const prefix = component + ":";
  const trackId = query.get("track");
  const bridge = window.parent && window.parent.minidaw && window.parent.minidaw.editorBridge(trackId);
  if (!bridge) { document.body.textContent = "Open this editor from minidaw."; return; }
  const cache = Object.create(null);
  const callbacks = [];
  let started = false;
  const strip = (key) => (key.startsWith(prefix) ? key.slice(prefix.length) : key);

  function deliver(values) {
    const params = {};
    for (const k in values) { params[prefix + k] = values[k]; cache[prefix + k] = values[k]; }
    for (const cb of callbacks) { try { cb(params); } catch (err) { console.error(err); } }
  }

  window.schwungRemote = {
    component,
    onParamChange(cb) {
      callbacks.push(cb);
      if (!started) { started = true; bridge.subscribe(deliver); }
      else Promise.resolve().then(() => cb(Object.assign({}, cache)));
    },
    getParam(key) { return bridge.get(strip(key)).then((v) => (v === null || v === undefined ? (cache[key] ?? null) : v)); },
    setParam(key, value) { cache[key] = String(value); bridge.set(strip(key), String(value)); return Promise.resolve(); },
    getHierarchy() { return bridge.hierarchy(); },
    getChainParams() { return bridge.chainParams(); },
    web: {
      noteOn(note, vel) { bridge.noteOn(note, vel == null ? 100 : vel); },
      noteOff(note) { bridge.noteOff(note); },
      panic() { bridge.panic(); },
      onMidi(fn) { bridge.onMidi(fn); },
    },
  };
})();
