/* Help side panel.  Loaded on first open (the header's ? button or the ?
 * key).
 *
 * The top section follows the control under the pointer or keyboard focus:
 * its full name, range and default in real units, current value, which layer
 * it edits, what the curve means and how the matrix moves it.  Below that,
 * the matching page of help.json (the same text as Move's on-device help)
 * and every help topic.
 */
import { formatValue } from "./format.js";
import { lazyStyles } from "./lazy.js";

lazyStyles();

const CURVES = {
  note_hz: "Stored as a MIDI note (0–127); shown in Hz. The filter clamps to 20 Hz–18 kHz.",
  env_time: "0–20 s on a cubic curve, so the low end has fine control.",
  fade_time: "0–20 s on a cubic curve; 0 turns the fade off.",
  lfo_hz: "0.01–50 Hz on an exponential curve. Ignored while Sync is on.",
  glide_time: "0–5 s on a square curve.",
  wave_pos: "Positions 0–60 morph through the table; 61–63 are Triangle, Square and Saw in every table.",
};
/* Card / dock tab -> help.json page title. */
const PAGES = {
  osc1: "Osc 1", osc2: "Osc 2", dirt: "Mixer", filter: "Filter", amp: "Amp", fx: "FX",
  env: "Wave Env", lfo: "LFO 1", matrix: "Mod 1-8", play: "Play", voice: "Play", global: "Voice", layers: "Layers",
};

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

let panel = null;

export async function toggleHelp(store, opener) {
  if (!panel) panel = await build(store);
  panel.toggle(opener);
}

async function build(store) {
  let tree = { children: [] };
  try {
    const r = await fetch("help.json", { cache: "force-cache" });
    if (r.ok) tree = await r.json();
  } catch (e) { console.error("help.json", e); }
  const pages = new Map();
  const walk = (n) => { if (n.lines) pages.set(n.title, n.lines); (n.children || []).forEach(walk); };
  walk(tree);

  const aside = el("aside", "drawer drawer-right help-panel");
  aside.setAttribute("aria-label", "Help");
  const head = el("div", "drawer-head");
  head.append(el("h2", "card-title", "Help"));
  const close = el("button", "icon-btn", "×");
  close.setAttribute("aria-label", "Close help");
  head.appendChild(close);
  const info = el("section", "help-info");
  info.setAttribute("aria-live", "polite");
  const page = el("section", "help-page");
  const topics = el("section", "help-topics");
  aside.append(head, info, page, topics);
  document.body.appendChild(aside);

  /* Topics: the top-level help nodes, except the per-page list. */
  for (const node of tree.children || []) {
    if (!node.lines) continue;
    const d = el("details", "help-topic");
    d.appendChild(el("summary", "", node.title));
    d.appendChild(el("pre", "help-lines", node.lines.join("\n")));
    topics.appendChild(d);
  }

  const showPage = (title) => {
    page.textContent = "";
    const lines = pages.get(title);
    if (!lines) return;
    page.append(el("h3", "group-title", "On Move: " + title + " page"), el("pre", "help-lines", lines.join("\n")));
  };

  const describe = (target) => {
    const key = target.dataset.key;
    const meta = target.getMeta ? target.getMeta() : store.metaFor(key);
    if (!meta) return;
    info.textContent = "";
    const concrete = store.layerKeys.has(key) ? store.resolve(key) : key;
    const layer = /^l([1-4])_/.exec(concrete);
    info.appendChild(el("h3", "help-name", meta.name));
    const dl = el("dl", "help-facts");
    const fact = (k, v) => { if (v) dl.append(el("dt", "", k), el("dd", "", v)); };
    const lo = meta.min !== undefined ? meta.min : 0, hi = meta.max !== undefined ? meta.max : 1;
    fact("Value", formatValue(meta, store.get(concrete)));
    fact("Range", meta.options ? meta.options.join(" · ") : formatValue(meta, lo) + " … " + formatValue(meta, hi));
    if (meta.default !== undefined) fact("Default", formatValue(meta, meta.default));
    fact("Edits", layer ? "Layer " + layer[1] + " (follows the edit layer)" : "All layers");
    const dst = store.mod && store.mod.targetIndex.get(key);
    if (dst !== undefined) {
      const scale = store.meta.modTargetScale[dst];
      fact("Mod target", store.meta.params.m1_dst.options[dst] + (scale === "mul"
        ? ": amount scales the value" : ": amount 100% moves it by " + scale + (key === "cutoff" ? " semitones" : "")));
    }
    fact("Key", concrete);
    info.appendChild(dl);
    const curve = meta.display && CURVES[meta.display.kind];
    if (curve) info.appendChild(el("p", "hint", curve));
    const cardId = (target.closest(".card")?.className.match(/card-(\w+)/) || [])[1];
    const tab = target.closest(".dock-pane")?.dataset.tab;
    const tagged = target.closest("[data-help]")?.dataset.help;
    showPage(PAGES[tagged] || PAGES[cardId] || PAGES[tab] || "");
  };

  const follow = (e) => {
    if (!aside.classList.contains("open")) return;
    const t = e.target.closest && e.target.closest("[data-key]");
    if (t && !aside.contains(t)) describe(t);
  };
  document.addEventListener("pointerover", follow);
  document.addEventListener("focusin", follow);

  let opener = null;
  const hide = () => {
    aside.classList.remove("open");
    document.documentElement.classList.remove("help-open");
    opener?.setAttribute("aria-expanded", "false");
  };
  close.onclick = () => { hide(); opener?.focus(); };
  aside.addEventListener("keydown", (e) => { if (e.key === "Escape") { hide(); opener?.focus(); } });
  info.appendChild(el("p", "hint", "Point at or focus any control to see what it does."));
  showPage("Overview");

  return {
    toggle(from) {
      opener = from || opener;
      if (aside.classList.contains("open")) { hide(); return; }
      aside.classList.add("open");
      document.documentElement.classList.add("help-open");
      opener?.setAttribute("aria-expanded", "true");
    },
  };
}
