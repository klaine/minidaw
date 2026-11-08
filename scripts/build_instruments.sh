#!/bin/sh
# Build the four bundled instruments from their own repositories (git submodules in vendor/) and assemble them into
# app/instruments/, where the DAW loads them:
#
#   scripts/build_instruments.sh                 # all four
#   scripts/build_instruments.sh crest bizar     # only these (crest, amino, bizar, pro8000v)
#
# Each instrument is built with its own web build script, unchanged: the same DSP the Move module, the VST3 and the
# instrument's own browser page run. What lands in app/instruments/<id>/:
#   <id>.wasm         the engine (Crest: editor/assets/engine/crest.wasm, where its editor's import looks) (the instrument's own wasm host: web/wasm_host.c, web/glue.c or web/wasm_host.cpp)
#   editor/           the instrument's own editor page, its schwungRemote (or p8_send / p8_call) pointed at the DAW
#   meta.json         presets, automatable parameters and quick knobs, read from the engine (scripts/gen_meta.mjs)
#
# Needs: zig (pip install ziglang, or brew install zig, or ZIG=...), python3, node; for PRO-8000 V also a C/C++
# compiler (clang or gcc) and the ALSA headers (libasound2-dev on Linux) for the preset bank tool, and npx for
# binaryen's wasm-opt.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
OUT="$ROOT/app/instruments"
PY=${PYTHON:-python3}

find_zig() {
  if [ -n "${ZIG:-}" ]; then echo "$ZIG"; return; fi
  if command -v zig >/dev/null 2>&1; then command -v zig; return; fi
  "$PY" -c 'import ziglang, os; print(os.path.join(os.path.dirname(ziglang.__file__), "zig"))' 2>/dev/null || true
}
ZIG=$(find_zig)
if [ -z "$ZIG" ] || [ ! -x "$ZIG" ]; then
  echo "zig not found: pip install ziglang (or brew install zig, or set ZIG=...)" >&2
  exit 1
fi
export ZIG
ZIGDIR=$(mktemp -d)
trap 'rm -rf "$ZIGDIR"' EXIT
ln -s "$ZIG" "$ZIGDIR/zig"     # the instruments' scripts look for `zig` on PATH too
export PATH="$ZIGDIR:$PATH"

WHICH=${*:-crest amino bizar pro8000v}

need() { [ -e "$1" ] || { echo "missing $1: git submodule update --init --recursive" >&2; exit 1; }; }

# rewrite FILE OLD NEW: replace one exact string, failing when it isn't there (an upstream page changed)
rewrite() {
  "$PY" - "$1" "$2" "$3" <<'PYEOF'
import sys
path, old, new = sys.argv[1:4]
s = open(path, encoding="utf-8").read()
if old not in s:
    sys.exit(f"{path}: '{old}' not found; the instrument's page changed, update scripts/build_instruments.sh")
open(path, "w", encoding="utf-8").write(s.replace(old, new, 1))
PYEOF
}

SHIM='<script src="../../shared/schwung-remote.js"></script>'

build_crest() {
  need vendor/crest/scripts/build_web.sh
  echo "== Crest"
  (cd vendor/crest && sh scripts/build_web.sh --single --no-test)
  D="$OUT/crest"
  rm -rf "$D" && mkdir -p "$D/editor/assets/ui" "$D/editor/assets/engine"
  cp vendor/crest/src/web/*.js vendor/crest/src/web/*.css "$D/editor/assets/ui/"
  cp vendor/crest/build/web/ui_meta.json vendor/crest/build/web/ui_presets.json "$D/editor/assets/ui/"
  cp vendor/crest/web/peak_worker.js "$D/editor/assets/engine/"      # the editor's .syx import worker
  # the engine sits where the editor's .syx import looks for it, and the DAW loads it from there (meta.json "wasm")
  cp vendor/crest/build/web/crest.wasm "$D/editor/assets/engine/crest.wasm"   # built without any local Peak banks
  cp vendor/crest/src/web_ui.html "$D/editor/web_ui.html"
  rewrite "$D/editor/web_ui.html" '<script src="/static/schwung-remote-api.js"></script>' "$SHIM"
  cp vendor/crest/LICENSE "$D/LICENSE"
}

build_amino() {
  need vendor/amino/scripts/build_web.sh
  echo "== Amino"
  (cd vendor/amino && sh scripts/build_web.sh --no-test)
  D="$OUT/amino"
  rm -rf "$D" && mkdir -p "$D"
  cp vendor/amino/build/amino.wasm "$D/amino.wasm"
  cp -R vendor/amino/build/site/remote-ui/amino "$D/editor"
  rewrite "$D/editor/web_ui.html" '<script src="../../static/schwung-remote-api.js"></script>' "$SHIM"
  cp vendor/amino/LICENSE "$D/LICENSE"
}

build_bizar() {
  need vendor/bizar/scripts/build.sh
  echo "== Bizar"
  (cd vendor/bizar && sh scripts/build.sh)
  D="$OUT/bizar"
  rm -rf "$D" && mkdir -p "$D/editor"
  cp vendor/bizar/build/bizar.wasm "$D/bizar.wasm"
  cp vendor/bizar/dist/bizar/web_ui.html vendor/bizar/dist/bizar/wavetable-preview.js "$D/editor/"
  rewrite "$D/editor/web_ui.html" '<script src="/static/schwung-remote-api.js"></script>' "$SHIM"
  cp vendor/bizar/LICENSE "$D/LICENSE"
}

build_pro8000v() {
  P=vendor/pro-8000-vst
  need $P/firmware/src/main.c
  need $P/crest-fx/src/dsp/fx.c
  echo "== PRO-8000 V"
  # The preset bank: the firmware's presets installed into the firmware, as the plugin's build does (p8presets). Built
  # here without the VST3 SDK / WebView configure the plugin's CMake project needs: the tool only uses the engine.
  B="$P/build/minidaw"
  mkdir -p "$B" "$P/build/ui"
  CC=${CC:-$(command -v clang || command -v gcc)}
  CXX=${CXX:-$(command -v clang++ || command -v g++)}
  FW=$P/firmware
  VER=$(tr -d ' \n\r' < $FW/VERSION); MA=${VER%%.*}; R=${VER#*.}; MI=${R%%.*}; PA=${R#*.}
  RTMIDI="$B/rtmidi"
  [ -f "$RTMIDI/RtMidi.cpp" ] || git clone -q --depth 1 --branch 6.0.0 https://github.com/thestk/rtmidi.git "$RTMIDI"
  "$CC" -shared -fPIC -fvisibility=hidden -std=gnu11 -O2 -w -I$FW/src -I$P/fw -include $FW/tools/sim/sim_regs.h \
    -DFW_VERSION_MAJOR=$MA -DFW_VERSION_MINOR=$MI -DFW_VERSION_PATCH=$PA -Dmain=firmware_main \
    $FW/src/main.c $FW/src/synth.c $FW/src/lfo.c $FW/src/seq.c $FW/src/store.c $FW/src/fastmath.c $FW/src/display.c \
    $P/fw/hal.c -lm -o "$B/libpro8000fw.so"
  for f in fx params_gen; do
    "$CC" -c -O2 -fPIC -w -include $P/engine/crest_compat.h -I$P/engine -I$P/crest-fx/src/dsp $P/crest-fx/src/dsp/$f.c -o "$B/c_$f.o"
  done
  "$CXX" -std=c++17 -O2 -w -D__LINUX_ALSA__ -I$P/engine -I$P/fw -I$P/crest-fx/src/dsp -I"$RTMIDI" -I$P/tools \
    $P/engine/engine.cpp $P/engine/voice_board.cpp $P/engine/fx_unit.cpp $P/engine/library.cpp \
    $P/engine/firmware_host.cpp $P/engine/device_link.cpp "$RTMIDI/RtMidi.cpp" $P/tools/preset_bank.cpp "$B"/c_*.o \
    -lasound -lpthread -ldl -o "$B/p8presets"
  node $P/tools/plan-presets.js --bank --out $P/build/ui/presets-plan.txt $FW/presets/*.json
  "$B/p8presets" $P/build/ui/presets-plan.txt $P/build/ui/presets.p8bank
  (cd $P && bash scripts/build_web.sh --no-test)
  S=$P/build/web/site
  D="$OUT/pro8000v"
  rm -rf "$D" && mkdir -p "$D/editor"
  cp $S/p8v.wasm "$D/pro8000v.wasm"
  cp $S/p8-core.js $S/presets.p8bank $S/presets-meta.json "$D/"
  for f in index.html p8-shim.js p8-app.js p8-app.css p8-fx.js p8-keys.js p8-browser.js p8-web.css \
           presetbrowser.js presetdrawer.js presetbrowser.css sound-plan.js panel-map.json presets.json \
           presets.p8bank presets-meta.json; do
    cp "$S/$f" "$D/editor/"
  done
  rewrite "$D/editor/index.html" '<script src="p8-web.js"></script>' '<script src="../../shared/p8-daw.js"></script>'
  cp $P/LICENSE "$D/LICENSE"
}

for w in $WHICH; do
  case "$w" in
    crest) build_crest ;;
    amino) build_amino ;;
    bizar) build_bizar ;;
    pro8000v|pro-8000-v|p8) build_pro8000v ;;
    *) echo "unknown instrument: $w (crest, amino, bizar, pro8000v)" >&2; exit 2 ;;
  esac
done

echo "== meta"
node scripts/gen_meta.mjs $WHICH
du -sh "$OUT"/* | sed 's/^/   /'
