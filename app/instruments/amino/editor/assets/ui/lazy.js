/* Shared by the modules loaded after first paint: their stylesheet. */
let added = false;

export function lazyStyles() {
  if (added) return;
  added = true;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "assets/ui/lazy.css";
  document.head.appendChild(link);
}
