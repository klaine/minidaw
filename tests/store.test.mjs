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
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
