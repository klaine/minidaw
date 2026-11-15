// The worklets' event queue (daw-worklet.js, p8-worklet.js); plain JS, also tested under node.
/* A time-ordered queue; ties keep their order (a note-off before a note-on at the same time stays first) */
export class EventQueue {
  constructor() { this.list = []; this.seq = 0; }
  push(e) {
    e.seq = this.seq++;
    const a = this.list;
    let lo = 0, hi = a.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (a[mid].time < e.time || (a[mid].time === e.time && a[mid].seq < e.seq)) lo = mid + 1; else hi = mid;
    }
    a.splice(lo, 0, e);
  }
  clear() { this.list.length = 0; }
}

