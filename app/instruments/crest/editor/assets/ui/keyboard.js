/* Playing the browser engine: on-screen keys (velocity slider), the computer keyboard
 * (A..K row, Z/X octave), mod wheel and pitch bend strips, Web MIDI input, and the transport that
 * clocks tempo-synced LFOs, the delay and the arpeggiator. Only built in the standalone page. */
import { h } from "./controls.js";
import { noteName } from "./format.js";

const KEYMAP = "awsedftgyhujkolp;'";

/* Keep `held` up to date with one incoming MIDI message. Channels are merged, as they are on the way
 * into the engine, so one note off ends the note; velocity 0 is a note off. */
export function trackMidiNote(held, m) {
  if (m[0] === 0x90 && m[2] > 0) held.add(m[1]);
  else if (m[0] === 0x80 || m[0] === 0x90) held.delete(m[1]);
  else if (m[0] === 0xb0 && (m[1] === 120 || m[1] === 123)) held.clear();
}

export function buildPlayer(link) {
  let octave = 4;
  const down = new Map(); // note -> source
  const midiHeld = new Set(); // notes held by MIDI inputs, lit on the keyboard
  const keys = [];
  const send = (m) => link.midi(m);
  const noteOn = (n, v, src) => { if (down.has(n)) return; down.set(n, src); send([0x90, n, v]); paint(); };
  const noteOff = (n) => { if (!down.has(n)) return; down.delete(n); send([0x80, n, 0]); paint(); };
  const allOff = () => { for (const n of [...down.keys()]) noteOff(n); };
  /* A device went away or its input was deselected: its note offs will never arrive. */
  const releaseMidi = () => { for (const n of midiHeld) send([0x80, n, 0]); midiHeld.clear(); paint(); };

  const kb = h("div", { class: "keys", role: "group", "aria-label": "Keyboard" });
  const vel = h("input", { type: "range", min: 1, max: 127, value: 100, "aria-label": "Velocity" });
  /* As many octaves as the width holds (about 34px a white key), like Bizar's on-screen keyboard. */
  function build() {
    kb.textContent = "";
    keys.length = 0;
    const width = kb.clientWidth;
    if (!width) return;
    const whites = Math.max(7, Math.min(36, Math.floor(width / 34)));
    const ww = width / whites;
    let n = 12 * (octave + 1), wi = 0;
    while (wi < whites && n <= 127) {
      const black = [1, 3, 6, 8, 10].includes(n % 12);
      const k = h("div", { class: "key" + (black ? " black" : ""), "data-note": n });
      if (black) { k.style.left = (wi * ww - ww * 0.32) + "px"; k.style.width = (ww * 0.64) + "px"; }
      else {
        k.style.left = (wi * ww) + "px"; k.style.width = ww + "px";
        if (n % 12 === 0) k.append(h("span", { class: "note" }, noteName(n)));
        wi++;
      }
      const i = n - 12 * (octave + 1);
      if (i < KEYMAP.length) k.append(h("span", { class: "hint" }, KEYMAP[i].toUpperCase()));
      kb.append(k);
      keys.push(k);
      n++;
    }
    paint();
  }
  new ResizeObserver(build).observe(kb);
  function paint() { for (const k of keys) { const n = Number(k.dataset.note); k.classList.toggle("down", down.has(n) || midiHeld.has(n)); } }

  /* Pointers: one per finger, and dragging across keys glides from note to note. */
  const pointers = new Map();
  const noteAt = (x, y) => {
    const k = document.elementFromPoint(x, y)?.closest(".key");
    return k && kb.contains(k) ? Number(k.dataset.note) : null;
  };
  kb.addEventListener("pointerdown", (e) => {
    const n = noteAt(e.clientX, e.clientY);
    if (n == null) return;
    e.preventDefault();
    try { kb.setPointerCapture(e.pointerId); } catch { /* synthetic event */ }
    pointers.set(e.pointerId, n);
    noteOn(n, Number(vel.value), "pointer:" + e.pointerId);
  });
  kb.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    const n = noteAt(e.clientX, e.clientY), prev = pointers.get(e.pointerId);
    if (n == null || n === prev) return;
    noteOff(prev);
    pointers.set(e.pointerId, n);
    noteOn(n, Number(vel.value), "pointer:" + e.pointerId);
  });
  const lift = (e) => {
    if (!pointers.has(e.pointerId)) return;
    noteOff(pointers.get(e.pointerId));
    pointers.delete(e.pointerId);
  };
  kb.addEventListener("pointerup", lift);
  kb.addEventListener("pointercancel", lift);

  const typing = (e) => /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) || e.target.isContentEditable;
  window.addEventListener("keydown", (e) => {
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || typing(e)) return;
    const i = KEYMAP.indexOf(e.key.toLowerCase());
    if (i >= 0) { noteOn(12 * (octave + 1) + i, Number(vel.value), "kbd:" + e.key.toLowerCase()); e.preventDefault(); }
    else if (e.key === "z" || e.key === "x") { allOff(); octave = Math.max(0, Math.min(7, octave + (e.key === "x" ? 1 : -1))); octLabel.textContent = "C" + octave; build(); }
  });
  window.addEventListener("keyup", (e) => {
    const i = KEYMAP.indexOf(e.key.toLowerCase());
    if (i >= 0) noteOff(12 * (octave + 1) + i);
  });
  window.addEventListener("blur", allOff);

  /* wheel and bend: two touch strips, the bend springs back */
  const strip = (label, spring, onValue) => {
    const thumb = h("i");
    const s = h("div", { class: "strip", role: "slider", "aria-label": label, tabindex: 0 }, thumb);
    let v = spring ? 0.5 : 0;
    const show = () => { thumb.style.bottom = `calc(${(v * 100).toFixed(1)}% - 3px)`; };
    const at = (e) => { const r = s.getBoundingClientRect(); v = Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height)); show(); onValue(v); };
    s.addEventListener("pointerdown", (e) => { s.setPointerCapture(e.pointerId); at(e); });
    s.addEventListener("pointermove", (e) => { if (s.hasPointerCapture(e.pointerId)) at(e); });
    s.addEventListener("pointerup", () => { if (spring) { v = 0.5; show(); onValue(v); } });
    show();
    return h("div", { class: "strip-wrap" }, s, h("span", { class: "lbl" }, label));
  };
  const bend = strip("Bend", true, (v) => { const b = Math.round(v * 16383); send([0xe0, b & 127, b >> 7]); });
  const wheel = strip("Mod", false, (v) => send([0xb0, 1, Math.round(v * 127)]));

  const octLabel = h("span", { class: "oct" }, "C4");
  const octDown = h("button", { type: "button", class: "chip", "aria-label": "Octave down", onclick: () => { allOff(); octave = Math.max(0, octave - 1); octLabel.textContent = "C" + octave; build(); } }, "−");
  const octUp = h("button", { type: "button", class: "chip", "aria-label": "Octave up", onclick: () => { allOff(); octave = Math.min(7, octave + 1); octLabel.textContent = "C" + octave; build(); } }, "+");

  /* transport */
  const bpm = h("input", { type: "number", min: 40, max: 240, value: 120, "aria-label": "Tempo (BPM)" });
  const run = h("input", { type: "checkbox", "aria-label": "Run the transport" });
  const tempo = () => link.tempo(Number(bpm.value) || 120, run.checked);
  bpm.addEventListener("change", tempo);
  run.addEventListener("change", tempo);

  /* Web MIDI */
  const midiSel = h("select", { "aria-label": "MIDI input" }, h("option", { value: "" }, "No MIDI input"));
  const midiIn = h("label", { class: "sel" }, h("span", { class: "lbl" }, "MIDI"), midiSel);
  if (navigator.requestMIDIAccess) {
    navigator.requestMIDIAccess().then((access) => {
      const fill = () => {
        const cur = midiSel.value;
        midiSel.textContent = "";
        midiSel.append(h("option", { value: "" }, "No MIDI input"), h("option", { value: "*" }, "All inputs"));
        for (const inp of access.inputs.values()) midiSel.append(h("option", { value: inp.id }, inp.name));
        midiSel.value = cur || (access.inputs.size ? "*" : "");
      };
      const onMsg = (e) => {
        if (midiSel.value !== "*" && midiSel.value !== e.target.id) return;
        const d = e.data;
        if (d[0] >= 0xf0) return;
        const m = [d[0] & 0xf0, d[1] | 0, d[2] | 0]; // all channels into the one instance
        send(m);
        trackMidiNote(midiHeld, m);
        paint();
      };
      for (const inp of access.inputs.values()) inp.onmidimessage = onMsg;
      access.onstatechange = (e) => {
        if (e.port.state === "disconnected") releaseMidi();
        for (const inp of access.inputs.values()) inp.onmidimessage = onMsg;
        fill();
      };
      midiSel.addEventListener("change", releaseMidi);
      fill();
    }).catch(() => { midiSel.disabled = true; midiSel.firstChild.textContent = "MIDI unavailable"; });
  } else {
    midiSel.disabled = true;
    midiSel.firstChild.textContent = "No Web MIDI here";
  }

  return h("footer", { class: "player" },
    h("div", { class: "strips" }, bend, wheel),
    kb,
    h("div", { class: "player-ctl" },
      h("div", { class: "row" }, octDown, octLabel, octUp),
      h("label", { class: "sel" }, h("span", { class: "lbl" }, "Velocity"), vel),
      h("label", { class: "sel" }, h("span", { class: "lbl" }, "BPM"), bpm),
      h("label", { class: "sel chk" }, run, h("span", {}, "Play transport")),
      midiIn,
      h("p", { class: "hint-text" }, "Keys A–K play, Z / X shift the octave.")));
}
