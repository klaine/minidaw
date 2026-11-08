/* FX routing diagram for the Effects card (docs/11 section 2): each active
 * layer to Dry / FX 1 / FX 2 with its send, the two slots, and Serial
 * (FX 1 feeds FX 2) or Parallel to the output.  Click a layer to cycle its
 * route, click between the slots to switch Serial / Parallel.  Loaded after
 * first paint.
 */
import { lazyStyles } from "./lazy.js";

lazyStyles();

const SVG = "http://www.w3.org/2000/svg";
const W = 300, H = 132;

function svg(tag, attrs = {}, text) {
  const e = document.createElementNS(SVG, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (text !== undefined) e.textContent = text;
  return e;
}

export function fxChain(store) {
  const box = svg("svg", { class: "fxchain", viewBox: `0 0 ${W} ${H}`, role: "group", "aria-label": "Effects routing" });
  const fxType = (n) => store.metaFor("fx" + n + "_type").options[Math.round(store.num("fx" + n + "_type"))];

  const draw = () => {
    box.textContent = "";
    const count = Math.round(store.num("layer_count", 1));
    const serial = store.num("fx_chain") >= 0.5;
    const ys = Array.from({ length: count }, (_, i) => 18 + i * ((H - 36) / Math.max(1, count - 1 || 1)));
    if (count === 1) ys[0] = H / 2;
    const target = { 0: [254, H / 2], 1: [150, 34], 2: [150, 98] };   // Dry→out, FX1, FX2
    const slot = (n, y) => {
      const off = fxType(n) === "Off";
      const g = svg("g", { class: "fx-node" + (off ? " off" : "") });
      g.append(svg("rect", { x: 120, y: y - 14, width: 76, height: 28, rx: 6 }),
        svg("text", { x: 158, y: y + 4, "text-anchor": "middle" }, "FX" + n + " " + fxType(n)));
      return g;
    };
    const wires = svg("g", { class: "fx-wires" });
    box.append(wires);
    // Slots to out, and the serial link.
    wires.append(svg("path", { d: `M196 34 ${serial ? "C 220 34, 220 66, 196 84" : `L 254 ${H / 2}`}`, class: "fx-wire" + (serial ? " serial" : "") }));
    wires.append(svg("path", { d: `M196 98 L 254 ${H / 2}`, class: "fx-wire" }));
    box.append(slot(1, 34), slot(2, 98));
    const out = svg("g", { class: "fx-out" });
    out.append(svg("circle", { cx: 270, cy: H / 2, r: 14 }), svg("text", { x: 270, y: H / 2 + 4, "text-anchor": "middle" }, "Out"));
    box.append(out);
    // Serial/Parallel toggle between the slots.
    const chain = svg("g", { class: "fx-chain-toggle", tabindex: "0", role: "button",
      "aria-label": "FX chain: " + (serial ? "Serial" : "Parallel") + ". Activate to switch." });
    chain.append(svg("rect", { x: 128, y: 56, width: 60, height: 20, rx: 10 }),
      svg("text", { x: 158, y: 70, "text-anchor": "middle" }, serial ? "Serial ↓" : "Parallel"));
    const flip = () => store.set("fx_chain", serial ? "0" : "1");
    chain.addEventListener("click", flip);
    chain.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); flip(); } });
    box.append(chain);

    ys.forEach((y, i) => {
      const n = i + 1;
      const route = Math.round(store.num("l" + n + "_route"));
      const send = store.num("l" + n + "_send");
      const [tx, ty] = target[route] || target[0];
      const muted = store.num("l" + n + "_on") < 0.5;
      wires.append(svg("path", { d: `M44 ${y} C 90 ${y}, 90 ${ty}, ${tx} ${ty}`,
        class: "fx-wire layer", style: `--c: var(--l${n}); opacity: ${muted ? 0.3 : 0.3 + 0.7 * Math.min(1, route ? send : 1)}` }));
      const g = svg("g", { class: "fx-layer" + (muted ? " muted" : ""), tabindex: "0", role: "button", style: `--c: var(--l${n})`,
        "aria-label": "Layer " + n + " routed to " + ["Dry", "FX 1", "FX 2"][route] + ". Activate to change." });
      g.append(svg("rect", { x: 4, y: y - 11, width: 40, height: 22, rx: 6 }),
        svg("text", { x: 24, y: y + 4, "text-anchor": "middle" }, "L" + n));
      const cycle = () => store.set("l" + n + "_route", String((route + 1) % 3));
      g.addEventListener("click", cycle);
      g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); cycle(); } });
      if (route) {
        g.append(svg("text", { x: 58, y: y - 5, class: "fx-send" }, Math.round(send * 100) + "%"));
      }
      box.append(g);
    });
  };

  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; draw(); });
  };
  const keys = ["layer_count", "fx_chain", "fx1_type", "fx2_type"];
  for (let n = 1; n <= 4; n++) keys.push("l" + n + "_route", "l" + n + "_send", "l" + n + "_on");
  for (const k of keys) store.bind(k, schedule);
  return box;
}
