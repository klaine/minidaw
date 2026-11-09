// Recording audio in real time: the master output (what you hear, as a WAV), or an input (the microphone, into an
// audio track). Both use the "recorder" processor (worklets/daw-worklet.js).

export class Capture {
  constructor(ctx, source, channels = 2) {
    this.ctx = ctx;
    this.node = new AudioWorkletNode(ctx, "recorder", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { channels } });
    this.chunks = [];
    this.channels = channels;
    source.connect(this.node);
    this.source = source;
    // a processor runs only when its output goes somewhere: a silent one into the destination
    this.sink = ctx.createGain();
    this.sink.gain.value = 0;
    this.node.connect(this.sink).connect(ctx.destination);
    this.node.port.onmessage = (e) => {
      const d = e.data;
      if (d.t === "data") this.chunks.push(d.channels);
      else if (d.t === "started") { this.startTime = d.time; if (this.onStart) this.onStart(d.time); }
      else if (d.t === "stopped") { this.stopTime = d.time; if (this.onStop) this.onStop(); }
    };
  }
  start() {
    this.chunks = [];
    return new Promise((resolve) => { this.onStart = resolve; this.node.port.postMessage({ t: "start" }); });
  }
  stop() {
    return new Promise((resolve) => {
      this.onStop = () => {
        const n = this.chunks.reduce((s, c) => s + c[0].length, 0);
        const out = [];
        for (let c = 0; c < this.channels; c++) {
          const a = new Float32Array(n);
          let at = 0;
          for (const chunk of this.chunks) { a.set(chunk[c], at); at += chunk[c].length; }
          out.push(a);
        }
        this.chunks = [];
        resolve(out);
      };
      this.node.port.postMessage({ t: "stop" });
    });
  }
  dispose() {
    try { this.source.disconnect(this.node); } catch (_) { /* gone */ }
    try { this.node.disconnect(); this.sink.disconnect(); } catch (_) { /* gone */ }
  }
}

/** The microphone (or another input) as a source node, with the browser's voice processing off */
export async function openInput(ctx) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 },
  });
  const src = ctx.createMediaStreamSource(stream);
  const track = stream.getAudioTracks()[0];
  const settings = track && track.getSettings ? track.getSettings() : {};
  return { stream, src, latency: typeof settings.latency === "number" ? settings.latency : 0.01, close() { stream.getTracks().forEach((t) => t.stop()); } };
}
