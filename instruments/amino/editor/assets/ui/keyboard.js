/* On-screen keyboard: plays the synth from the browser through the
 * "audition" parameter (amino.c amino_audition).  Loaded on first open.
 *
 * Two octaves; velocity comes from how far down the key is pressed.  Several
 * pointers play chords and dragging across keys glides from note to note.
 * While the bar is open the computer keyboard plays too (A W S E D F T G Y H
 * U J K, Z/X shift the octave), except while typing in a field.  Every held
 * note is released when the bar closes or the page is hidden; the engine also
 * releases audition notes on its own after 30 s.
 */
import { lazyStyles } from "./lazy.js";
import { noteName } from "./format.js";

lazyStyles();

const KEYS = 25;
const BLACK = [1, 3, 6, 8, 10];
const COMPUTER = "awsedftgyhujk";

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

let bar = null;

export function toggleKeyboard(store, opener) {
  if (!bar) bar = build(store);
  bar.toggle(opener);
}

function build(store) {
  let octave = 3;                 // C3 = MIDI 48 at the left edge
  const held = new Map();         // note -> count of sources holding it
  const root = el("div", "keys-bar");
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", "Keyboard");
  const side = el("div", "keys-side");
  const down = el("button", "icon-btn", "−");
  const up = el("button", "icon-btn", "+");
  down.setAttribute("aria-label", "Octave down");
  up.setAttribute("aria-label", "Octave up");
  const label = el("span", "keys-oct");
  side.append(down, label, up);
  const board = el("div", "keys-board");
  root.append(side, board);
  document.body.appendChild(root);

  const base = () => 12 * (octave + 1);
  const keys = [];
  for (let i = 0; i < KEYS; i++) {
    const black = BLACK.includes(i % 12);
    const k = el("div", "kb-key" + (black ? " black" : ""));
    k.dataset.offset = String(i);
    board.appendChild(k);
    keys.push(k);
  }
  const paint = () => {
    label.textContent = noteName(base()) + "–" + noteName(base() + KEYS - 1);
    keys.forEach((k, i) => {
      k.classList.toggle("down", held.has(base() + i));
      if (i % 12 === 0) k.textContent = noteName(base() + i);
    });
  };

  const on = (note, vel) => {
    const n = held.get(note) || 0;
    held.set(note, n + 1);
    if (n === 0) store.send("audition", note + ":" + vel);
    paint();
  };
  const off = (note) => {
    const n = held.get(note) || 0;
    if (n <= 1) {
      held.delete(note);
      if (n === 1) store.send("audition", note + ":0");
    } else held.set(note, n - 1);
    paint();
  };
  const allOff = () => {
    if (!held.size) return;
    held.clear();
    store.send("audition", "off");
    paint();
  };

  /* Pointers: each tracks its own note so chords and glides work. */
  const pointers = new Map();
  const keyAt = (x, y) => {
    const hit = document.elementFromPoint(x, y);
    return hit && hit.classList && hit.classList.contains("kb-key") ? hit : null;
  };
  const velocity = (key, y) => {
    const r = key.getBoundingClientRect();
    return Math.max(20, Math.min(127, Math.round(30 + 97 * (y - r.top) / r.height)));
  };
  board.addEventListener("pointerdown", (e) => {
    const key = keyAt(e.clientX, e.clientY);
    if (!key) return;
    e.preventDefault();
    board.setPointerCapture(e.pointerId);
    const note = base() + Number(key.dataset.offset);
    pointers.set(e.pointerId, note);
    on(note, velocity(key, e.clientY));
  });
  board.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    const key = keyAt(e.clientX, e.clientY);
    if (!key) return;
    const note = base() + Number(key.dataset.offset);
    const prev = pointers.get(e.pointerId);
    if (note === prev) return;
    pointers.set(e.pointerId, note);
    on(note, velocity(key, e.clientY));
    off(prev);
  });
  const lift = (e) => {
    if (!pointers.has(e.pointerId)) return;
    off(pointers.get(e.pointerId));
    pointers.delete(e.pointerId);
  };
  board.addEventListener("pointerup", lift);
  board.addEventListener("pointercancel", lift);

  /* Computer keyboard. */
  const typing = (e) => /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);
  const keyDown = (e) => {
    if (!root.classList.contains("open") || e.repeat || e.metaKey || e.ctrlKey || e.altKey || typing(e)) return;
    const k = e.key.toLowerCase();
    if (k === "z" || k === "x") {
      shift(k === "z" ? -1 : 1);
      e.preventDefault();
      return;
    }
    const i = COMPUTER.indexOf(k);
    if (i < 0) return;
    e.preventDefault();
    on(base() + i, 100);
  };
  const keyUp = (e) => {
    const i = COMPUTER.indexOf(e.key.toLowerCase());
    if (i >= 0 && root.classList.contains("open")) off(base() + i);
  };
  document.addEventListener("keydown", keyDown);
  document.addEventListener("keyup", keyUp);

  const shift = (d) => {
    const next = Math.max(0, Math.min(7, octave + d));
    if (next === octave) return;
    allOff();
    octave = next;
    paint();
  };
  down.onclick = () => shift(-1);
  up.onclick = () => shift(1);

  /* Never leave notes hanging. */
  window.addEventListener("blur", allOff);
  window.addEventListener("pagehide", allOff);
  document.addEventListener("visibilitychange", () => { if (document.hidden) allOff(); });

  let opener = null;
  paint();
  return {
    toggle(from) {
      opener = from || opener;
      const open = !root.classList.contains("open");
      root.classList.toggle("open", open);
      document.documentElement.classList.toggle("keys-open", open);
      opener?.setAttribute("aria-expanded", String(open));
      if (!open) allOff();
    },
  };
}
