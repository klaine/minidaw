// node tests/launchpad.test.mjs: the Launchpad Pro Mk3 as the session's grid. A stand-in for the device (two ports
// that note what's sent and deliver what the device would send) against a stand-in for the app.
import { Launchpad, HEADER, BTN, isLaunchpadPro3, isDawPort, padId, padPos, rgb7, lights, ledMessages, changed } from "../app/js/launchpad.js";

let failures = 0;
const check = (ok, what) => { if (!ok) { failures++; console.log("  FAIL " + what); } else console.log("  ok   " + what); };
globalThis.performance ??= { now: () => Date.now() };

console.log("ports and pads");
{
  check(isLaunchpadPro3("Launchpad Pro MK3 LPProMK3 MIDI") && isLaunchpadPro3("MIDIIN3 (LPProMK3 MIDI)") && !isLaunchpadPro3("Launchkey Mini MK3 MIDI"), "a Launchpad Pro Mk3's ports by name");
  check(isDawPort("Launchpad Pro MK3 LPProMK3 DAW") && isDawPort("MIDIIN3 (LPProMK3 MIDI)") && isDawPort("MIDIOUT3 (LPProMK3 MIDI)") && isDawPort("Launchpad Pro MK3 MIDI 3"), "its DAW port (macOS, Windows, Linux names)");
  check(!isDawPort("Launchpad Pro MK3 LPProMK3 MIDI") && !isDawPort("Launchpad Pro MK3 LPProMK3 DIN") && !isDawPort("MIDIIN2 (LPProMK3 MIDI)") && !isDawPort("LPProMK3 MIDI"), "not its MIDI or DIN port");
  check(padId(0, 7) === 11 && padId(7, 0) === 88 && padId(0, 0) === 81 && padId(3, 4) === 44, "pads are row * 10 + column from the bottom left");
  const all = [];
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) { const p = padPos(padId(c, r)); all.push(p && p.col === c && p.row === r); }
  check(all.every(Boolean) && padPos(90) === null && padPos(19) === null && padPos(10) === null, "and back; buttons are not pads");
  check(rgb7("#ffffff").join() === "127,127,127" && rgb7("#000000").join() === "0,0,0" && rgb7("#ff0000", 0.5)[0] < 70, "colours as 7-bit RGB, dimmable");
  check(rgb7("nonsense").length === 3, "an odd colour is still a colour");
}

console.log("lights");
{
  const track = (o = {}) => ({ color: "#3cc7e6", arm: false, mute: false, solo: false, selected: false, playing: false, slots: Array(10).fill(null), ...o });
  const v = { tracks: [track({ slots: ["clip", "playing", "queued", "stopping", "recording", "countin", null, null, "clip", null], selected: true }), track({ arm: true })], scenes: 10, x: 0, y: 0, playing: true, recording: false, mode: "select" };
  const m = lights(v);
  const at = (c, r) => m.get(padId(c, r));
  check(at(0, 0)[0] === 3 && at(0, 0).length === 5, "a clip: its track's colour (RGB)");
  check(at(0, 1).join() === [2, padId(0, 1), 21].join(), "playing: pulsing green");
  check(at(0, 2)[0] === 1 && at(0, 3)[0] === 1 && at(0, 2)[3] === 21, "queued and stopping: flashing");
  check(at(0, 4).join() === [2, padId(0, 4), 5].join() && at(0, 5)[0] === 1, "recording: pulsing red; counting in: flashing red");
  check(at(0, 6).join() === [0, padId(0, 6), 0].join(), "an empty slot: off");
  check(at(1, 0)[0] === 3 && at(1, 0)[2] > 0 && at(1, 0)[3] === 0, "an armed track's empty slots glow red");
  check(at(5, 5).join() === [0, padId(5, 5), 0].join(), "no track there: off");
  check(m.get(BTN.tracks[0]).slice(2).join() === "127,127,127" && m.get(BTN.tracks[2])[0] === 0, "the selected track's button is white, a missing track's off");
  check(m.get(BTN.scenes[0])[0] === 3 && m.get(BTN.scenes[6])[0] === 0, "scene buttons lit where the scene has clips");
  check(m.get(BTN.down)[0] === 3 && m.get(BTN.up)[0] === 0 && m.get(BTN.right)[0] === 0, "arrows lit where there is more (10 scenes: down)");
  check(m.get(BTN.play).slice(2).join() === "0,127,0", "Play is green while playing");
  check(m.size === 64 + 8 + 8 + 4 + 2 + 4 + 8, "every pad and button the app uses has a state (" + m.size + ")");
  const scrolled = lights({ ...v, y: 2 });
  check(scrolled.get(padId(0, 0))[0] === 1 && scrolled.get(BTN.up)[0] === 3 && scrolled.get(padId(0, 6))[0] === 3, "scrolled down two scenes");
  const arm = lights({ ...v, mode: "arm" });
  check(arm.get(BTN.tracks[1]).slice(2).join() === "127,0,0" && arm.get(BTN.tracks[0])[2] < 30 && arm.get(BTN.arm).slice(2).join() === "127,0,0", "Record Arm: the track buttons show who is armed");
  const msgs = ledMessages([...m.values()]);
  check(msgs.length === 2 && msgs.every((x) => x.slice(0, 7).join() === [...HEADER, 3].join() && x[x.length - 1] === 0xf7 && x.slice(1, -1).every((b) => b < 128)), "as SysEx: the header, 03, 7-bit data, F7; 60 LEDs a message");
  check(changed(m, m).length === 0 && changed(scrolled, m).length > 0 && changed(m, new Map()).length === m.size, "only what changed is sent");
}

// ---- the controller against a stand-in app
function makeApp() {
  const calls = [];
  const tracks = [0, 1, 2].map((i) => ({ id: "t" + i, color: "#ff6b5b", mixer: { arm: false, mute: false, solo: false }, slots: [i < 2 ? "c" + i : null, null, null, null, null, null, null, null, null, null] }));
  const project = { tracks, scenes: Array.from({ length: 10 }, (_, i) => ({ name: "S" + i })) };
  const session = new Map();
  const app = {
    calls, ctx: { state: "running" },
    store: { project, ui: { selTrack: "t0" }, select(patch) { Object.assign(this.ui, patch); calls.push(["select", patch.selTrack]); }, update(fn, reason) { fn(project); calls.push(["update", reason]); } },
    transport: {
      playing: false, session,
      toggleClip(id, scene) { calls.push(["toggleClip", id, scene]); session.set(id, { playing: { scene }, queued: null }); this.playing = true; },
      stopTrack(id) { calls.push(["stopTrack", id]); }, launchScene(s) { calls.push(["launchScene", s]); }, stopAllClips() { calls.push(["stopAllClips"]); },
    },
    recording: { active: false, slot: null, slotState(id, s) { return this.slot && this.slot[0] === id && this.slot[1] === s ? "rec" : null; }, recordSlot(id, s) { calls.push(["recordSlot", id, s]); this.slot = [id, s]; this.active = true; }, stop() { calls.push(["recStop"]); this.slot = null; this.active = false; }, toggle() { calls.push(["recToggle"]); }, capture() { calls.push(["capture"]); } },
    togglePlay() { calls.push(["togglePlay"]); },
  };
  return app;
}
const port = () => ({ sent: [], send(b) { this.sent.push([...b]); }, onmidimessage: null });
const leds = (out) => { const m = new Map(); for (const msg of out.sent) if (msg[6] === 3) { let i = 7; while (i < msg.length - 1) { const n = { 0: 3, 1: 4, 2: 3, 3: 5 }[msg[i]]; m.set(msg[i + 1], msg.slice(i, i + n)); i += n; } } return m; };

console.log("the Launchpad and the session");
{
  const app = makeApp(), lp = new Launchpad(app), inp = port(), out = port();
  lp.attach(inp, out);
  check(out.sent[0].join() === [...HEADER, 0x10, 1, 0xf7].join() && out.sent[1].join() === [...HEADER, 0, 0, 0, 0, 0xf7].join(), "attaching: DAW mode, then the Session layout");
  check(leds(out).get(padId(0, 0))[0] === 3 && leds(out).get(padId(2, 0))[0] === 0, "then the session's lights: clips in colour, empty slots off");
  const press = (bytes) => inp.onmidimessage({ data: Uint8Array.from(bytes) });
  press([0x90, padId(1, 0), 100]);
  check(app.calls.some((c) => c.join() === "toggleClip,t1,0"), "a pad plays its clip");
  check(leds(out).get(padId(1, 0)).join() === [2, padId(1, 0), 21].join(), "and pulses green right away");
  press([0x90, padId(1, 0), 0]);
  check(app.calls.filter((c) => c[0] === "toggleClip").length === 1, "letting go does nothing more");
  press([0x90, padId(2, 3), 90]);
  check(app.calls.some((c) => c.join() === "stopTrack,t2"), "an empty pad stops its track");
  press([0xb0, BTN.arm, 127]); press([0xb0, BTN.arm, 0]);
  press([0xb0, BTN.tracks[2], 127]);
  check(app.store.project.tracks[2].mixer.arm === true && app.calls.some((c) => c.join() === "update,mixer"), "Record Arm, then a track button: armed (an undo step, as the M S ● buttons)");
  press([0x90, padId(2, 3), 90]);
  check(app.calls.some((c) => c.join() === "recordSlot,t2,3"), "an armed track's empty pad records there");
  check(leds(out).get(padId(2, 3)).join() === [2, padId(2, 3), 5].join(), "pulsing red");
  press([0x90, padId(2, 3), 90]);
  check(app.calls.some((c) => c[0] === "recStop"), "pressed again: the take is done");
  press([0xb0, BTN.arm, 127]);
  press([0xb0, BTN.tracks[1], 127]);
  check(app.store.ui.selTrack === "t1", "back in select mode a track button selects the track");
  press([0xb0, BTN.scenes[1], 127]);
  check(app.calls.some((c) => c.join() === "launchScene,1"), "the right column launches scenes");
  press([0xb0, BTN.play, 127]); press([0xb0, BTN.record, 127]);
  check(app.calls.some((c) => c[0] === "togglePlay") && app.calls.some((c) => c[0] === "recToggle"), "Play and Record");
  press([0xb0, BTN.shift, 127]); press([0xb0, BTN.record, 127]); press([0xb0, BTN.shift, 0]);
  check(app.calls.some((c) => c[0] === "capture") && app.calls.filter((c) => c[0] === "recToggle").length === 1, "Shift + Record: Capture");
  press([0xb0, BTN.down, 127]);
  check(lp.y === 1 && leds(out).get(BTN.up)[0] === 3, "Down scrolls a scene; Up lights");
  press([0xb0, BTN.scenes[0], 127]);
  check(app.calls.some((c) => c.join() === "launchScene,1") && app.calls.filter((c) => c[0] === "launchScene").length === 2, "the top scene button is now scene 2");
  press([0xb0, BTN.down, 127]); press([0xb0, BTN.down, 127]); press([0xb0, BTN.down, 127]);
  check(lp.y === 2, "scrolling stops at the last page (10 scenes)");
  // Note mode on the Launchpad: nothing is lit over it; back on Session everything is lit again
  const before = out.sent.length;
  press([...HEADER, 0x00, 0x04, 0x00, 0x00, 0xf7]);
  press([0x90, padId(0, 0), 100]);
  check(app.calls.filter((c) => c[0] === "toggleClip").length === 1 && out.sent.length === before, "in the Launchpad's Note layout the pads aren't the session's");
  press([...HEADER, 0x00, 0x00, 0x00, 0x00, 0xf7]);
  check(out.sent.length > before && leds({ sent: out.sent.slice(before) }).size > 80, "back on Session: every light sent again");
  lp.detach();
  check(out.sent[out.sent.length - 1].join() === [...HEADER, 0x10, 0, 0xf7].join() && inp.onmidimessage === null, "detaching: out of DAW mode, the Launchpad is its own again");
}

console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
