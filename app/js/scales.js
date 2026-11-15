// Keys and scales: the song's key (project.key: 0 = C ... 11 = B; project.scale: an id below) for the playing surfaces
// (pads that only hold the scale's notes, one-finger chords), the piano roll's shading, and a hardware grid's lights.
// Pure functions: they run in node's tests as in the page.

export const NOTE_LETTERS = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];

export const SCALES = [
  { id: "major", name: "Major", steps: [0, 2, 4, 5, 7, 9, 11] },
  { id: "minor", name: "Minor", steps: [0, 2, 3, 5, 7, 8, 10] },
  { id: "dorian", name: "Dorian", steps: [0, 2, 3, 5, 7, 9, 10] },
  { id: "mixolydian", name: "Mixolydian", steps: [0, 2, 4, 5, 7, 9, 10] },
  { id: "phrygian", name: "Phrygian", steps: [0, 1, 3, 5, 7, 8, 10] },
  { id: "lydian", name: "Lydian", steps: [0, 2, 4, 6, 7, 9, 11] },
  { id: "harmonic", name: "Harmonic minor", steps: [0, 2, 3, 5, 7, 8, 11] },
  { id: "pentamajor", name: "Major pentatonic", steps: [0, 2, 4, 7, 9], chordsFrom: "major" },
  { id: "pentaminor", name: "Minor pentatonic", steps: [0, 3, 5, 7, 10], chordsFrom: "minor" },
  { id: "blues", name: "Blues", steps: [0, 3, 5, 6, 7, 10], chordsFrom: "minor" },
  { id: "chromatic", name: "Chromatic", steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], chordsFrom: "major" },
];
const BY_ID = new Map(SCALES.map((s) => [s.id, s]));

/** A project's key: { root (0-11), scale (its entry), name ("C minor") }; C major when it has none */
export function keyOf(project) {
  const root = (((project && project.key) | 0) % 12 + 12) % 12;
  const scale = BY_ID.get(project && project.scale) || SCALES[0];
  return { root, scale, name: NOTE_LETTERS[root] + " " + scale.name.toLowerCase() };
}

export function inScale(note, root, steps) { return steps.includes((((note - root) % 12) + 12) % 12); }
export const isRoot = (note, root) => (((note - root) % 12) + 12) % 12 === 0;

/** The note `degree` steps up the scale from `base` (a root note); degrees run on into the next octaves, and below 0 */
export function degreeNote(base, steps, degree) {
  const n = steps.length, oct = Math.floor(degree / n);
  return base + 12 * oct + steps[degree - oct * n];
}

/** The lowest root at or above `low` */
export function rootFrom(low, root) { return low + ((((root - low) % 12) + 12) % 12); }

/**
 * A grid of pads holding only the scale's notes: rows[0] is the bottom row, each row starts three scale steps (a
 * fourth, in a seven-note scale) above the one below, so a chord's shape is the same everywhere. The chromatic scale's
 * rows are five semitones apart, as a guitar's strings. -> rows of { note, root }
 */
export function padGrid({ root, steps, low = 36, cols = 8, rows = 4 }) {
  const base = rootFrom(low, root), shift = steps.length === 12 ? 5 : 3;
  const out = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) { const note = degreeNote(base, steps, r * shift + c); row.push({ note, root: isRoot(note, root) }); }
    out.push(row);
  }
  return out;
}

const TRIADS = { "4,7": "", "3,7": "m", "3,6": "°", "4,8": "+", "2,7": "sus2", "5,7": "sus4" };
const SEVENTHS = { "4,7,11": "maj7", "3,7,10": "m7", "4,7,10": "7", "3,6,10": "m7♭5", "3,6,9": "°7", "3,7,11": "m(maj7)", "4,8,11": "+maj7", "4,8,10": "+7" };

/**
 * The chords of a key, one on each step of its scale: triads, or sevenths. Five- and six-note scales and the chromatic
 * one take the chords of the major or minor scale they come from. base: the octave's lowest note (48 = C3).
 * -> [{ name: "Cm", degree: 0, notes: [48, 51, 55] }]
 */
export function chords(root, scale, { seventh = false, base = 48 } = {}) {
  const from = scale.chordsFrom ? BY_ID.get(scale.chordsFrom) : scale;
  const steps = from.steps, r0 = rootFrom(base, root);
  return steps.map((_, d) => {
    const notes = (seventh ? [0, 2, 4, 6] : [0, 2, 4]).map((k) => degreeNote(r0, steps, d + k));
    const shape = notes.slice(1).map((n) => n - notes[0]).join(",");
    const quality = (seventh ? SEVENTHS : TRIADS)[shape];
    return { name: NOTE_LETTERS[notes[0] % 12] + (quality ?? (seventh ? "7?" : "?")), degree: d, notes };
  });
}

export const noteLabel = (n) => NOTE_LETTERS[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 2);
