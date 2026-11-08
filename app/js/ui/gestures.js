// Pointer gestures for touch and mouse alike: tap, double tap, long press (the iPad's right click), one-finger drag,
// and two-finger pinch / pan. Handlers get positions in the element's own CSS pixels.
//
//   gestures(el, { tap(p, e), doubleTap(p, e), longPress(p, e), dragStart(p, e) -> bool, dragMove(p, d, e), dragEnd(p, e),
//                  pinch({scale, cx, cy, dx, dy}), pinchEnd(), wheel(e) })
// dragStart returning false lets the gesture fall through (e.g. a drag on empty space). A drag starts after a few
// pixels of movement; the long press fires if the finger stays still for LONG_MS.

const MOVE_PX = 6;
const LONG_MS = 480;
const DOUBLE_MS = 320;

export function gestures(el, h) {
  const pointers = new Map();
  let drag = null, pinch = null, longTimer = 0, lastTap = { t: 0, x: 0, y: 0 }, suppressTap = false;

  const pos = (e) => {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, cx: e.clientX, cy: e.clientY, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey || e.ctrlKey, button: e.button, type: e.pointerType };
  };

  function down(e) {
    if (e.button === 2) { // right click: the long press
      e.preventDefault();
      if (h.longPress) h.longPress(pos(e), e);
      return;
    }
    if (e.pointerType === "mouse" && e.button !== 0) return;
    el.setPointerCapture && el.setPointerCapture(e.pointerId);
    const p = pos(e);
    pointers.set(e.pointerId, { start: p, last: p });
    if (pointers.size === 2 && h.pinch) {
      clearTimeout(longTimer);
      if (drag && drag.started && h.dragEnd) h.dragEnd(drag.last, e, true);
      drag = null;
      const [a, b] = [...pointers.values()];
      pinch = { d0: dist(a.last, b.last), c0: mid(a.last, b.last) };
      suppressTap = true;
      return;
    }
    if (pointers.size > 1) return;
    suppressTap = false;
    drag = { start: p, last: p, started: false, id: e.pointerId, accepted: undefined };
    clearTimeout(longTimer);
    if (h.longPress) {
      longTimer = setTimeout(() => {
        if (drag && !drag.started) {
          const d = drag;
          drag = null;
          suppressTap = true;
          h.longPress(d.start, e);
        }
      }, LONG_MS);
    }
    if (h.press) h.press(p, e);
  }

  function move(e) {
    const ptr = pointers.get(e.pointerId);
    if (!ptr) return;
    const p = pos(e);
    ptr.last = p;
    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const d = dist(a.last, b.last), c = mid(a.last, b.last);
      h.pinch({ scale: d / Math.max(1, pinch.d0), cx: c.x, cy: c.y, dx: c.x - pinch.c0.x, dy: c.y - pinch.c0.y, sx: Math.abs(a.last.x - b.last.x) / Math.max(1, Math.abs(a.start.x - b.start.x)), sy: Math.abs(a.last.y - b.last.y) / Math.max(1, Math.abs(a.start.y - b.start.y)) });
      pinch.d0 = d; pinch.c0 = c;
      e.preventDefault();
      return;
    }
    if (!drag || drag.id !== e.pointerId) return;
    if (!drag.started) {
      if (Math.hypot(p.x - drag.start.x, p.y - drag.start.y) < MOVE_PX) return;
      clearTimeout(longTimer);
      drag.started = true;
      drag.accepted = h.dragStart ? h.dragStart(drag.start, e) !== false : false;
    }
    drag.last = p;
    if (drag.accepted && h.dragMove) {
      h.dragMove(p, { x: p.x - drag.start.x, y: p.y - drag.start.y }, e);
      e.preventDefault();
    }
  }

  function up(e) {
    const ptr = pointers.get(e.pointerId);
    pointers.delete(e.pointerId);
    clearTimeout(longTimer);
    if (pinch) {
      if (pointers.size < 2) { pinch = null; if (h.pinchEnd) h.pinchEnd(); }
      return;
    }
    if (!drag || drag.id !== e.pointerId) return;
    const d = drag;
    drag = null;
    const p = ptr ? ptr.last : d.last;
    if (d.started) { if (d.accepted && h.dragEnd) h.dragEnd(p, e); return; }
    if (suppressTap || e.type === "pointercancel") return;
    const now = performance.now();
    if (h.doubleTap && now - lastTap.t < DOUBLE_MS && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 24) {
      lastTap.t = 0;
      h.doubleTap(d.start, e);
      return;
    }
    lastTap = { t: now, x: p.x, y: p.y };
    if (h.tap) h.tap(d.start, e);
  }

  el.addEventListener("pointerdown", down);
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", up);
  el.addEventListener("contextmenu", (e) => e.preventDefault());
  if (h.wheel) el.addEventListener("wheel", (e) => { e.preventDefault(); h.wheel(e, pos(e)); }, { passive: false });
  return () => {
    el.removeEventListener("pointerdown", down);
    el.removeEventListener("pointermove", move);
    el.removeEventListener("pointerup", up);
    el.removeEventListener("pointercancel", up);
  };
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** A canvas that keeps its backing store at the device's pixel ratio; draw(ctx, w, h) in CSS pixels */
export class Surface {
  constructor(canvas, draw) {
    this.canvas = canvas;
    this.drawFn = draw;
    this.ctx = canvas.getContext("2d");
    this.w = 0; this.h = 0;
    this.queued = false;
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
  }
  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
    if (w !== this.w || h !== this.h || this.dpr !== dpr) {
      this.w = w; this.h = h; this.dpr = dpr;
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    this.draw();
  }
  draw() {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      if (!this.w) return;
      const c = this.ctx;
      c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.drawFn(c, this.w, this.h);
    });
  }
  dispose() { this.ro.disconnect(); }
}
