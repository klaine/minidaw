/* Live engine telemetry (get_param "rui_live", amino.c amino_live), pushed by
 * schwung-manager as a viz extra key: about every 500 ms at rest and 150 ms
 * after an edit.  Consumers get the parsed snapshot plus the local time it
 * arrived, so they can animate between updates (LFO phase runs on at its
 * rate) instead of stepping at 2 Hz.
 */

/** Parse "v=..;l=..;e=..;p=..;b=..;t=.." into an object, or null. */
export function parseLive(text) {
  if (!text || text.indexOf("v=") !== 0) return null;
  const f = {};
  for (const part of String(text).split(";")) {
    const i = part.indexOf("=");
    if (i > 0) f[part.slice(0, i)] = part.slice(i + 1);
  }
  const nums = (s) => (s && s !== "-" ? s.split(",").map(Number) : null);
  const v = nums(f.v) || [0, 0, 0, 0, 0];
  const l = nums(f.l);
  const e = nums(f.e);
  return {
    voices: v[0],
    layerVoices: v.slice(1, 5),
    lfo: l ? [{ phase: l[0], cur: l[1] }, { phase: l[2], cur: l[3] }] : null,
    env: e ? [0, 1, 2, 3].filter((k) => k * 2 + 1 < e.length).map((k) => ({ stage: e[k * 2], level: e[k * 2 + 1] })) : null,
    peak: Number(f.p) || 0,
    bpm: Number(f.b) || 120,
    clockMs: Number(f.t) || 0,
  };
}

/** Subscribe to telemetry: fn(snapshot, receivedAt) on every update. */
export function onLive(store, fn) {
  return store.bind("rui_live", (text) => {
    const snap = parseLive(text);
    if (snap) fn(snap, performance.now());
  });
}

/** Header readout: voice count and an output peak bar. */
export function liveMeter(store) {
  const wrap = document.createElement("div");
  wrap.className = "live-meter";
  wrap.title = "Voices playing and output peak (updates about twice a second)";
  const voices = document.createElement("span");
  voices.className = "live-voices";
  const bar = document.createElement("span");
  bar.className = "live-peak";
  const fill = document.createElement("i");
  bar.appendChild(fill);
  wrap.append(voices, bar);
  voices.textContent = "–";
  onLive(store, (s) => {
    voices.textContent = s.voices + (s.voices === 1 ? " voice" : " voices");
    fill.style.width = Math.round(Math.min(1, s.peak) * 100) + "%";
    wrap.classList.toggle("hot", s.peak > 0.95);
    wrap.classList.toggle("idle", s.voices === 0);
  });
  return wrap;
}
