// Web MIDI keyboards (Chrome, Edge, Firefox; not Safari on iPad): every input plays the armed or selected track.
export class MidiInput {
  constructor(app) {
    this.app = app;
    this.inputs = [];
    if (!navigator.requestMIDIAccess) return;
    navigator.requestMIDIAccess({ sysex: false }).then((access) => {
      this.access = access;
      const wire = () => {
        this.inputs = [...access.inputs.values()];
        for (const input of this.inputs) {
          input.onmidimessage = (e) => {
            const m = e.data;
            if (m[0] >= 0xf0) return; // clock, SysEx
            app.liveMidi(m);
          };
        }
      };
      access.onstatechange = wire;
      wire();
    }).catch(() => { /* no permission */ });
  }
  get names() { return this.inputs.map((i) => i.name); }
}
