// Which drum a sample is, from its name and folders ("Kicks/BD_Punchy.wav", "hats/OHH 03.wav"), and a kit built from a
// set of samples: each of the Drum Rack's 16 pads gets the best match for its role (the default kit's order), the
// remaining pads the samples that are left.

/** The pads' roles, in the default kit's order (js/model.js BUILTIN_KIT) */
export const ROLES = ["kick", "snare", "hat", "openhat", "clap", "tomlo", "tommid", "tomhi", "rim", "cowbell", "crash", "ride", "shaker", "clave", "sub", "perc"];

// tested in this order: the more specific first (an open hat before a hat, a rimshot before a snare)
const RULES = [
  ["openhat", [/open ?h(i ?)?h?at/, /\bo ?hh?\b/, /\bohat\b/, /hat ?open/, /\bhh ?o(pen)?\b/, /\bopen\b/]],
  ["hat", [/closed ?h(i ?)?h?at/, /\bc ?hh?\b/, /\bchat\b/, /hat ?closed/, /hi ?-?hat/, /\bhh\b/, /\bhat/, /\bhats\b/]],
  ["rim", [/rim/, /side ?stick/, /\bstick\b/]],
  ["sub", [/\b808/, /\bsub\b/, /\bboom\b/]],
  ["kick", [/kick/, /\bkik\b/, /\bbd\b/, /bass ?drum/, /\bkck\b/]],
  ["clap", [/clap/, /\bclp\b/, /\bsnap\b/]],
  ["snare", [/snare/, /\bsnr\b/, /\bsd\b/, /\bsn\b/]],
  ["tom", [/\btoms?\b/, /\btom ?\d/, /tom/]],
  ["ride", [/\bride\b/]], // before the cowbell: a ride's bell is a ride
  ["cowbell", [/cow ?bell/, /\bcow\b/, /\bbell\b/]],
  ["crash", [/crash/, /\bcym/, /cymbal/, /\bsplash\b/, /\bchina\b/]],
  ["shaker", [/shak/, /\bshk\b/, /maraca/, /tamb/, /cabasa/]],
  ["clave", [/clave/, /block/]],
  ["perc", [/perc/, /\bfx\b/, /\bsfx\b/, /zap/, /conga/, /bongo/, /\bvox\b/, /\bmisc\b/, /timbale/, /\bguiro\b/, /\bagogo\b/]],
];

/** The role of a sample (its name, then its folders), or null */
export function classify(path) {
  const parts = String(path).toLowerCase().replace(/\.[a-z0-9]+$/, "").split("/").reverse(); // its own name first
  for (const part of parts) {
    const s = " " + part.replace(/[_\-.()[\]]+/g, " ").replace(/\s+/g, " ").trim() + " ";
    for (const [role, res] of RULES) {
      if (res.some((re) => re.test(s))) return role === "tom" ? tomRole(s) : role;
    }
  }
  return null;
}

function tomRole(s) {
  if (/\b(lo|low|floor|ft|1)\b|low/.test(s)) return "tomlo";
  if (/\b(hi|high|rack|3)\b|high/.test(s)) return "tomhi";
  if (/\b(mid|med|middle|2)\b/.test(s)) return "tommid";
  return "tom";
}

/**
 * samples: [{ id, name, path }] -> 16 pads: [{ id, name } | null], in ROLES order. Each pad takes the first sample of its
 * role (by path, so "Kick 01" before "Kick 02"); toms without a height fill the tom pads in turn; the pads left over get
 * the samples left over, unclassified ones first.
 */
export function buildKit(samples) {
  const sorted = [...samples].sort((a, b) => natural(a.path || a.name, b.path || b.name));
  const roles = new Map(sorted.map((s) => [s, classify(s.path || s.name)]));
  const used = new Set();
  const pads = ROLES.map(() => null);
  const take = (pred) => { const s = sorted.find((x) => !used.has(x) && pred(x)); if (s) used.add(s); return s || null; };
  ROLES.forEach((role, i) => { pads[i] = take((s) => roles.get(s) === role); });
  for (const i of [5, 6, 7]) if (!pads[i]) pads[i] = take((s) => /^tom/.test(roles.get(s) || ""));
  if (!pads[14]) pads[14] = take((s) => roles.get(s) === "kick"); // a second kick for the 808 pad
  if (!pads[3]) pads[3] = take((s) => roles.get(s) === "hat");    // a second hat for the open hat
  const rest = sorted.filter((s) => !used.has(s)).sort((a, b) => (roles.get(a) ? 1 : 0) - (roles.get(b) ? 1 : 0));
  for (let i = 0; i < 16 && rest.length; i++) if (!pads[i]) { pads[i] = rest.shift(); used.add(pads[i]); }
  return pads.map((s) => (s ? { id: s.id, name: s.name } : null));
}

/** "Kick 2" before "Kick 10" */
export function natural(a, b) { return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" }); }
