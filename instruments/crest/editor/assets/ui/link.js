/* Links between the store and a synth.
 *
 *  DeviceLink  the Move, through Schwung's schwungRemote bridge (web_ui.html in the Remote UI).
 *  LocalLink   crest.wasm in this browser (the standalone site), with the patch kept in localStorage.
 *
 * Both deliver { key: value } maps; LocalLink re-reads the whole state after a patch load. */

export class DeviceLink {
  constructor(remote) {
    this.remote = remote;
    this.kind = "device";
    this.prefix = (remote.component || "synth") + ":";
  }

  onValues(cb) {
    this.remote.onParamChange((params) => {
      const vals = {};
      let full = false;
      for (const k in params) {
        if (!k.startsWith(this.prefix)) continue;
        const key = k.slice(this.prefix.length);
        if (key === "state") { /* a whole patch, if the manager forwards it */
          try {
            const st = JSON.parse(params[k]);
            for (const s in st) if (s !== "fmt" && s !== "v" && s !== "name") vals[s] = st[s];
            if (st.name) vals.preset_name = st.name;
            full = true;
          } catch (_) { /* not JSON: ignore */ }
          continue;
        }
        vals[key] = params[k];
      }
      cb(vals, full);
    });
  }

  send(key, value) { this.remote.setParam(this.prefix + key, String(value)); }
}

const SAVE_KEY = "crest.state.v1";

export class LocalLink {
  constructor(engine) {
    this.engine = engine;
    this.kind = "local";
    this.cb = () => {};
    this.saveTimer = 0;
  }

  async init() {
    try {
      const saved = localStorage.getItem(SAVE_KEY);
      if (saved) this.engine.set("state", saved);
    } catch (_) { /* storage blocked: start from the Init patch */ }
    await this.refresh();
  }

  onValues(cb) { this.cb = cb; }

  async refresh() {
    const text = await this.engine.get("state");
    if (!text) return;
    const st = JSON.parse(text);
    const vals = {};
    for (const s in st) if (s !== "fmt" && s !== "v" && s !== "name") vals[s] = st[s];
    vals.preset_name = st.name;
    vals.preset = await this.engine.get("preset");
    this.cb(vals, true);
  }

  send(key, value) {
    this.engine.set(key, value);
    if (key === "preset" || key === "state") this.refresh();
    this.scheduleSave();
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(async () => {
      try {
        const st = await this.engine.get("state");
        if (st) localStorage.setItem(SAVE_KEY, st);
      } catch (_) { /* quota or blocked storage */ }
    }, 800);
  }

  midi(m) { this.engine.midi(m); }
  tempo(bpm, run) { this.engine.tempo(bpm, run); }
}
