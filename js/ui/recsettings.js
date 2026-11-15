// Recording settings (long press the Record button, or the menu): count-in, click, record quantize, arrangement
// replace or overdub, the session's clip length. They're this device's, not the project's.
import { h } from "../util.js";
import { sheet, segmented } from "./controls.js";

export function recordSettings(app) {
  const rec = app.recording;
  const row = (label, hint, options, key, cast = Number) => h("div", { class: "rs-row" },
    h("div", { class: "rs-label" }, h("div", {}, label), h("div", { class: "dim rs-hint" }, hint)),
    segmented(options.map(([v, l]) => ({ value: String(v), label: l })), String(rec.prefs[key]), (v) => { rec.setPref(key, cast(v)); app.topbar.update(); }));
  sheet("Recording", h("div", { class: "rs" },
    row("Count-in", "Bars of click before recording from a stop. A note just before the downbeat lands on it.",
      [[0, "Off"], [1, "1 bar"], [2, "2 bars"]], "countIn"),
    row("Click while recording", "The metronome plays while recording even when it's off.",
      [["true", "On"], ["false", "Off"]], "clickRec", (v) => v === "true"),
    row("Quantize", "The take's notes snap to the grid when it ends (or later: Quantize in the piano roll).",
      [[0, "Off"], [1, "1/4"], [0.5, "1/8"], [0.25, "1/16"], [0.125, "1/32"]], "quantize"),
    row("Arrangement", "Replace: a new clip that replaces what it covers (with the loop on, each pass adds to it). Overdub: into the clips already there.",
      [["false", "Replace"], ["true", "Overdub"]], "overdub", (v) => v === "true"),
    row("Session clip length", "Free: until you tap the slot again. Fixed: the clip stops recording after its length and plays on.",
      [[0, "Free"], [1, "1 bar"], [2, "2"], [4, "4"], [8, "8"]], "sessionBars"),
    h("p", { class: "dim rs-foot" },
      "Arm tracks with ● to record on them. In the session, tap an armed track's empty slot to record a loop there. Capture (next to Record) keeps what you just played, even when nothing was recording.")),
  { wide: true, actions: [{ label: "Done", primary: true }] });
}
