import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MidiBridge } from '../dist/midi.js';
import { ControlFilter, oxygenMappings, defaultMappings } from '../dist/control.js';
import { loadSettings, restoreSettings, saveSettings, snapshot, SETTINGS_KEY } from '../dist/settings.js';
function setup(mode = 'mono') {
  const sent = []; let time = 0;
  const bridge = new MidiBridge({ now: () => time });
  bridge.configure({ mode });
  bridge.setOutput({ state: 'connected', send: bytes => sent.push([...bytes]), clear() {} });
  bridge.setEnabled(true); sent.length = 0;
  return { bridge, sent, tick: ms => { time += ms; bridge.tick(time); } };
}
test('Original preserves four channels and ignores ch5..16', () => {
  const { bridge, sent } = setup('original');
  for (let ch = 0; ch < 4; ch++) {
    assert(bridge.receive([0x90 | ch, 69, 90]));
    assert.deepEqual(sent.at(-1), [0x90 | ch, 69, 90]);
  }
  for (let ch = 4; ch < 16; ch++) assert.equal(bridge.receive([0x90 | ch, 69, 90]), false);
  for (let ch = 0; ch < 4; ch++) bridge.receive([0x80 | ch, 69, 0]);
  assert.equal(bridge.notes.size, 0);
});
test('Original matches device last note priority without restoring old notes', () => {
  const { bridge, sent } = setup('original');
  bridge.receive([0x91, 60, 100]); bridge.receive([0x91, 64, 100]);
  bridge.receive([0x81, 64, 0]);
  assert.equal(bridge.current, null);
  assert.deepEqual(sent.at(-1), [0x81, 64, 0]);
  const n = sent.length; bridge.receive([0x81, 60, 0]); assert.equal(sent.length, n);
});
test('voice-specific note ranges and noise map pass unchanged', () => {
  const { bridge, sent } = setup('original');
  assert(bridge.receive([0x92, 21, 1])); assert.equal(bridge.receive([0x92, 97, 100]), false);
  assert(bridge.receive([0x93, 127, 100])); assert.deepEqual(sent.at(-1), [0x93, 127, 100]);
});
test('Poly allocates P1/P2/Triangle and steals oldest, with matching Off', () => {
  const { bridge, sent } = setup('poly');
  for (const note of [60, 64, 67]) bridge.receive([0x90, note, 100]);
  assert.deepEqual(sent, [[0x90, 60, 100], [0x91, 64, 100], [0x92, 67, 100]]);
  bridge.receive([0x90, 72, 90]);
  assert.deepEqual(sent.slice(-2), [[0x80, 60, 0], [0x90, 72, 90]]);
  const n = sent.length; bridge.receive([0x80, 60, 0]); assert.equal(sent.length, n);
  bridge.receive([0x80, 72, 0]); assert.deepEqual(sent.at(-1), [0x80, 72, 0]);
  assert.equal([...bridge.notes.values()].filter(n => n.allocated).length, 2);
});
test('Poly restores stolen held note, including repeated steals', () => {
  const { bridge, sent } = setup('poly');
  for (const note of [60, 64, 67, 72, 76]) bridge.noteOn(`key${note}`, note, 100);
  bridge.noteOff('key76'); assert.deepEqual(sent.at(-1), [0x91, 64, 100]);
  bridge.noteOff('key72'); assert.deepEqual(sent.at(-1), [0x90, 60, 100]);
  for (const note of [60, 64, 67]) bridge.noteOff(`key${note}`);
  assert.equal(bridge.current, null);
});
test('Poly only assigns notes within each voice range', () => {
  const { bridge, sent } = setup('poly');
  bridge.noteOn('low', 21, 100); assert.deepEqual(sent.at(-1), [0x92, 21, 100]);
  bridge.noteOn('hi1', 100, 100); bridge.noteOn('hi2', 101, 100); bridge.noteOn('hi3', 102, 100);
  assert.equal(bridge.notes.get('low').allocated, true);
  assert.equal(bridge.notes.get('hi3').channel, 0);
});
test('Poly pads use Noise without stealing pitched voices and release correctly', () => {
  const { bridge, sent } = setup('poly');
  for (const note of [60, 64, 67]) bridge.noteOn(String(note), note, 100);
  bridge.receive([0x99, 36, 120]); assert.deepEqual(sent.at(-1), [0x93, 4, 120]);
  bridge.receive([0x89, 36, 0]); assert.deepEqual(sent.at(-1), [0x83, 4, 0]);
  assert.equal([...bridge.notes.values()].filter(n => n.allocated).length, 3);
});
test('custom pads support any input channel and long/short noise numbers', () => {
  const { bridge, sent } = setup(); bridge.configure({ pads: [{ channel: 2, note: 60, noise: 75 }] });
  bridge.receive([0x92, 60, 100]); assert.deepEqual(sent.at(-1), [0x93, 75, 100]);
  bridge.receive([0x92, 60, 0]); assert.deepEqual(sent.at(-1), [0x83, 75, 0]);
});
test('Mono output selection targets Triangle/Noise with last-note fallback', () => {
  const { bridge, sent } = setup(); bridge.configure({ controlChannel: 2 });
  bridge.receive([0x9f, 21, 100]); assert.deepEqual(sent.at(-1), [0x92, 21, 100]);
  bridge.receive([0x9f, 60, 100]); bridge.receive([0x8f, 60, 0]);
  assert.deepEqual(sent.at(-1), [0x92, 21, 100]);
});
test('switching mode or mapping clears all sounding notes and filter tails', () => {
  const { bridge, sent } = setup('poly');
  bridge.receive([0x90, 60, 100]); bridge.receive([0x90, 64, 100]);
  bridge.receive([0xb0, 7, 20]); bridge.configure({ mode: 'original' });
  for (let ch = 0; ch < 4; ch++) assert(sent.some(m => m.join() === `${0xb0 | ch},120,0`));
  assert.equal(bridge.notes.size, 0); assert.equal(bridge.filters.size, 0);
});
test('Poly bends and CC volume fan out to all pitched voices', () => {
  const { bridge, sent } = setup('poly');
  bridge.receive([0xe0, 127, 127]);
  assert.deepEqual(sent, [[0xe0, 127, 127], [0xe1, 127, 127], [0xe2, 127, 127]]);
  bridge.receive([0xb0, 7, 127]);
  assert.deepEqual(sent.slice(-3), [[0xb0, 7, 120], [0xb1, 7, 120], [0xb2, 7, 127]]);
});
test('Oxygen preset remaps mod wheel and knobs; mappings can target fixed channels', () => {
  const { bridge, sent } = setup(); bridge.configure({ mappings: oxygenMappings() }); sent.length = 0;
  bridge.receive([0xb0, 1, 127]); assert.deepEqual(sent.at(-1), [0xb0, 70, 96]);
  bridge.configure({ mappings: [{ source: 'cc', cc: 22, target: 'expression', channel: 1 }] });
  bridge.receive([0xb4, 22, 64]); assert.deepEqual(sent.at(-1), [0xb1, 11, 64]);
});
test('CC mappings can create Pitch Bend and pitch wheel can drive Duty', () => {
  const { bridge, sent } = setup();
  bridge.configure({ mappings: [{ source: 'cc', cc: 23, target: 'bend', channel: 0 }, { source: 'bend', cc: 0, target: 'duty', channel: 1 }] });
  bridge.receive([0xb0, 23, 127]); assert.deepEqual(sent.at(-1), [0xe0, 127, 127]);
  bridge.receive([0xe0, 127, 127]); assert.deepEqual(sent.at(-1), [0xb1, 70, 96]);
});
test('pulse-only controls never reach Triangle or Noise', () => {
  const { bridge, sent } = setup('original');
  for (const ch of [2, 3]) assert.equal(bridge.receive([0xb0 | ch, 70, 127]), false);
  bridge.configure({ controlChannel: 'all' }); sent.length = 0;
  bridge.manualControl('sweepOn', 127); assert.deepEqual(sent, [[0xb0, 13, 127], [0xb1, 13, 127]]);
});
test('Pulse volume quantizes into exactly sixteen bins', () => {
  const { bridge, sent } = setup(); const levels = new Set();
  for (let value = 0; value < 128; value++) { bridge.setVolume(value); levels.add(sent.at(-1)[2]); }
  assert.deepEqual([...levels], Array.from({ length: 16 }, (_, n) => n * 8));
});
test('isolated CC outlier is discarded, coherent second sample confirms real jump', () => {
  const f = new ControlFilter({ outlier: 48, smoothing: 0, hysteresis: 0 });
  assert.equal(f.sample(20, 0), 20); assert.equal(f.sample(127, 10), null);
  assert.equal(f.tick(50), null); assert.equal(f.sample(21, 60), 21);
  assert.equal(f.sample(100, 70), null); assert.equal(f.sample(105, 80), 105);
  assert.equal(f.sample(0, 90), null); assert.equal(f.sample(0, 300), null);
  assert.equal(f.sample(0, 310), 0);
});
test('smoothing settles with ticks even after knob stops sending', () => {
  const f = new ControlFilter({ outlier: 0, smoothing: 40, hysteresis: 0 });
  assert.equal(f.sample(0, 0), 0); const first = f.sample(100, 10);
  assert(first > 0 && first < 100);
  assert.equal(f.tick(1000), 100); assert.equal(f.tick(1100), null);
});
test('hysteresis prevents chatter around volume bin boundary and endpoints settle', () => {
  const f = new ControlFilter({ outlier: 0, smoothing: 0, hysteresis: 2 }, 16);
  assert.equal(f.sample(7, 0), 0); assert.equal(f.sample(8, 1), null); assert.equal(f.sample(9, 2), null);
  assert.equal(f.sample(10, 3), 8); assert.equal(f.sample(7, 4), null); assert.equal(f.sample(6, 5), 0);
  assert.equal(f.sample(127, 6), 120); assert.equal(f.sample(0, 7), 0);
});
test('input filter states are isolated per source, MIDI channel, mapping and voice', () => {
  const { bridge, sent } = setup('original');
  bridge.receive([0xb0, 7, 0], 'a'); bridge.receive([0xb1, 7, 127], 'a'); bridge.receive([0xb0, 7, 127], 'b');
  assert.deepEqual(sent, [[0xb0, 7, 0], [0xb1, 7, 120], [0xb0, 7, 120]]);
});
test('manual controls cancel pending input smoothing for that target', () => {
  const { bridge, sent, tick } = setup();
  bridge.receive([0xb0, 7, 0]); bridge.receive([0xb0, 7, 20]); bridge.setVolume(120);
  const n = sent.length; tick(1000); assert.equal(sent.length, n);
});
test('Original All Sound Off is channel-local, Poly panic includes Noise pads', () => {
  const { bridge } = setup('original');
  bridge.receive([0x90, 60, 100]); bridge.receive([0x91, 64, 100]); bridge.receive([0xb0, 120, 0]);
  assert.equal(bridge.notes.size, 1); assert.equal(bridge.current.channel, 1);
  bridge.configure({ mode: 'poly' }); bridge.receive([0x99, 36, 100]); bridge.receive([0xb0, 123, 0]);
  assert.equal(bridge.notes.size, 0);
});
test('CC121 and program change reset or select supported controls', () => {
  const { bridge, sent } = setup('original');
  bridge.receive([0xc1, 7]); assert.deepEqual(sent.at(-1), [0xb1, 70, 96]);
  bridge.receive([0xb1, 121, 0]); assert.equal(bridge.controls[1].duty, 64);
  assert.deepEqual(sent.at(-1), [0xb1, 121, 0]);
});
test('settings survive serialization; corrupt storage/config is ignored safely', () => {
  let stored;
  const storage = { getItem: () => stored, setItem: (key, value) => { assert.equal(key, SETTINGS_KEY); stored = value; } };
  const { bridge } = setup('poly'); bridge.configure({ mappings: oxygenMappings(), pads: [] });
  bridge.controls[1].volume = 40;
  assert(saveSettings(storage, snapshot(bridge, { preset: 'oxygen' })));
  const copy = new MidiBridge(); restoreSettings(copy, loadSettings(storage));
  assert.equal(copy.mode, 'poly'); assert.deepEqual(copy.mappings, oxygenMappings()); assert.equal(copy.controls[1].volume, 40);
  assert.equal(copy.enabled, false); assert.equal(copy.notes.size, 0);
  stored = '{broken'; assert.deepEqual(loadSettings(storage), {});
  restoreSettings(copy, { config: { mappings: [{ target: '__proto__' }] }, controls: [{ bend: -1 }, {}, {}, {}] });
  assert.deepEqual(copy.mappings, oxygenMappings()); assert.equal(copy.controls[0].bend, 8192);
  assert.equal(saveSettings({ setItem() { throw Error('quota'); } }, {}), false);
});
test('invalid mapping/filter/pad configurations leave previous profile intact', () => {
  const { bridge } = setup();
  for (const config of [{ mode: 'bad' }, { filter: { outlier: -1 } }, { mappings: [{ source: 'cc', cc: 128, target: 'volume', channel: 0 }] }, { pads: [{ channel: 16, note: 60, noise: 0 }] }]) assert.equal(bridge.configure(config), false);
  assert.deepEqual(bridge.mappings, defaultMappings());
});
test('Poly retrigger reuses its own voice without stealing another held key', () => {
  const { bridge } = setup('poly');
  for (const note of [60, 64, 67]) bridge.noteOn(String(note), note, 100);
  bridge.noteOn('64', 64, 120);
  assert.equal(bridge.notes.get('60').allocated, true);
  assert.equal(bridge.notes.get('64').channel, 1);
  assert.equal(bridge.notes.get('67').allocated, true);
});
test('binary sweep buttons accept a single edge without smoothing or spike rejection', () => {
  const { bridge, sent } = setup();
  for (const value of [0, 64, 0, 127]) {
    bridge.receive([0xb0, 13, value]);
    assert.deepEqual(sent.at(-1), [0xb0, 13, value >= 64 ? 64 : 0]);
  }
});
test('random poly events keep one allocated note per playable voice and drain to silence', () => {
  const { bridge } = setup('poly');
  let seed = 29107;
  const rand = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  for (let n = 0; n < 2000; n++) {
    const note = 21 + rand(88), token = `key:${note}`;
    if (rand(3)) bridge.noteOn(token, note, 1 + rand(127)); else bridge.noteOff(token);
    const voices = [...bridge.notes.values()].filter(n => n.allocated);
    assert.equal(new Set(voices.map(n => n.channel)).size, voices.length);
    assert(voices.length <= 3);
    for (const v of voices) assert(v.channel === 2 ? v.note >= 21 && v.note <= 96 : v.note >= 33 && v.note <= 108);
  }
  for (const token of [...bridge.notes.keys()]) bridge.noteOff(token);
  assert.equal(bridge.current, null);
});
test('Mono all-voice controls fan out while notes stay on Pulse 1', () => {
  const { bridge, sent } = setup(); bridge.configure({ controlChannel: 'all' }); sent.length = 0;
  bridge.receive([0x90, 60, 100]); assert.deepEqual(sent.at(-1), [0x90, 60, 100]);
  bridge.receive([0xb0, 7, 64]);
  assert.deepEqual(sent.slice(-4), [[0xb0, 7, 64], [0xb1, 7, 64], [0xb2, 7, 64], [0xb3, 7, 64]]);
});
