import { ControlFilter, TARGETS, defaultMappings, defaultPads, validMappings, validPads } from './control.js';
export const NOTE_MIN = 33;
export const NOTE_MAX = 108;
export const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
export const noteName = note => `${NOTE_NAMES[note % 12]}${Math.floor(note / 12) - 1}`;
export const playable = (note, ch) => Number.isInteger(note) && (ch === 3 ? note >= 0 && note <= 127 : ch === 2 ? note >= 21 && note <= 96 : note >= 33 && note <= 108);

/** Browser-local MIDI router; the firmware remains usable without this app. */
export class MidiBridge {
  constructor({ onState = () => {}, onMessage = () => {}, onInput = () => {}, onError = () => {}, now = () => performance.now() } = {}) {
    Object.assign(this, { onState, onMessage, onInput, onError, now });
    this.output = null;
    this.enabled = false;
    this.notes = new Map();
    this.inputChannel = 'all';
    this.transpose = 0;
    this.mode = 'mono';
    this.controlChannel = 0;
    this.volume = 127;
    this.bend = 8192;
    this.mappings = defaultMappings();
    this.pads = defaultPads();
    this.filter = { outlier: 48, smoothing: 35, hysteresis: 2 };
    this.filters = new Map();
    this.controls = Array.from({ length: 4 }, () => ({ volume: 127, expression: 127, duty: 64, sweepOn: 0, sweepUp: 127, sweepTime: 16, sweepShift: 48, bend: 8192 }));
  }
  get current() { return [...this.notes.values()].filter(n => n.allocated).at(-1) ?? null; }
  changed() { this.onState(this); }
  send(bytes) {
    if (!this.output || this.output.state === 'disconnected') return false;
    try { this.output.send(bytes); this.onMessage([...bytes]); return true; }
    catch (error) {
      this.enabled = false; this.notes.clear(); this.filters.clear(); this.output = null;
      this.onError(error); this.changed(); return false;
    }
  }
  setOutput(output) {
    if (output === this.output) return;
    if (this.output) this.panic();
    this.enabled = false; this.output = output; this.changed();
  }
  setEnabled(enabled) {
    if (!enabled) {
      if (this.enabled || this.notes.size) this.panic();
      this.enabled = false;
    } else if (this.output && this.output.state !== 'disconnected') {
      this.enabled = true;
      // Flush notes left by a closed tab/another client, then restore this profile.
      this.panic();
      for (let ch = 0; ch < 4; ch++) for (const [target, value] of Object.entries(this.controls[ch])) {
        if (!this.enabled) break;
        this.control(target, value, [ch]);
      }
    }
    this.changed();
  }
  configure(options = {}) {
    const { inputChannel = this.inputChannel, transpose = this.transpose, mode = this.mode,
      controlChannel = this.controlChannel, mappings = this.mappings, pads = this.pads, filter = this.filter } = options;
    if (!['all', ...Array.from({ length: 16 }, (_, n) => n)].includes(inputChannel) ||
      !Number.isInteger(transpose) || transpose < -24 || transpose > 24 ||
      !['original', 'mono', 'poly'].includes(mode) || !['all', 0, 1, 2, 3].includes(controlChannel) ||
      !validMappings(mappings) || !validPads(pads) || !filter ||
      ![['outlier', 0, 127], ['smoothing', 0, 300], ['hysteresis', 0, 16]].every(([key, min, max]) => Number.isFinite(filter[key]) && filter[key] >= min && filter[key] <= max)) return false;
    const changed = inputChannel !== this.inputChannel || transpose !== this.transpose || mode !== this.mode || controlChannel !== this.controlChannel ||
      JSON.stringify(mappings) !== JSON.stringify(this.mappings) || JSON.stringify(pads) !== JSON.stringify(this.pads) || JSON.stringify(filter) !== JSON.stringify(this.filter);
    if (!changed) return true;
    this.panic();
    Object.assign(this, { inputChannel, transpose, mode, controlChannel, mappings: structuredClone(mappings), pads: structuredClone(pads), filter: { ...filter } });
    this.changed(); return true;
  }
  noteOn(token, note, velocity, channel = this.controlChannel === 'all' ? 0 : this.controlChannel, pad = false) {
    if (!this.enabled || !Number.isInteger(velocity) || velocity < 1 || velocity > 127) return false;
    if (!Number.isInteger(channel) || channel < 0 || channel > 3) return false;
    if (this.mode === 'poly' && !pad) {
      const candidates = [0, 1, 2].filter(ch => playable(note, ch));
      if (!candidates.length) return false;
      const sounding = [...this.notes.values()].filter(n => n.allocated);
      const own = this.notes.get(token);
      channel = own?.allocated && candidates.includes(own.channel) ? own.channel : candidates.find(ch => !sounding.some(n => n.channel === ch));
      if (channel === undefined) channel = sounding.find(n => candidates.includes(n.channel)).channel;
    }
    if (!playable(note, channel)) return false;
    if (this.notes.has(token)) this.noteOff(token);
    const previous = [...this.notes.values()].filter(n => n.allocated && n.channel === channel).at(-1);
    if (this.mode === 'poly' && previous) this.send([0x80 | channel, previous.note, 0]);
    if (!this.enabled || !this.send([0x90 | channel, note, velocity])) return false;
    if (previous) previous.allocated = false;
    this.notes.set(token, { token, note, velocity, channel, allocated: true });
    this.changed(); return true;
  }
  noteOff(token) {
    const released = this.notes.get(token);
    if (!released) return false;
    this.notes.delete(token);
    if (released.allocated) {
      const held = [...this.notes.values()].filter(n => n.channel === released.channel);
      const next = this.mode !== 'original' ? held.at(-1) : null;
      if (!next || next.note !== released.note) this.send([0x80 | released.channel, released.note, 0]);
      if (next) {
        if (next.note !== released.note || next.velocity !== released.velocity) this.send([0x90 | next.channel, next.note, next.velocity]);
        if (this.enabled) next.allocated = true;
      }
    } else if (this.mode === 'mono' && ![...this.notes.values()].some(n => n.allocated && n.channel === released.channel && n.note === released.note)) {
      this.send([0x80 | released.channel, released.note, 0]);
    }
    this.changed(); return true;
  }
  releaseSources(prefix) { for (const token of [...this.notes.keys()]) if (token.startsWith(prefix)) this.noteOff(token); }
  channels(inputChannel = 0) {
    return this.mode === 'original' ? (inputChannel < 4 ? [inputChannel] : []) : this.mode === 'poly' ? [0, 1, 2] : this.controlChannel === 'all' ? [0, 1, 2, 3] : [this.controlChannel];
  }
  control(target, value, channels) {
    const spec = TARGETS[target];
    if (!spec || !Number.isInteger(value) || value < 0 || value > (spec.bend ? 16383 : 127)) return;
    for (const ch of channels) {
      if (spec.pulse && ch > 1 || spec.bend && ch === 3) continue;
      this.controls[ch][target] = value;
      if (target === 'volume') this.volume = value;
      if (target === 'bend') this.bend = value;
      if (this.enabled) {
        const ok = spec.bend ? this.send([0xe0 | ch, value & 127, value >> 7]) : this.send([0xb0 | ch, spec.cc, value]);
        if (!ok) break;
      }
    }
    this.changed();
  }
  manualControl(target, value) {
    for (const [key, entry] of this.filters) if (entry.target === target) this.filters.delete(key);
    const channels = this.controlChannel === 'all' ? [0, 1, 2, 3] : this.mode === 'poly' ? [0, 1, 2] : [this.controlChannel];
    // Pulse volume is represented by exactly 16 MIDI bins.
    if (target === 'volume') {
      for (const ch of channels) this.control(target, ch < 2 ? Math.floor(value / 8) * 8 : value, [ch]);
    } else this.control(target, value, channels);
  }
  setVolume(value) { if (Number.isInteger(value) && value >= 0 && value <= 127) this.manualControl('volume', value); }
  setBend(value) { this.manualControl('bend', value); }
  receive(data, source = 'midi', time = this.now()) {
    if (!this.enabled || ![2, 3].includes(data.length)) return false;
    const [status, first, second = 0] = data;
    if (![status, first, second].every(Number.isInteger) || first < 0 || first > 127 || second < 0 || second > 127 || status < 0x80 || status >= 0xf0) return false;
    const type = status & 0xf0, channel = status & 15;
    if (data.length !== (type === 0xc0 || type === 0xd0 ? 2 : 3) || this.inputChannel !== 'all' && channel !== this.inputChannel) return false;
    this.onInput([...data]);
    const token = `midi:${source}:${channel}:${first}`;
    if (type === 0x80 || type === 0x90 && second === 0) return this.noteOff(token);
    if (type === 0x90) {
      const pad = this.pads.find(p => p.channel === channel && p.note === first);
      const channels = this.channels(channel);
      if (!pad && !channels.length) return false;
      return this.noteOn(token, pad ? pad.noise : first + this.transpose, second, pad ? 3 : channels[0], Boolean(pad));
    }
    if (type === 0xb0 && [120, 123].includes(first)) {
      const channels = this.mode === 'original' ? this.channels(channel) : [0, 1, 2, 3];
      this.filters.clear();
      for (const ch of channels) {
        for (const [key, n] of this.notes) if (n.channel === ch) {
          if (n.allocated) this.send([0x80 | ch, n.note, 0]);
          this.notes.delete(key);
        }
        this.send([0xb0 | ch, first, 0]);
      }
      this.changed(); return true;
    }
    if (type === 0xb0 && first === 121) {
      this.filters.clear();
      for (const ch of this.channels(channel)) {
        this.controls[ch] = { volume: 127, expression: 127, duty: 64, sweepOn: 0, sweepUp: 127, sweepTime: 16, sweepShift: 48, bend: 8192 };
        this.send([0xb0 | ch, 121, 0]);
      }
      this.changed(); return true;
    }
    if (type === 0xc0) {
      for (const ch of this.channels(channel).filter(c => c < 2)) this.control('duty', (first % 4) * 32, [ch]);
      return true;
    }
    if (type !== 0xb0 && type !== 0xe0) return false;
    let matched = false;
    this.mappings.forEach((row, index) => {
      if (type === 0xe0 ? row.source !== 'bend' : row.source !== 'cc' || row.cc !== first) return;
      const channels = row.channel === 'auto' ? this.channels(channel) : row.channel === 'all' ? [0, 1, 2, 3] : [row.channel];
      const inputValue = type === 0xe0 ? first | second << 7 : second;
      for (const ch of channels) {
        const spec = TARGETS[row.target];
        if (spec.pulse && ch > 1 || spec.bend && ch === 3) continue;
        const max = spec.bend ? 16383 : 127;
        const value = Math.round(inputValue * max / (type === 0xe0 ? 16383 : 127));
        // Hardware pitch wheel retains all 14 bits and its spring-return speed.
        if (type === 0xe0 && spec.bend) { this.control('bend', value, [ch]); matched = true; continue; }
        const key = `${source}:${channel}:${index}:${ch}`;
        let entry = this.filters.get(key);
        if (!entry) {
          const steps = ch === 2 && ['volume', 'expression'].includes(row.target) ? 0 : spec.steps || 0;
          const options = spec.steps === 2 ? { outlier: 0, smoothing: 0, hysteresis: 0 } : this.filter;
          entry = { filter: new ControlFilter(options, steps, max), target: row.target, ch };
          this.filters.set(key, entry);
        }
        const filtered = entry.filter.sample(value, time);
        if (filtered !== null) this.control(row.target, filtered, [ch]);
        matched = true;
      }
    });
    return matched;
  }
  tick(time = this.now()) {
    if (!this.enabled) return;
    for (const entry of this.filters.values()) {
      const value = entry.filter.tick(time);
      if (value !== null) this.control(entry.target, value, [entry.ch]);
    }
  }
  panic() {
    this.notes.clear(); this.filters.clear(); this.bend = 8192;
    for (const state of this.controls) state.bend = 8192;
    try { this.output?.clear?.(); } catch { /* removed port */ }
    // ch1 explicit Off sweep also supports the earlier successful PoC firmware.
    for (let note = NOTE_MIN; note <= NOTE_MAX; note++) if (!this.send([0x80, note, 0])) break;
    for (let ch = 0; ch < 4; ch++) {
      if (!this.send([0xb0 | ch, 120, 0])) break;
      if (ch < 3 && !this.send([0xe0 | ch, 0, 64])) break;
    }
    this.changed();
  }
}
