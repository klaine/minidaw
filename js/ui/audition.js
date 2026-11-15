// "Loop clip": the button in the clip editors that plays the clip being edited, round and round, and stops again.
// In the session it launches the clip (the other tracks' launched clips play on); in the arrangement it puts the loop
// over the clip's place and plays from there, so the other tracks are heard with it.
import { h } from "../util.js";

export function loopButton(app, trackId, getClip) {
  const el = h("button", { type: "button", class: "btn small primary loop-clip", onclick: () => app.auditionClip(trackId, getClip()) });
  let shown = null;
  el.sync = () => {
    const playing = app.transport.playing;
    if (playing === shown) return;
    shown = playing;
    el.textContent = playing ? "■ Stop" : "▶ Loop clip";
    el.title = playing ? "Stop" : "Play this clip round and round while you edit it";
    el.classList.toggle("primary", !playing);
  };
  el.sync();
  return el;
}
