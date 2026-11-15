// External MIDI, where the browser has Web MIDI (Chrome, Edge and Firefox on a computer or Android; no browser on an
// iPad or iPhone has it: they all run Safari's engine, which doesn't). Every keyboard or controller plays the armed
// tracks, or the selected one: notes, the sustain pedal, pitch bend, the mod wheel and the other controllers go to the
// instrument, and notes are recorded when Record is on. Plugging in and unplugging is followed, and said in a toast.
// A Launchpad Pro Mk3 is also the session's grid (js/launchpad.js): that needs SysEx, which the browser asks about once.
import { toast } from "./ui/controls.js";
import { Launchpad, isLaunchpadPro3, isDawPort } from "./launchpad.js";

export class MidiInput {
  constructor(app) {
    this.app = app;
    this.inputs = [];
    this.known = new Set(); // the inputs' names at the last look: what came and went
    this.launchpad = new Launchpad(app);
    this.supported = typeof navigator !== "undefined" && !!navigator.requestMIDIAccess;
    if (!this.supported) return;
    navigator.requestMIDIAccess({ sysex: false }).then((access) => this.use(access)).catch(() => { this.denied = true; });
    window.addEventListener("pagehide", () => this.launchpad.detach()); // the Launchpad is its own again
  }

  use(access) {
    this.access = access;
    access.onstatechange = () => this.wire();
    this.wire();
  }

  wire() {
    const access = this.access;
    const inputs = [...access.inputs.values()].filter((i) => i.state !== "disconnected");
    const outputs = [...access.outputs.values()].filter((o) => o.state !== "disconnected");
    const dawIn = inputs.find((i) => isDawPort(i.name)), dawOut = outputs.find((o) => isDawPort(o.name));
    this.inputs = inputs.filter((i) => i !== dawIn);
    for (const input of this.inputs) {
      input.onmidimessage = (e) => {
        const m = e.data;
        if (!m || m[0] >= 0xf0) return; // clock, active sensing, SysEx
        this.app.liveMidi(m);
      };
    }
    // a Launchpad Pro Mk3: its grid needs SysEx, asked for once when it's first seen
    if (dawIn && dawOut) {
      if (access.sysexEnabled) this.launchpad.attach(dawIn, dawOut);
      else if (!this.askedSysex) {
        this.askedSysex = true;
        navigator.requestMIDIAccess({ sysex: true }).then((a) => this.use(a)).catch(() => toast("The Launchpad plays notes, but its session grid needs the browser's permission for MIDI device control (SysEx)", 6000));
      }
    } else this.launchpad.detach();
    // what came and went (a Launchpad's three ports are one thing)
    const names = new Set(inputs.filter((i) => !/^Midi Through/i.test(i.name || "")).map((i) => (isLaunchpadPro3(i.name) ? "Launchpad Pro Mk3" : i.name || "MIDI input")));
    for (const n of names) if (!this.known.has(n)) toast("MIDI: " + n + " connected" + (n === "Launchpad Pro Mk3" ? ": its Session mode is the session's clips" : ": it plays the armed or selected track"), 3500);
    for (const n of this.known) if (!names.has(n)) toast("MIDI: " + n + " disconnected");
    this.known = names;
  }

  get names() { return [...this.known]; }
  /** One line for the settings sheet */
  get status() {
    if (!this.supported) return "not in this browser. No browser on an iPad or iPhone has Web MIDI (they all use Safari's engine); Chrome or Edge on a computer or an Android device does";
    if (this.denied) return "not allowed: the browser's permission for MIDI devices was refused";
    const n = this.names;
    return n.length ? n.join(", ") + (this.launchpad.connected ? " (the Launchpad's Session mode shows the session)" : "") : "none connected (plug one in: it's picked up by itself)";
  }
}
