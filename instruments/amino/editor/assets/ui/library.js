/* Factory preset and Load Layer lists (assets/ui_presets.json).  Loaded once,
 * after first paint, so they stay out of the initial payload. */
let pending = null;

export function loadLibrary() {
  if (!pending) {
    pending = fetch("assets/ui_presets.json", { cache: "no-cache" })
      .then((r) => { if (!r.ok) throw new Error("ui_presets.json " + r.status); return r.json(); })
      .catch((err) => { console.error(err); pending = null; return { categories: {}, presets: [], layerSources: [] }; });
  }
  return pending;
}

/** Load when the browser is idle (or soon), for UI that only decorates. */
export function loadLibraryWhenIdle() {
  return new Promise((resolve) => {
    const go = () => loadLibrary().then(resolve);
    if (window.requestIdleCallback) requestIdleCallback(go, { timeout: 1500 });
    else setTimeout(go, 300);
  });
}
