import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MidiBridge, noteName, NOTE_MIN, NOTE_MAX } from '../dist/midi.js';

function setup() {
  const sent = [];
  const errors = [];
  const output = { state: 'connected', send: bytes => sent.push([...bytes]), clear() {} };
  const bridge = new MidiBridge({ onError: e => errors.push(e) });
  bridge.setOutput(output);
  bridge.setEnabled(true);
  sent.length = 0;
  return { bridge, sent, output, errors };
}

test('ch16 keyboard Note On/Off becomes ch1, preserving note and velocity', () => {
  const { bridge, sent } = setup();
  bridge.receive([0x9f, 69, 127], 'oxygen');
  bridge.receive([0x8f, 69, 64], 'oxygen');
  assert.deepEqual(sent, [[0x90, 69, 127], [0x80, 69, 0]]);
  assert.equal(bridge.notes.size, 0);
});

test('zero-velocity Note On is Note Off', () => {
  const { bridge, sent } = setup();
  bridge.receive(new Uint8Array([0x90, 60, 90]));
  bridge.receive(new Uint8Array([0x90, 60, 0]));
  assert.deepEqual(sent.at(-1), [0x80, 60, 0]);
  assert.equal(bridge.current, null);
});

test('last-note priority restores a key held underneath the released key', () => {
  const { bridge, sent } = setup();
  bridge.receive([0x90, 60, 80]);
  bridge.receive([0x90, 64, 110]);
  bridge.receive([0x80, 64, 0]);
  assert.deepEqual(sent.slice(-2), [[0x80, 64, 0], [0x90, 60, 80]]);
  assert.equal(bridge.current.note, 60);
  bridge.receive([0x80, 60, 0]);
  assert.equal(bridge.current, null);
});

test('releasing an older note does not retrigger the newer note', () => {
  const { bridge, sent } = setup();
  bridge.receive([0x90, 60, 80]);
  bridge.receive([0x90, 64, 110]);
  bridge.receive([0x80, 60, 0]);
  assert.deepEqual(sent.at(-1), [0x80, 60, 0]);
  assert.equal(bridge.current.note, 64);
});

test('same pitch from two sources does not get stuck or prematurely stop', () => {
  const { bridge, sent } = setup();
  bridge.noteOn('screen', 69, 100);
  bridge.receive([0x90, 69, 100]);
  const before = sent.length;
  bridge.noteOff('screen');
  assert.equal(sent.length, before);
  bridge.receive([0x80, 69, 0]);
  assert.deepEqual(sent.at(-1), [0x80, 69, 0]);
});

test('same pitch restores previous velocity when the latest source releases', () => {
  const { bridge, sent } = setup();
  bridge.noteOn('screen', 69, 60);
  bridge.noteOn('keyboard', 69, 120);
  bridge.noteOff('keyboard');
  assert.deepEqual(sent.at(-1), [0x90, 69, 60]);
});

test('input channel filter allows one MIDI channel and always outputs ch1', () => {
  const { bridge, sent } = setup();
  bridge.configure({ inputChannel: 2 });
  sent.length = 0;
  assert.equal(bridge.receive([0x91, 69, 100]), false);
  assert.equal(bridge.receive([0x92, 69, 100]), true);
  assert.deepEqual(sent, [[0x90, 69, 100]]);
});

test('transpose applies to input and note release uses stored pitch', () => {
  const { bridge, sent } = setup();
  bridge.configure({ transpose: 12 });
  bridge.receive([0x90, 60, 100]);
  bridge.receive([0x80, 60, 0]);
  assert.deepEqual(sent.slice(-2), [[0x90, 72, 100], [0x80, 72, 0]]);
});

test('changing transpose while holding notes silences the old mapping first', () => {
  const { bridge, sent } = setup();
  bridge.receive([0x90, 60, 100]);
  bridge.configure({ transpose: 12 });
  assert(sent.some(m => m[0] === 0x80 && m[1] === 60));
  assert.equal(bridge.notes.size, 0);
  sent.length = 0;
  bridge.receive([0x80, 60, 0]);
  assert.deepEqual(sent, []);
});

test('out-of-range notes are ignored without stealing a playable held note', () => {
  const { bridge, sent } = setup();
  bridge.receive([0x90, 69, 100]);
  for (const note of [0, 32, 109, 127]) assert.equal(bridge.receive([0x90, note, 100]), false);
  assert.equal(sent.length, 1);
  assert.equal(bridge.current.note, 69);
  for (const note of [33, 108]) assert.equal(bridge.noteOn(String(note), note, 100), true);
});

test('14-bit pitch bend and CC7 are forwarded to channel 1', () => {
  const { bridge, sent } = setup();
  bridge.receive([0xe5, 127, 127]);
  bridge.receive([0xb5, 7, 64]);
  assert.deepEqual(sent, [[0xe0, 127, 127], [0xb0, 7, 64]]);
  assert.equal(bridge.bend, 16383);
  assert.equal(bridge.volume, 64);
});

test('unsupported messages, realtime and invalid bytes are never forwarded', () => {
  const { bridge, sent } = setup();
  for (const message of [[0xf8], [0xfe], [0xc2, 200], [0xd0, 100], [0xf0, 0, 0],
    [0xb0, 64, 127], [0xa0, 69, 100], [0x90, 200, 127], [0x90, 69, -1],
    [0x90, 69, 128], [0x90, 69.5, 100], [0x190, 69, 100]]) {
    assert.equal(bridge.receive(message), false);
  }
  assert.deepEqual(sent, []);
});

test('panic silences all four voices plus explicit ch1 Offs for the earlier PoC', () => {
  const { bridge, sent } = setup();
  bridge.receive([0x90, 69, 100]);
  sent.length = 0;
  bridge.panic();
  assert.deepEqual(sent.filter(m => m[0] === 0x80), Array.from({ length: NOTE_MAX - NOTE_MIN + 1 }, (_, i) => [0x80, NOTE_MIN + i, 0]));
  for (let ch = 0; ch < 4; ch++) assert(sent.some(m => m[0] === (0xb0 | ch) && m[1] === 120));
  assert.equal(bridge.notes.size, 0);
});

test('hardware All Notes Off / All Sound Off invokes explicit panic', () => {
  for (const controller of [120, 123]) {
    const { bridge, sent } = setup();
    bridge.receive([0x90, 69, 100]);
    bridge.receive([0xb0, controller, 0]);
    assert(sent.some(m => m[0] === 0x80 && m[1] === 69));
    assert.equal(bridge.current, null);
  }
});

test('pausing silences output and ignores new input until resumed', () => {
  const { bridge, sent } = setup();
  bridge.receive([0x90, 69, 100]);
  bridge.setEnabled(false);
  assert.equal(bridge.notes.size, 0);
  sent.length = 0;
  assert.equal(bridge.receive([0x90, 69, 100]), false);
  assert.deepEqual(sent, []);
  bridge.setEnabled(true);
  assert.equal(bridge.receive([0x90, 69, 100]), true);
});

test('output change sends Note Off to old port and requires re-enabling', () => {
  const { bridge, sent } = setup();
  bridge.noteOn('screen', 69, 100);
  const nextMessages = [];
  bridge.setOutput({ state: 'connected', send: m => nextMessages.push(m) });
  assert(sent.some(m => m[0] === 0x80 && m[1] === 69));
  assert.equal(bridge.enabled, false);
  assert.deepEqual(nextMessages, []);
});

test('input blur cleanup releases screen keys while keeping MIDI keyboard active', () => {
  const { bridge } = setup();
  bridge.noteOn('pc:a', 60, 100);
  bridge.receive([0x90, 69, 100]);
  bridge.releaseSources('pc:');
  assert.equal(bridge.current.note, 69);
  assert.equal(bridge.notes.size, 1);
});

test('a removed port and a send exception do not leave ghost held notes', () => {
  const { bridge, output, errors } = setup();
  bridge.noteOn('screen', 69, 100);
  output.send = () => { throw new Error('port disconnected'); };
  bridge.receive([0xe0, 0, 64]);
  assert.equal(bridge.enabled, false);
  assert.equal(bridge.current, null);
  assert.equal(errors.length, 1);
  bridge.panic();
  assert.equal(errors.length, 1);
});

test('invalid configuration and slider values cannot create invalid MIDI', () => {
  const { bridge, sent } = setup();
  bridge.configure({ transpose: 25 });
  bridge.configure({ inputChannel: 16 });
  bridge.setBend(16384);
  bridge.setVolume(-1);
  bridge.noteOn('bad', 69, 128);
  assert.equal(bridge.transpose, 0);
  assert.equal(bridge.inputChannel, 'all');
  assert.deepEqual(sent, []);
});

test('note labels follow MIDI convention', () => {
  assert.equal(noteName(69), 'A4');
  assert.equal(noteName(60), 'C4');
  assert.equal(noteName(61), 'C♯4');
  assert.equal(noteName(33), 'A1');
  assert.equal(noteName(108), 'C8');
});
