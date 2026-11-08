// The bottom panel: the selected track's Device (instrument, Drum Rack or audio track, and its channel), the selected
// Clip (piano roll or audio clip editor) and Keys (a keyboard, or pads for a Drum Rack, to play and record).
import { h } from "../util.js";
import { segmented } from "./controls.js";
import { DeviceView } from "./device.js";
import { PianoRoll } from "./pianoroll.js";
import { AudioClipEditor } from "./audioclip.js";
import { KeysView } from "./keyboard.js";

export class Panel {
  constructor(app) {
    this.app = app;
    this.tabs = segmented([{ value: "device", label: "Device" }, { value: "clip", label: "Clip" }, { value: "keys", label: "Keys" }], app.store.ui.panel, (v) => app.store.select({ panel: v }), "panel-tabs");
    this.title = h("div", { class: "panel-title" });
    this.body = h("div", { class: "panel-body" });
    this.el = h("section", { class: "panel" }, h("div", { class: "panel-head" }, this.tabs, this.title), this.body);
    this.child = null;
    this.key = "";
  }

  update(c = {}) {
    const app = this.app, store = app.store, ui = store.ui;
    const t = store.selectedTrack;
    let clip = store.selectedClip;
    // another track selected: its clips, not the last one's
    if (clip && t && !t.slots.includes(clip.id) && !t.arrangement.some((x) => x.clipId === clip.id)) { ui.selClip = null; clip = null; }
    this.tabs.set(ui.panel);
    const kind = t && t.type === "midi" ? t.instrument.kind : t ? "audio" : "none";
    const key = [ui.panel, t ? t.id : "", ui.panel === "clip" && clip ? clip.id + ":" + clip.type : "", kind].join("|");
    this.title.textContent = t ? t.name + (ui.panel === "clip" && clip ? " · " + clip.name : "") : "";
    this.title.style.setProperty("--tc", t ? t.color : "#888");
    if (key === this.key && this.child) {
      if (this.child.update) this.child.update(c);
      return;
    }
    this.key = key;
    if (this.child && this.child.dispose) this.child.dispose();
    this.child = null;
    this.body.textContent = "";
    if (!t) { this.body.append(h("p", { class: "panel-empty" }, "Add a track with ＋ in the top bar.")); return; }
    if (ui.panel === "device") this.child = new DeviceView(app, t);
    else if (ui.panel === "clip") {
      if (!clip) this.body.append(h("p", { class: "panel-empty" }, "Select a clip to edit it: tap one in the arrangement or the session, or double tap an empty place to make one."));
      else if (clip.type === "midi") this.child = new PianoRoll(app, t, clip);
      else this.child = new AudioClipEditor(app, t, clip);
    } else this.child = new KeysView(app, t);
    if (this.child) this.body.append(this.child.el);
  }

  frame() { if (this.child && this.child.frame) this.child.frame(); }
  onKey(e) { return this.child && this.child.onKey ? this.child.onKey(e) : false; }
  keysLit(note, on) { if (this.child && this.child.lit) this.child.lit(note, on); }
}
