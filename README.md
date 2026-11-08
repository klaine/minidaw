# minidaw

A small DAW that runs in the browser and installs on an iPad as an app. It has four synthesizers built in:
[Crest](https://github.com/klaine/crest), [Amino](https://github.com/klaine/amino),
[Bizar](https://github.com/klaine/bizar) and PRO-8000 V (the WebAssembly build of
[pro-8000-vst](https://github.com/klaine/pro-8000-vst)). It also has a Drum Rack and audio tracks. You can sequence
clips in a Session grid or on an Arrangement timeline, edit notes and automation in a piano roll, mix, record and
export.

Every instrument is its own engine, compiled from its repository to WebAssembly. Each one opens its own full editor,
bridged to the track it plays on.

## What it does

- **Tracks.** MIDI tracks host one instrument each: Crest, Amino, Bizar, PRO-8000 V or the Drum Rack. Audio tracks
  hold samples, loops and recordings. Each MIDI track runs its own instance of its instrument.
- **Session view.** Clips sit in slots, a column per track and a row per scene, as in Ableton Live. Clips launch on
  the next bar, and launch quantization is in the menu. You can launch a whole scene, stop a track, or tap
  **Arrangement** to return the tracks to the timeline.
- **Arrangement view.** Clips sit on a timeline with a loop brace. Drag a clip to move it, its right edge to loop or
  resize it, and its left edge to trim it. Long press for duplicate, split, copy and paste, or make unique.
- **Piano roll.** Draw and Select tools, grid and triplets, quantize, transpose, and ×2 to double a clip. Drum Rack
  clips show one row per pad.
- **Automation.** Arrangement lanes per track cover volume, pan, both sends and any instrument parameter. Clip
  envelopes, drawn in the piano roll, play with the clip and take precedence over the track's lane.
- **Drum Rack.** 16 pads on notes C1 to D#2. Each pad has a sample, level, pan, pitch, start, decay, reverse and
  choke groups. The built-in kit is synthesized in the app, so no third-party samples ship.
- **Audio tracks.** Built-in drum loops or your own files (WAV, AIFF, MP3, M4A and more). Warp resamples a clip to the
  song's tempo, so its pitch follows the tempo.
- **MIDI files.** Drop a `.mid` file on an instrument track's lane, a session slot or a track header, or use Import
  MIDI in the device panel or a long press on an empty place.
  - A file with several parts asks which part to use, or merges them all into one clip.
  - On a Drum Rack, General MIDI drums (channel 10) map onto the kit's pads.
  - Dropped anywhere else, or from Add track → Tracks from a MIDI file, the file becomes new tracks, one per part.
    You choose each track's instrument, and can take the file's tempo.
  - Any MIDI clip can be saved as a `.mid` file from its long-press menu.
  - Audio files dropped on an audio track become clips there, or start a new audio track.
- **Mixer.** Each strip has a 3-band EQ, a compressor, sends to a reverb and a delay return, pan, fader, mute, solo
  and arm. The master has a limiter.
- **Recording.**
  - **Count-in.** From a stop, Record counts in first: off, 1 or 2 bars, with a big countdown you can cancel. A note
    played just before the downbeat lands on it. The click can play only while recording.
  - **Takes.** Notes appear in the clip while you play, and a held note grows. Quantize snaps a take's notes when it
    ends, and a whole take is one undo step.
  - **Arrangement.** Replace, the default, makes a new clip that grows bar by bar and replaces what it covers. With
    the loop on, every pass adds to the same clip. Overdub plays into the clips already there.
  - **Session.** Tap an armed track's empty slot to record a loop from the next bar. Tap it again to stop it, or set
    a fixed length of 1, 2, 4 or 8 bars and it stops by itself and plays on seamlessly. Armed tracks with a playing
    clip overdub into it.
  - **Capture.** It turns what you just played into a clip, even when nothing was recording: in time if the
    transport ran, at the song's tempo if not.
  - **Audio.** Arming an audio track opens the microphone or audio input and shows its level, and Monitor plays it
    through the track. The take starts exactly at the record point, with the input's latency taken off.
  - Export → Record the output captures what you hear as a WAV.
  - Long press Record for these settings. They are kept on the device, not in the project.
- **Export.** The arrangement or the loop is rendered offline, with the same instruments, effects and automation, to
  a 16-bit, 24-bit or 32-bit float WAV. Stems export as a zip of WAVs.
- **Projects.** They are saved in the browser's storage, including every instrument's sound. A project can be saved
  as a `.minidaw.json` file with its samples, to move it to another device.
- **Offline.** It is a PWA: once loaded it works without a network, and on iPad you add it with
  Share → Add to Home Screen.

## On the iPad

Everything is touch first.

- **Basic gestures.** Tap selects, double tap creates or opens, and long press opens a menu (right click with a
  mouse).
- **Moving around.** One finger on empty space pans the timeline. Two fingers pan, and a pinch zooms.
- **Controls.** Knobs and faders turn with a vertical drag, and a double tap resets them.
- **Keys tab.** It plays the armed track, or the selected one, from a multi-touch keyboard where velocity comes from
  how low you touch the key. A Drum Rack track gets 16 pads instead.

Safari on iPad has no Web MIDI, so a MIDI keyboard works in Chrome, Edge or Firefox on a computer. Hardware
keyboards on a computer also play notes: A W S E D F T G Y H U J K, with Z and X for the octave.

## Run it

The built instruments are committed in `app/instruments/`, so the app runs as is:

```sh
npm run serve                  # python3 -m http.server -d app 8765, then open http://localhost:8765
```

Audio worklets need `https://` or `localhost`. GitHub Pages serves `app/` through `.github/workflows/pages.yml`. To
turn it on, set Settings → Pages → Source to GitHub Actions.

## The instruments

They are git submodules in `vendor/`, built with their own web build scripts, unchanged:

```sh
git submodule update --init --recursive
scripts/build_instruments.sh            # all four, or name some: crest amino bizar pro8000v
```

This needs zig (`pip install ziglang`), python3 and node. PRO-8000 V also needs a C/C++ compiler and the ALSA
headers for its preset-bank tool, plus npx for binaryen's `wasm-opt`. The script writes three things for each
instrument into `app/instruments/<id>/`:

- **The engine.** The instrument's own wasm host is used as is: `web/wasm_host.c`, `web/glue.c` or
  `web/wasm_host.cpp`.
- **Its editor.** This is the instrument's own page:
  - Crest's, Amino's and Bizar's Remote UI. Their `schwungRemote` is answered by
    `app/instruments/shared/schwung-remote.js`.
  - PRO-8000 V's firmware editor. Its `p8_send` and `p8_call` are answered by `app/instruments/shared/p8-daw.js`
    in place of its `web/p8-web.js`.
- **`meta.json`.** Presets, automatable parameters and quick knobs, read from the built engine by
  `scripts/gen_meta.mjs`.

Then it refreshes the service worker's file list and version with `scripts/gen_precache.mjs`. Run that yourself after
changing anything in `app/`.

## How it works

- **Engines.**
  - `app/js/worklets/daw-worklet.js` hosts Crest, Amino and Bizar.
  - `app/js/worklets/p8-worklet.js` hosts PRO-8000 V through its own `p8-core.js`.
  - Events carry an AudioContext time. The Schwung synths render each 128-frame block in pieces between events, so
    sequenced notes start on their exact sample.
- **Transport.** `app/js/audio/transport.js` schedules a short window ahead of the audio clock: notes, clip audio,
  automation, the metronome, and MIDI clock for PRO-8000 V.
  - The song beat drives the arrangement and wraps at the loop.
  - A global beat drives session clips and launch quantization, and never wraps.
  - The same code renders a whole song offline for export.
- **Mixer graph.** `app/js/audio/engine.js` builds the same graph in a live or offline context.
- **UI.** It is plain ES modules with no build step, in `app/js/ui/`. Timelines are drawn on canvas, and controls are
  DOM.

## Tests

```sh
npm test               # the four engines in a stand-in AudioWorkletGlobalScope (start, timing, stop), the transport, MIDI files
npm run test:browser   # a Chromium smoke test (Playwright): start, play the demo, the views; screenshots in test-results/
```

## Limits

- Warp resamples, so a warped clip's pitch follows the tempo. There is no time stretching.
- Each synth track is its own WebAssembly instance, and each takes 32 to 64 MB of memory. An iPad handles several
  synth tracks, but not dozens.
- PRO-8000 V follows the song's tempo only when its clock source is set to MIDI in its editor's System tab. Crest,
  Amino and Bizar follow the tempo by themselves.
- Recorded audio is aligned using the latency the browser reports, which is close but not always exact.

The instruments keep their own licenses. See `LICENSE` in each `app/instruments/<id>/` and in their repositories.
