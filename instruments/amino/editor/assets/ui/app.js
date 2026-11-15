/* Remote UI entry point: load the generated metadata, build the shell once,
 * then let the store stream device values into it. */
import { expandMeta, Store } from "./store.js";
import { buildShell } from "./layout.js";

async function boot() {
  const root = document.getElementById("app");
  let meta;
  try {
    const res = await fetch("assets/ui_meta.json", { cache: "no-cache" });
    if (!res.ok) throw new Error("ui_meta.json returned " + res.status);
    meta = expandMeta(await res.json());
  } catch (err) {
    root.textContent = "Could not load Amino's UI metadata (" + err.message + ").";
    root.className = "fatal";
    return;
  }
  const remote = window.schwungRemote || null;
  const store = new Store(meta, remote);
  buildShell(store, root);
  if (!remote) {
    document.documentElement.classList.add("offline");
    return;
  }
  store.connect();
  window.amino = store; // handy from the devtools console
}

boot();
