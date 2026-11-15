// node tests/scales.test.mjs: keys and scales (the pads that hold only a scale's notes, one-finger chords).
import { SCALES, keyOf, inScale, degreeNote, rootFrom, padGrid, chords, noteLabel } from "../app/js/scales.js";

let failures = 0;
const check = (ok, what) => { if (!ok) { failures++; console.log("  FAIL " + what); } else console.log("  ok   " + what); };
const scale = (id) => SCALES.find((s) => s.id === id);

console.log("keys");
{
  check(keyOf({}).name === "C major" && keyOf(null).root === 0, "a project without a key is in C major");
  check(keyOf({ key: 9, scale: "minor" }).name === "A minor", "A minor");
  check(keyOf({ key: 14, scale: "nope" }).root === 2 && keyOf({ key: 14, scale: "nope" }).scale.id === "major", "odd values fall back");
  const maj = scale("major").steps;
  check(inScale(60, 0, maj) && !inScale(61, 0, maj) && inScale(61, 1, maj) && inScale(-1, 0, maj), "in the scale or not, in any octave");
  check(degreeNote(48, maj, 0) === 48 && degreeNote(48, maj, 7) === 60 && degreeNote(48, maj, 9) === 64 && degreeNote(48, maj, -1) === 47, "scale steps run into the next octaves, and below");
  check(rootFrom(36, 0) === 36 && rootFrom(36, 9) === 45 && rootFrom(37, 0) === 48, "the lowest root from a note up");
  check(noteLabel(60) === "C3" && noteLabel(36) === "C1" && noteLabel(70) === "B♭3", "note names, C3 = 60 as the piano roll's");
}

console.log("pads in a key");
{
  const g = padGrid({ root: 0, steps: scale("major").steps, low: 36, cols: 8, rows: 4 });
  check(g.length === 4 && g.every((r) => r.length === 8), "4 rows of 8");
  check(g[0].map((p) => p.note).join() === "36,38,40,41,43,45,47,48", "the bottom row: C major from C1");
  check(g[1][0].note === 41 && g[2][0].note === 47 && g[3][0].note === 52, "each row starts a fourth (three steps) above the last");
  check(g.flat().every((p) => inScale(p.note, 0, scale("major").steps)), "only notes of the scale");
  check(g[0][0].root && g[0][7].root && !g[0][1].root && g[1][4].root, "the roots are marked (C1, C2 on the bottom row, C2 on the next)");
  const am = padGrid({ root: 9, steps: scale("minor").steps, low: 36 });
  check(am[0][0].note === 45 && am[0].map((p) => p.note % 12).join() === "9,11,0,2,4,5,7,9", "A minor starts on the A above the low note");
  const ch = padGrid({ root: 0, steps: scale("chromatic").steps, low: 36 });
  check(ch[0][1].note === 37 && ch[1][0].note === 41, "chromatic: semitones along a row, rows a fourth apart");
  const pent = padGrid({ root: 0, steps: scale("pentaminor").steps, low: 48, cols: 5, rows: 2 });
  check(pent[0].map((p) => p.note).join() === "48,51,53,55,58" && pent[1][0].note === 55, "a five-note scale");
  // a triad's shape is the same wherever it starts: a pad, the one two to its right, and the one a row up and one right
  const shape = (r, c) => [g[r][c].note, g[r][c + 2].note, g[r + 1][c + 1].note].map((n, _, a) => n - a[0]).join();
  check(shape(0, 0) === "0,4,7" && shape(0, 1) === "0,3,7" && shape(1, 0) === "0,4,7", "one hand shape plays the key's triads (C: " + shape(0, 0) + ", Dm: " + shape(0, 1) + ")");
}

console.log("chords");
{
  const cmaj = chords(0, scale("major"));
  check(cmaj.map((c) => c.name).join(" ") === "C Dm Em F G Am B°", "C major's triads: " + cmaj.map((c) => c.name).join(" "));
  check(cmaj[0].notes.join() === "48,52,55" && cmaj[4].notes.join() === "55,59,62", "their notes from C3");
  const amin = chords(9, scale("minor"));
  check(amin.map((c) => c.name).join(" ") === "Am B° C Dm Em F G", "A minor's: " + amin.map((c) => c.name).join(" "));
  const sev = chords(0, scale("major"), { seventh: true });
  check(sev.map((c) => c.name).join(" ") === "Cmaj7 Dm7 Em7 Fmaj7 G7 Am7 Bm7♭5", "sevenths: " + sev.map((c) => c.name).join(" "));
  check(sev[4].notes.join() === "55,59,62,65", "G7's notes");
  check(chords(0, scale("harmonic")).map((c) => c.name).join(" ") === "Cm D° E♭+ Fm G A♭ B°", "harmonic minor: " + chords(0, scale("harmonic")).map((c) => c.name).join(" "));
  check(chords(9, scale("pentaminor")).map((c) => c.name).join(" ") === amin.map((c) => c.name).join(" "), "a pentatonic scale takes the chords of its seven-note scale");
  const all = SCALES.flatMap((s) => [...chords(3, s), ...chords(3, s, { seventh: true })]);
  check(all.every((c) => !c.name.includes("?")), "every chord of every scale has a name");
  check(chords(11, scale("major"), { base: 48 })[0].notes[0] === 59, "B's chords start on the B in the octave");
}

console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
