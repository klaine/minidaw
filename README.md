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
- **Session view.** Clips sit in slots, a column per track and a row per scene, as in Ableton Live.
  - **Playing clips.** Tap a clip to play it and tap it again to stop it. ✎ opens it in the editor, and long press
    gives more.
  - **Starting from the session.** Started from a stop, only the clips you launch play, with the arrangement silent
    underneath. Tap **Arrangement** in the top bar to hear the arrangement again.
  - **Scenes and stops.** Clips start on the next bar (launch quantization is in the menu). ▶ on the right plays a
    whole row (a scene), and ■ stops a track.
- **Arrangement view.** Clips sit on a timeline with a loop brace. Drag a clip to move it, its right edge to loop or
  resize it, and its left edge to trim it. Long press for duplicate, split, copy and paste, or make unique.
- **Piano roll.** Draw and Select tools, grid and triplets, quantize, transpose, and ×2 to double a clip. Drum Rack
  clips show one row per pad.
- **Automation.** Arrangement lanes per track cover volume, pan, both sends and any instrument parameter. Clip
  envelopes, drawn in the piano roll, play with the clip and take precedence over the track's lane.
- **Drum Rack.** It has 16 pads on notes C1 to D#2.
  - **Selecting a pad.** Tap a pad to play it and edit it below: its sample, a waveform with start and end markers
    to trim it, and its level, pan, pitch, start, end and decay. Reverse and choke groups are there too.
  - **More options.** Long press a pad to choose, import, rename, copy, paste or reset it. Drop an audio file on a
    pad to load it there.
  - **Step sequencer.** A Drum Rack clip opens as a grid with a row per pad and 16 steps per bar. Tap a step to set
    or clear it, and drag along a row to paint or erase a run. Long press a step for its velocity or a ratchet (2, 3
    or 4 hits in the step). Accent mode sets loud steps, and Swing delays the off-beat 16ths. Pages go bar by bar and
    follow the playhead. The step length can be 1/8, 1/16, 1/32 or 1/16T, and the piano roll is one tap away.
  - **Kit builder.** The kit builder (Drum Rack → Kit builder…, or Add track → Drum Rack from a sample folder…) shows
    the sample library beside the pads.
    - **Placing samples.** Tap a sample to hear and pick it, then tap a pad. With a mouse you can also drag it onto a
      pad.
    - **Auto kit.** **Auto kit** makes a whole kit from the open folder (subfolders included) or from the whole
      library. Each pad gets a sample of its role: kick, snare, closed and open hat, clap, toms by height, rim,
      cowbell, crash, ride, shaker, clave, 808 and perc. The names and folder names decide it first ("Kicks/BD 01",
      "OHH"). A sample whose name says nothing ("Sample 041") is listened to once: its low end, brightness, noise,
      pitch, length and attack sort it. These are plain rules, not a trained model, so a pack of odd sounds can
      land on unexpected pads. Each pad's sample is picked at random among the ones that fit, so pressing Auto kit
      again makes another kit (one undo each). The silence before each sample is trimmed, and the levels are evened
      out: every pad peaks at -1 dB, cymbals and shakers 4 dB lower.
    - **Other ways to build.** **Build from this folder** is the same without the dice and the tidying: the first
      sample of each role. **Fill in order** places samples on pads 1 to 16 as they come. **Tidy pads** trims and
      levels the kit you already have.
    - **Saving.** Kits can be saved and loaded on any Drum Rack.
    - **Export for Ableton.** Export ▾ in the kit builder, or the top bar's Export menu, saves the kit:
      - **Ableton Move** (and Note): a `.ablpresetbundle`, Move's own preset format. It has the shape Move's kits have:
        an Instrument Rack with a Drum Rack of 16 Drum Samplers on notes 36 to 51, a return chain with a reverb (sends
        off), and a saturator after the rack (dry). Drop it on Move Manager's Presets tab and press Upload.
      - **Ableton Live**: a zip of a folder with a Drum Rack preset (`.adg`, Simplers in one-shot mode, Live 11
        format, which Live 12 opens) and its Samples folder. Keep them together and drag the `.adg` into Live.
      - **What carries over.** Each pad's WAV (24-bit) is what the pad plays here: trimmed, reversed if it is, with
        its decay shaped in. Level, pan, pitch (in semitones), choke groups and mute go into the preset. A pad at the
        default level sits at Move's -12 dB.
      - **Untested on the hardware.** The Move bundle follows Move's preset files as the extending-move project
        documents them, and the Live rack is built from a Live 11 Drum Rack preset. Neither has been loaded on a Move
        or in Live from here.
  - **From a clip.** Tap a row's name and then Pad sounds to open that pad's editor.
  - The built-in kit is synthesized in the app, so no third-party samples ship.
- **Sample library.** All your samples, in their folders, browsable and searchable from every sample picker.
  - **Folders.** Import a folder with its subfolders. On an iPad, compress the folder in Files and import the zip.
  - **Other imports.** You can also import loose files. Pad imports and recordings land in Imported and Recordings.
  - **Dropping.** Dropping a folder or zip anywhere adds it to the library. On a Drum Rack it also builds the kit.
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
  - **Saving.** Edits are saved a few seconds after they're made, and at once when the app is left or reloaded.
    If a save fails (storage full, or the same project saved from another tab since), a "Not saved" notice says so
    and repeats while it lasts. An untouched tab never writes over newer work.
  - **Storage.** A sample removed from the library (a folder's ⋯ menu, or a sample's) is deleted from the
    browser's storage unless something still uses it: another library folder, a saved kit, a saved project, or
    the open project including what Undo could bring back. Deleting a project frees its samples the same way.
    Settings shows how much storage is used and has **Free up storage**, which deletes what nothing uses.
    Deleted clips leave the project when it is saved.
  - **Undo.** Up to 120 steps. A step keeps only the clips and tracks that changed, so a large song's undo
    history costs what was edited, not 120 copies of the song.
- **Updates.** A new version installs in the background and starts the next time the app is opened, never in the
  middle of a session.
- **Offline.** It is a PWA: once loaded it works without a network, and on iPad you add it with
  Share → Add to Home Screen.

## On the iPad

Everything is touch first. It is written for Safari 16.4 or later (iPadOS 16.4, 2023): zip import, the Ableton
Live export and the screen staying on need that version. It has not been run on a real iPad from this repository's
tests, which use Chromium at iPad sizes with touch events.

- **Basic gestures.** Tap selects, double tap creates or opens, and long press opens a menu (right click with a
  mouse).
- **Moving around.** One finger on empty space pans the timeline. Two fingers pan, and a pinch zooms.
- **Controls.** Knobs and faders turn with a vertical drag, and a double tap resets them.
- **Keys tab.** It plays the armed track, or the selected one, and stays open when you pick another track. Where you
  touch a key or pad sets how hard it plays (lower is louder), and sliding glides. A synth has three surfaces:
  - **Piano.** A multi-touch keyboard of one to three octaves, with the song's scale marked on the keys.
  - **Pads.** A grid that holds only the notes of the song's key, so there are no wrong notes. Rows are a fourth
    apart, so a chord has the same hand shape everywhere, and the key's root is coloured. The grid grows rows with
    the panel.
  - **Chords.** One pad plays one chord of the key: triads on the bottom row, sevenths above.
  - A Drum Rack track gets its 16 pads instead.
- **Key and scale.** They belong to the song (set them on the Keys tab: 11 scales). The piano roll shades its rows by
  the scale too.
- **Making and hearing a clip.** The Clip tab has a **New clip** button when no clip is selected (the arrangement's
  bar at the playhead, or the session's next empty slot). Every clip editor has **Loop clip**, which plays the clip
  round and round while you edit it.
- **Room to work.** **Bigger** on the bottom panel puts it over most of the screen, and **Smaller** brings it back.
  The bar above the panel can also be dragged.
- **The screen stays on** while the song plays or records. Audio that iPadOS interrupted (a call, Siri, leaving the
  app) starts again on the next touch.

## Keyboards and controllers

A hardware keyboard on a computer plays notes: A W S E D F T G Y H U J K, with Z and X for the octave.

**No browser on an iPad or iPhone can see MIDI devices.** They all run Safari's engine, which has no Web MIDI. So a
USB-C MIDI keyboard or a Launchpad plugged into an iPad does not reach minidaw, as a web app. On an iPad the touch
surfaces above are the instrument. MIDI devices work where the browser has Web MIDI: Chrome or Edge on a computer or
an Android device. The code uses only the standard interface, so it would work on an iPad unchanged if Safari gained
it, or inside a native wrapper that provides it.

- **Any MIDI keyboard or controller.** It plays the armed tracks, or the selected one. Notes, the sustain pedal,
  pitch bend and the other controllers go to the instrument, and notes are recorded while Record is on. Plugging in
  and unplugging is picked up and shown.
- **Novation Launchpad Pro Mk3.** minidaw puts it in its DAW mode, as Ableton Live does. The browser asks once for
  permission to control MIDI devices (SysEx).
  - **Session button:** the 8 × 8 pads are the session's clips, a column per track, lit in the tracks' colours. A pad
    plays or stops its clip (pulsing green while it plays); an empty pad stops its track; on an armed track an
    empty pad records there.
  - **Right column:** launches scenes. **Arrows:** scroll tracks and scenes (with Shift, a page).
  - **Play, Record:** the transport. **Shift + Record:** Capture.
  - **Row under the pads:** selects a track. With **Record Arm**, **Mute**, **Solo** or **Stop Clip** lit, it arms,
    mutes, solos or stops tracks instead. **Shift + Stop Clip** stops every clip.
  - **Note, Chord and the Launchpad's own sequencer** stay the Launchpad's: their notes play the armed or selected
    track like any keyboard.
  - **Not tried on the hardware.** The protocol follows Novation's programmer's reference as the Ardour project's
    driver implements it; here it is tested against a stand-in device only.

## Run it

The built instruments are committed in `app/instruments/`, so the app runs as is:

```sh
npm run serve                  # python3 -m http.server -d app 8765, then open http://localhost:8765
```

Audio worklets need `https://` or `localhost`. The site, https://klaine.github.io/minidaw/, is the `gh-pages` branch,
which GitHub Pages serves. `scripts/pages.sh --push` writes it from `app/`: one commit, replaced on each run. Run it
after a change is committed.

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
npm test               # the engines in a stand-in AudioWorkletGlobalScope, the transport (swing, session launches), MIDI files, undo (steps that share what didn't change), zips, kits, which stored samples are in use, drums by their sound, the Ableton exports, scales and chords, and the Launchpad's protocol
npm run test:browser   # a Chromium smoke test (Playwright): start, play the demo, the views; screenshots in test-results/
npm run test:e2e       # the user flows (below); CI runs both on every push (.github/workflows/test.yml)
```

`tests/e2e/run.cjs` is a set of user flows, run in Chromium at an iPad's size with touch. Each starts from a fresh
browser profile and fails on any page error. The flows cover:
- **Playing and editing:** the first start; a beat in the step sequencer; drum pads (choose, trim, tune, import,
  drop, copy, and a trimmed pad heard shorter); a synth's presets, knobs and keys; an instrument's own editor.
- **Session, mixing and recording:** playing chosen session clips; session scenes; solo, mute and faders; recording
  with a count-in; a session loop; Capture.
- **Playing by touch:** pads in the song's key, one-finger chords, key changes with undo, Keys staying open across
  tracks; a new song from the New clip button to a looping beat, and the bigger panel.
- **Fingers (real touch events):** a swipe scrolls the step sequencer's rows and sets nothing, a swipe along a row
  paints, a rolling fingertip still taps; the session redraws after its own edits and a deleted playing clip stops;
  a fader's double tap resets it; the top bar's tabs are whole on a 1024-wide iPad.
- **MIDI devices (stand-ins for the hardware):** a keyboard plays the selected track and its notes end where they
  began; a Launchpad Pro Mk3 is set up, lights the session, launches clips and scenes, arms a track and stops.
- **Steps and kits:** the step sequencer (accents, ratchets, painting, pages, swing); a kit built from a folder with
  subfolders; a kit from a zip, and from a zip dropped on a track; an automatic kit from samples without names
  (placed by their sound, trimmed and levelled, another on each press); the kit exported for Move and for Live, and
  the files unpacked and checked in node.
- **Files and project:** MIDI files; an audio loop; automation; a WAV export; a reload; undo and redo; portrait
  layout; starting offline.
- **Keeping work:** an edit made just before a reload is saved; a write the browser refuses (a full disk, simulated)
  is said, and "Saved" is not; a duplicated track's clips are its own.
- **Storage:** samples removed from the library are deleted only once no kit, project or Undo step uses them; a
  deleted clip leaves the saved project and Undo still brings it back.

They act only through the interface: taps, drags, long presses, keys, the file chooser, downloads and file drops.
They check what a person would notice: sound at the app's meters, the screen, what survives a reload, and exported
files decoded in node. Changing the app to drop a feature (trim, or tracks returning to the arrangement) makes the
matching flow fail.

## Limits

- Warp resamples, so a warped clip's pitch follows the tempo. There is no time stretching.
- Each synth track is its own WebAssembly instance, and each takes 32 to 64 MB of memory. An iPad handles several
  synth tracks, but not dozens.
- PRO-8000 V follows the song's tempo only when its clock source is set to MIDI in its editor's System tab. Crest,
  Amino and Bizar follow the tempo by themselves.
- Recorded audio is aligned using the latency the browser reports, which is close but not always exact.

The instruments keep their own licenses. See `LICENSE` in each `app/instruments/<id>/` and in their repositories.
