// node tests/smoke.cjs [url] [outdir]: start the app in Chromium at an iPad's size, play the demo, try the views.
const { chromium } = require("playwright");
const url = process.argv[2] || "http://localhost:8765/?nosw";
const out = process.argv[3] || "test-results";
require("fs").mkdirSync(out, { recursive: true });
(async () => {
  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  const page = await browser.newPage({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 1, hasTouch: true });
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") errors.push(m.type() + ": " + m.text()); });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  await page.goto(url);
  await page.waitForSelector("#boot-start:not([disabled])");
  await page.click("#boot-start");
  await page.waitForSelector(".topbar", { timeout: 30000 });
  await page.waitForTimeout(3000);
  const loaded = await page.evaluate(() => [...window.minidaw.engine.channels.entries()].map(([id, ch]) => [window.minidaw.store.track(id).name, ch.kind, !!ch.instrument, ch.error || ""]));
  console.log("instruments:", JSON.stringify(loaded));
  await page.screenshot({ path: out + "/arrange.png" });
  await page.evaluate(() => window.minidaw.transport.seek(32));
  await page.evaluate(() => window.minidaw.togglePlay());
  let peak = 0;
  for (let i = 0; i < 20; i++) { await page.waitForTimeout(150); peak = Math.max(peak, await page.evaluate(() => window.minidaw.engine.masterPeak())); }
  console.log("master peak while playing:", peak.toFixed(3));
  const tracks = await page.evaluate(() => window.minidaw.store.project.tracks.map((t) => [t.name, +window.minidaw.engine.trackPeak(t.id).toFixed(3)]));
  console.log("track peaks:", JSON.stringify(tracks));
  await page.screenshot({ path: out + "/arrange-playing.png" });
  await page.evaluate(() => window.minidaw.stop());
  for (const v of ["session", "mixer"]) {
    await page.evaluate((v) => window.minidaw.setView(v), v);
    await page.waitForTimeout(500);
    await page.screenshot({ path: out + "/" + v + ".png" });
  }
  await page.evaluate(() => window.minidaw.setView("arrange"));
  console.log(errors.length ? "console:\n  " + errors.slice(0, 30).join("\n  ") : "no console errors");
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
