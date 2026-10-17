/** Time-based filter: isolated spikes require a second nearby sample. */
export class ControlFilter {
  constructor({ outlier = 48, smoothing = 35, hysteresis = 2 } = {}, steps = 0, max = 127) {
    Object.assign(this, { outlier, smoothing, hysteresis, steps, max });
    this.target = this.value = this.last = null;
    this.pending = null;
    this.time = null;
  }
  sample(value, now) {
    if (this.target !== null && this.outlier > 0 && Math.abs(value - this.target) > this.outlier * this.max / 127) {
      if (!this.pending || now - this.pending.at > 120 || Math.abs(value - this.pending.value) > 12 * this.max / 127) {
        this.pending = { value, at: now };
        return null;
      }
    }
    this.pending = null;
    this.target = value;
    if (this.value === null) this.value = value;
    return this.tick(now);
  }
  tick(now) {
    if (this.value === null) return null;
    const dt = this.time === null ? 0 : Math.max(0, now - this.time);
    this.time = now;
    this.value = this.smoothing ? this.target + (this.value - this.target) * Math.exp(-dt / this.smoothing) : this.target;
    if (Math.abs(this.value - this.target) < 0.05 * this.max / 127) this.value = this.target;
    const step = this.steps ? (this.max + 1) / this.steps : 1;
    let next = this.steps ? Math.min(this.max, Math.floor(this.value / step) * step) : Math.round(this.value);
    if (this.last !== null && next !== this.last) {
      // Schmitt margin around step boundaries; exact endpoints always settle.
      const h = this.hysteresis * this.max / 127;
      if (this.value !== 0 && this.value !== this.max) {
        if (this.steps && this.value > this.last && this.value < this.last + step + h) next = this.last;
        else if (this.steps && this.value < this.last && this.value > this.last - h) next = this.last;
        else if (!this.steps && Math.abs(next - this.last) < h) next = this.last;
      }
    }
    if (next === this.last) return null;
    this.last = next;
    return next;
  }
}

export const TARGETS = {
  volume: { label: 'Volume · CC7', cc: 7, steps: 16 },
  expression: { label: 'Expression · CC11', cc: 11, steps: 16 },
  duty: { label: 'Duty · CC70', cc: 70, steps: 4, pulse: true },
  sweepOn: { label: 'Sweep ON · CC13', cc: 13, steps: 2, pulse: true },
  sweepUp: { label: 'Sweep方向 · CC14', cc: 14, steps: 2, pulse: true },
  sweepTime: { label: 'Sweep時間 · CC15', cc: 15, steps: 8, pulse: true },
  sweepShift: { label: 'Sweep量 · CC16', cc: 16, steps: 8, pulse: true },
  bend: { label: 'Pitch Bend', bend: true },
};
export const defaultMappings = () => [
  { source: 'bend', cc: 0, target: 'bend', channel: 'auto' },
  ...Object.entries(TARGETS).filter(([, t]) => !t.bend).map(([target, t]) => ({ source: 'cc', cc: t.cc, target, channel: 'auto' })),
];
export const oxygenMappings = () => defaultMappings().map(row => ({ ...row, cc: ({ duty: 1, sweepTime: 74, sweepShift: 71, sweepOn: 91, sweepUp: 93 })[row.target] ?? row.cc }));
export const defaultPads = () => [
  { channel: 9, note: 36, noise: 4 }, { channel: 9, note: 38, noise: 10 },
  { channel: 9, note: 42, noise: 0 }, { channel: 9, note: 46, noise: 2 },
];
export function validMappings(rows) {
  return Array.isArray(rows) && rows.length <= 64 && rows.every(r => r && ['cc', 'bend'].includes(r.source) &&
    Number.isInteger(r.cc) && r.cc >= 0 && r.cc <= 127 && Object.hasOwn(TARGETS, r.target) &&
    ['auto', 'all', 0, 1, 2, 3].includes(r.channel));
}
export function validPads(rows) {
  return Array.isArray(rows) && rows.length <= 128 && rows.every(r => r && Number.isInteger(r.channel) && r.channel >= 0 && r.channel <= 15 &&
    Number.isInteger(r.note) && r.note >= 0 && r.note <= 127 && Number.isInteger(r.noise) && r.noise >= 0 && r.noise <= 127);
}
