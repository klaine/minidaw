// node tests/store.test.mjs: undo steps. A drag (live edits, then an update or a commit) is one step that undoes to
// the state before the drag; a recording (locked) adds none of its own.
import { Store } from "../app/js/store.js";
import { newProject } from "../app/js/model.js";

let failures = 0;
const check = (ok, what) => { if (!ok) { failures++; console.log("  FAIL " + what); } else console.log("  ok   " + what); };

const s = new Store(newProject());
s.update((p) => { p.bpm = 100; });
// a knob: live while dragging, an update at the end
s.live((p) => { p.bpm = 110; });
s.live((p) => { p.bpm = 120; });
s.update((p) => { p.bpm = 125; });
check(s.undoStack.length === 2, "the drag is one step (" + s.undoStack.length + ")");
s.undo();
check(s.project.bpm === 100, "undo goes back to before the drag (" + s.project.bpm + ")");
s.redo();
check(s.project.bpm === 125, "redo to its end (" + s.project.bpm + ")");
// a gesture: begin, live, commit
s.begin();
s.live((p) => { p.bpm = 90; });
s.live((p) => { p.bpm = 80; });
s.commit();
s.undo();
check(s.project.bpm === 125, "a begin/commit gesture undoes as one (" + s.project.bpm + ")");
// live edits left open become their step at the next undo
s.redo();
s.live((p) => { p.bpm = 70; });
s.undo();
check(s.project.bpm === 80, "an open live edit is undone first (" + s.project.bpm + ")");
// locked (recording): no steps of its own
const n = s.undoStack.length;
s.locked = true;
s.update((p) => { p.bpm = 60; });
s.live((p) => { p.bpm = 61; });
check(s.undoStack.length === n && !s.pending, "while locked nothing becomes a step");
check(s.undo() === false, "and undo waits");
s.locked = false;
// ---- steps share what they didn't change
{
  const p = newProject();
  const mk = (id, n) => ({ id, type: "midi", name: id, length: 16, notes: Array.from({ length: n }, (_, i) => ({ p: 36 + (i % 48), t: (i % 64) * 0.25, d: 0.25, v: 100 })), env: {} });
  p.tracks.push({ id: "t1", name: "A", type: "midi", instrument: { kind: "crest", state: { state: "x".repeat(2000) } }, mixer: { vol: 0.7 }, slots: ["a"], arrangement: [{ id: "pl", clipId: "a", start: 0, length: 16 }], automation: {}, lanes: [] });
  p.tracks.push({ id: "t2", name: "B", type: "midi", instrument: { kind: "amino", state: null }, mixer: { vol: 0.7 }, slots: ["b"], arrangement: [], automation: {}, lanes: [] });
  p.clips.a = mk("a", 400); p.clips.b = mk("b", 300); p.clips.big = mk("big", 2000);
  const st = new Store(p);
  st.update((q) => { q.clips.a.notes[0].p = 99; });      // step 1: clip a
  st.update((q) => { q.clips.b.notes[0].p = 98; });      // step 2: clip b
  st.update((q) => { q.tracks[1].mixer.vol = 0.2; });    // step 3: track B
  const [s0, s1, s2] = st.undoStack;
  check(s0.clips.big === s1.clips.big && s1.clips.big === s2.clips.big, "a clip nothing touched is one object in every step");
  check(s0.clips.a !== s1.clips.a && s1.clips.a === s2.clips.a, "an edited clip is new in the step after the edit, then shared again");
  check(s0.tracks[0] === s2.tracks[0] && s1.tracks[1] === s2.tracks[1], "tracks too");
  st.update((q) => { q.bpm = 90; });                     // step 4: its "before" holds only what step 3 changed (track B)
  const s3 = st.undoStack[3];
  check(s0.chars > 20 * s3.chars, `a step holds what changed: the first ${s0.chars} characters, the one after a mixer move ${s3.chars}`);
  st.undo();
  // going back and forth, with edits in between, leaves the steps as they were
  st.undo(); st.undo();
  check(st.project.clips.a.notes[0].p === 99 && st.project.clips.b.notes[0].p === 36 + 0 && st.project.tracks[1].mixer.vol === 0.7, "two steps back: clip a edited, clip b and track B as before");
  st.project.clips.big.notes[5].p = 1; // (as an edit in place would)
  check(s0.clips.big.notes[5].p !== 1 && s2.clips.big.notes[5].p !== 1, "the project gone back to is a copy: changing it doesn't reach the steps");
  st.project.clips.big.notes[5].p = 36 + 5;
  st.redo(); st.redo();
  check(st.project.clips.b.notes[0].p === 98 && st.project.tracks[1].mixer.vol === 0.2, "and forward again: all three edits");
  st.undo(); st.undo(); st.undo();
  check(st.project.clips.a.notes[0].p === 36 && JSON.stringify(st.project.clips) === JSON.stringify(s0.clips), "back at the start, note for note");
  // a dragged edit that is cancelled: the project is as before, and the kept state is untouched
  st.begin(); st.live((q) => { q.clips.a.notes[1].p = 5; }); st.cancel();
  check(st.project.clips.a.notes[1].p === 37, "a cancelled drag");
}

// ---- a large song: 120 steps cost what they change, not 120 copies
{
  const p = newProject();
  const clips = 100, per = 500; // 50,000 notes
  for (let c = 0; c < clips; c++) p.clips["c" + c] = { id: "c" + c, type: "midi", name: "c" + c, length: 16, notes: Array.from({ length: per }, (_, i) => ({ p: 36 + (i % 48), t: (i % 64) * 0.25, d: 0.25, v: 100 })), env: {} };
  p.tracks.push({ id: "t", name: "T", type: "midi", instrument: { kind: "crest", state: null }, mixer: { vol: 0.7 }, slots: [], arrangement: Object.keys(p.clips).map((id, i) => ({ id: "p" + i, clipId: id, start: i * 16, length: 16 })), automation: {}, lanes: [] });
  const st = new Store(p);
  const whole = JSON.stringify(p).length;
  const t0 = performance.now();
  for (let i = 0; i < 120; i++) st.update((q) => { q.clips["c" + (i % clips)].notes[i].v = 50; });
  const ms = (performance.now() - t0) / 120;
  const held = st.undoStack.reduce((n, x) => n + x.chars, 0);
  check(st.undoStack.length === 120, "120 steps kept");
  check(held < whole * 3, `120 edits of a 50,000-note song hold ${(held / 1e6).toFixed(1)} M characters (the song is ${(whole / 1e6).toFixed(1)} M; whole copies would be ${(whole * 120 / 1e6).toFixed(0)} M)`);
  console.log(`       (${ms.toFixed(1)} ms an edit)`);
  for (let i = 0; i < 120; i++) st.undo();
  check(st.project.clips.c7.notes[7].v === 100 && st.undoStack.length === 0, "and all 120 undo");
  // one very large clip edited over and over: the far steps go rather than the memory
  const big = newProject();
  big.clips.x = { id: "x", type: "midi", name: "x", length: 64, notes: Array.from({ length: 150000 }, (_, i) => ({ p: 36 + (i % 48), t: (i % 256) * 0.25, d: 0.25, v: 100 })), env: {} };
  const sb = new Store(big);
  for (let i = 0; i < 14; i++) sb.update((q) => { q.clips.x.notes[i].v = 1; });
  const kept = sb.undoStack.reduce((n, x) => n + x.chars, 0);
  check(sb.undoStack.length >= 8 && sb.undoStack.length < 14 && kept <= 60e6, `a 150,000-note clip edited 14 times: ${sb.undoStack.length} steps kept (${(kept / 1e6).toFixed(0)} M characters)`);
}

console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
