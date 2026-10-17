import { MidiBridge, noteName, playable } from './midi.js';

import { installControls } from './controls-ui.js';
import { loadSettings, restoreSettings, snapshot, saveSettings } from './settings.js';

const $ = id => document.getElementById(id);
const pcKeys = ['a', 'w', 's', 'e', 'd', 'f', 't', 'g', 'y', 'h', 'u', 'j', 'k'];
let access = null;
let input = null;
let busy = false;
let connectionRevision = 0;
let keyboardStart = 48;
let lastStateFrame = 0;
let noteTimer;
const pointers = new Map();
const messages = [];
let logFrame = 0;
const settings = (() => { try { const value = JSON.parse(localStorage.getItem('famidi-ports') || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; } })();
const saved = loadSettings({ getItem: key => localStorage.getItem(key) });
let saveTimer;
let controlsUI;
function rememberSession() {
  const ok = saveSettings({ setItem: (key, value) => localStorage.setItem(key, value) }, snapshot(bridge, { preset: $('preset').value, velocity: Number($('velocity').value), keyboardStart }));
  $('saved-state').textContent = ok ? 'このブラウザに保存済み' : '保存できません（演奏は可能）';
}
function scheduleSave() { if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; rememberSession(); }, 400); }

function help(message, type = '') {
  $('connection-help').textContent = message;
  $('connection-help').className = `connection-help ${type}`;
}

function fillRange(element) {
  const percent = (Number(element.value) - Number(element.min)) / (Number(element.max) - Number(element.min)) * 100;
  element.style.setProperty('--fill', `${percent}%`);
}

function logMessage(bytes, direction = 'OUT') {
  messages.unshift({ bytes, direction, at: new Date() });
  messages.length = Math.min(messages.length, 80);
  if (!logFrame) logFrame = requestAnimationFrame(drawLog);
}

function drawLog() {
  logFrame = 0;
  const fragment = document.createDocumentFragment();
  for (const { bytes: [status, first, second = 0], direction, at } of messages) {
    const row = document.createElement('div');
    row.className = 'log-row';
    const type = status & 0xf0;
    const label = { 0x90: 'NOTE ON', 0x80: 'NOTE OFF', 0xb0: `CC ${first}`, 0xe0: 'BEND', 0xc0: 'PROGRAM' }[type] || 'MIDI';
    const description = type === 0x90 || type === 0x80 ? `${noteName(first)} · ${first} · vel ${second}`
      : type === 0xb0 ? `Value ${second}` : type === 0xc0 ? `Duty ${first % 4}` : `${((first | (second << 7)) - 8192) / 4096 >= 0 ? '+' : ''}${(((first | (second << 7)) - 8192) / 4096).toFixed(2)} st`;
    for (const [className, value] of [
      ['log-time', at.toLocaleTimeString('ja-JP', { hour12: false })], ['log-type', `${direction} ${label}`],
      ['log-description', `ch${(status & 15) + 1} · ${description}`], ['log-bytes', [status, first, second].map(n => n.toString(16).padStart(2, '0').toUpperCase()).join(' ')],
    ]) {
      const span = document.createElement('span');
      span.className = className;
      span.textContent = value;
      row.append(span);
    }
    fragment.append(row);
  }
  if (!messages.length) {
    const empty = document.createElement('p');
    empty.className = 'log-empty';
    empty.textContent = '鍵盤を押すと、送信したMIDIメッセージがここに表示されます。';
    fragment.append(empty);
  }
  $('activity-log').replaceChildren(fragment);
}

const bridge = new MidiBridge({
  onState() {
    if (!lastStateFrame) lastStateFrame = requestAnimationFrame(render);
    scheduleSave();
  },
  onMessage: bytes => logMessage(bytes, 'OUT'),
  onInput: bytes => logMessage(bytes, 'IN'),
  onError(error) { help(`MIDIの送信に失敗しました。接続を確認して再接続してください。${error.message ? ` (${error.message})` : ''}`, 'error'); },
});

restoreSettings(bridge, saved);
if (Number.isInteger(saved.keyboardStart) && saved.keyboardStart >= 36 && saved.keyboardStart <= 72 && saved.keyboardStart % 12 === 0) keyboardStart = saved.keyboardStart;
if (Number.isInteger(saved.velocity) && saved.velocity >= 1 && saved.velocity <= 127) $('velocity').value = saved.velocity;
$('velocity-value').textContent = $('velocity').value;
controlsUI = installControls(bridge, rememberSession, saved.preset);
setInterval(() => bridge.tick(), 16);

function render() {
  lastStateFrame = 0;
  const running = bridge.enabled;
  const current = bridge.current;
  $('session-led').classList.toggle('connected', running);
  $('session-status').textContent = running ? '演奏できます' : access ? '待機中' : '接続待ち';
  $('session-detail').textContent = running ? `MIDI → famidi / ${bridge.mode.toUpperCase()}` : 'USB MIDIを接続してください';
  $('connect-label').textContent = busy ? '接続しています…' : running ? '転送を一時停止' : access ? '転送を開始' : 'MIDIに接続';
  $('connect').classList.toggle('is-running', running);
  $('connect').classList.toggle('busy', busy);
  $('connect').disabled = busy;
  for (const id of ['panic', 'test-tone', 'volume', 'bend', 'bend-center']) $(id).disabled = !running;
  $('current-note').textContent = current ? noteName(current.note) : '—';
  $('current-velocity').textContent = String(current?.velocity ?? 0).padStart(3, '0');
  $('velocity-meter').style.width = `${(current?.velocity ?? 0) / 127 * 100}%`;
  $('held-count').textContent = String(bridge.notes.size).padStart(2, '0');
  $('voice-dot').classList.toggle('active', Boolean(current));
  if (current) {
    const divisor = current.channel === 2 ? 32 : 16;
    const bend = bridge.controls[current.channel].bend;
    const target = 440 * 2 ** ((current.note - 69 + (bend - 8192) / 4096) / 12);
    const timer = Math.round((21477272 / 12) / (divisor * target) - 1);
    $('current-frequency').textContent = current.channel === 3 ? `NOISE ${current.note >= 64 ? "S" : "L"}${current.note % 16}` : timer >= 8 && timer <= 2047 ? `≈ ${((21477272 / 12) / (divisor * (timer + 1))).toFixed(1)} Hz` : '音域外 / SILENT';
  } else $('current-frequency').textContent = 'STANDBY';
  const held = new Set([...bridge.notes.values()].map(n => n.note));
  for (const key of $('keyboard').querySelectorAll('[data-note]')) {
    const note = Number(key.dataset.note) + bridge.transpose;
    key.classList.toggle('active', held.has(note));
    key.setAttribute('aria-pressed', String(held.has(note)));
    key.disabled = !running || !(bridge.mode === 'poly' ? [0, 1, 2].some(ch => playable(note, ch)) : playable(note, bridge.controlChannel === 'all' ? 0 : bridge.controlChannel));
  }
  controlsUI?.render();
  fillRange($('volume'));
  const semitones = Number($('bend').value) / 4096;
  $('bend-value').textContent = `${semitones > 0 ? '+' : ''}${semitones.toFixed(2)}`;
  $('transpose-value').textContent = bridge.transpose > 0 ? `+${bridge.transpose}` : bridge.transpose;
  $('transpose-down').disabled = bridge.transpose <= -24;
  $('transpose-up').disabled = bridge.transpose >= 24;
}

function rememberPorts() {
  Object.assign(settings, { input: $('input-port').value, output: $('output-port').value });
  try { localStorage.setItem('famidi-ports', JSON.stringify(settings)); } catch { /* private browsing */ }
}

function options(select, ports, placeholder, preferred) {
  const selected = select.value || preferred;
  const fragment = document.createDocumentFragment();
  const empty = document.createElement('option');
  empty.value = '';
  empty.textContent = placeholder;
  fragment.append(empty);
  for (const port of ports) {
    const option = document.createElement('option');
    option.value = port.id;
    option.textContent = port.name || 'MIDI device';
    fragment.append(option);
  }
  select.replaceChildren(fragment);
  if (ports.some(p => p.id === selected)) select.value = selected;
  select.disabled = false;
}

function refreshPorts() {
  if (!access) return;
  const inputs = [...access.inputs.values()].filter(p => p.state === 'connected');
  const outputs = [...access.outputs.values()].filter(p => p.state === 'connected');
  const bestInput = Object.hasOwn(settings, 'input') ? inputs.find(p => p.id === settings.input)
    : inputs.find(p => /oxygen/i.test(p.name || '')) || inputs.find(p => !/famidi/i.test(p.name || ''));
  const bestOutput = outputs.find(p => p.id === settings.output) || outputs.find(p => /famidi/i.test(p.name || ''));
  options($('input-port'), inputs, '画面の鍵盤のみ', bestInput?.id);
  options($('output-port'), outputs, '出力先を選択', bestOutput?.id);
  $('input-detail').textContent = inputs.length ? `${inputs.length}個の入力を検出` : 'MIDIキーボードを接続できます';
  $('output-detail').textContent = bestOutput ? 'USB MIDI出力を検出' : 'famidiをUSBで接続してください';
}

function cancelScreenNotes() {
  clearTimeout(noteTimer);
  bridge.releaseSources('test:');
  bridge.releaseSources('pc:');
  bridge.releaseSources('pointer:');
  bridge.releaseSources('accessible:');
  pointers.clear();
}

function panic() {
  clearTimeout(noteTimer);
  pointers.clear();
  bridge.panic();
}

function detachInput() {
  if (input) input.onmidimessage = null;
  input = null;
}

async function startRoute() {
  const revision = ++connectionRevision;
  cancelScreenNotes();
  bridge.setEnabled(false);
  detachInput();
  const output = access.outputs.get($('output-port').value);
  const selectedInput = access.inputs.get($('input-port').value);
  if (!output || output.state !== 'connected') throw new Error('MIDI出力に「famidi Pulse 1」を選んでください。');
  await output.open();
  if (selectedInput) await selectedInput.open();
  if (revision !== connectionRevision) return;
  bridge.setOutput(output);
  bridge.setEnabled(true);
  if (!bridge.enabled) throw new Error('MIDI出力を開けませんでした。');
  input = selectedInput || null;
  if (input) input.onmidimessage = event => bridge.receive(event.data, input.id);
  rememberPorts();
  help(input ? `${input.name} → ${output.name}。鍵盤を弾いてください。` : `${output.name}へ接続しました。画面またはPCの鍵盤で演奏できます。`, 'success');
}

$('connect').addEventListener('click', async () => {
  if (busy) return;
  if (bridge.enabled) {
    ++connectionRevision;
    cancelScreenNotes();
    bridge.setEnabled(false);
    detachInput();
    help('MIDI転送を一時停止しました。「転送を開始」で再開します。');
    return;
  }
  busy = true;
  render();
  try {
    if (!window.isSecureContext) throw new Error('Chrome / EdgeでHTTPS、または localhost のURLを開いてください。');
    if (!navigator.requestMIDIAccess) throw new Error('このブラウザはWeb MIDIに対応していません。Chrome / Edgeで開いてください。');
    if (!access) {
      access = await navigator.requestMIDIAccess({ sysex: false });
      access.onstatechange = event => {
        const port = event.port;
        if (port.state === 'disconnected' &&
            ((input && port.id === input.id && port.type === 'input') ||
             (bridge.output && port.id === bridge.output.id && port.type === 'output'))) {
          ++connectionRevision;
          panic();
          bridge.setEnabled(false);
          detachInput();
          help('MIDI機器の接続が外れました。接続し直して「転送を開始」を押してください。', 'error');
        }
        refreshPorts();
      };
    }
    refreshPorts();
    await startRoute();
  } catch (error) {
    const message = error.name === 'NotAllowedError'
      ? 'MIDIアクセスが許可されていません。ブラウザのサイト設定でMIDIを許可し、再接続してください。'
      : error.message || '接続できませんでした。USBとブラウザのMIDI権限を確認してください。';
    help(message, 'error');
  } finally {
    busy = false;
    render();
  }
});

for (const id of ['input-port', 'output-port']) $(id).addEventListener('change', async () => {
  const resume = bridge.enabled;
  ++connectionRevision;
  cancelScreenNotes();
  bridge.setEnabled(false);
  detachInput();
  rememberPorts();
  if (!resume || busy) return;
  busy = true;
  render();
  try { await startRoute(); } catch (error) { help(error.message, 'error'); }
  finally { busy = false; render(); }
});

for (let channel = 0; channel < 16; channel++) {
  const option = document.createElement('option');
  option.value = channel;
  option.textContent = `ch${channel + 1}`;
  $('input-channel').append(option);
}
$('input-channel').value = String(bridge.inputChannel);
$('input-channel').addEventListener('change', () => {
  cancelScreenNotes();
  bridge.configure({ inputChannel: $('input-channel').value === 'all' ? 'all' : Number($('input-channel').value) });
});
for (const [id, delta] of [['transpose-down', -1], ['transpose-up', 1]]) $(id).addEventListener('click', () => {
  cancelScreenNotes();
  bridge.configure({ transpose: bridge.transpose + delta });
});

function buildKeyboard() {
  const fragment = document.createDocumentFragment();
  let whiteIndex = 0;
  const black = new Set([1, 3, 6, 8, 10]);
  for (let note = keyboardStart; note < keyboardStart + 36; note++) {
    const isBlack = black.has(note % 12);
    const key = document.createElement('button');
    key.type = 'button';
    key.className = `piano-key ${isBlack ? 'black' : 'white'}`;
    key.dataset.note = note;
    key.setAttribute('aria-label', `${noteName(note)} MIDI ${note}`);
    key.setAttribute('aria-pressed', 'false');
    if (isBlack) key.style.left = `calc(${whiteIndex / 21 * 100}% - 1.4%)`;
    else whiteIndex++;
    const caption = document.createElement('span');
    caption.className = 'key-note';
    caption.textContent = note % 12 === 0 ? noteName(note) : '';
    key.append(caption);
    const pcIndex = note - (keyboardStart + 12);
    if (pcIndex >= 0 && pcIndex < pcKeys.length) {
      const letter = document.createElement('span');
      letter.className = 'pc-letter';
      letter.textContent = pcKeys[pcIndex].toUpperCase();
      key.append(letter);
    }
    key.addEventListener('click', event => {
      if (event.detail !== 0 || !bridge.enabled) return;
      clearTimeout(noteTimer);
      bridge.releaseSources('accessible:');
      const token = `accessible:${note}`;
      bridge.noteOn(token, note + bridge.transpose, Number($('velocity').value));
      noteTimer = setTimeout(() => bridge.noteOff(token), 220);
    });
    fragment.append(key);
  }
  $('keyboard').replaceChildren(fragment);
  $('octave-label').textContent = `${noteName(keyboardStart)} – ${noteName(keyboardStart + 35)}`;
  $('octave-down').disabled = keyboardStart <= 36;
  $('octave-up').disabled = keyboardStart >= 72;
  render();
}

function keyAt(event) {
  return document.elementFromPoint(event.clientX, event.clientY)?.closest('#keyboard [data-note]');
}
$('keyboard').addEventListener('pointerdown', event => {
  if (!bridge.enabled || (event.pointerType === 'mouse' && event.button !== 0)) return;
  const key = keyAt(event);
  if (!key) return;
  event.preventDefault();
  $('keyboard').setPointerCapture(event.pointerId);
  const token = `pointer:${event.pointerId}`;
  const note = Number(key.dataset.note);
  if (bridge.noteOn(token, note + bridge.transpose, Number($('velocity').value))) pointers.set(event.pointerId, { token, note });
});
$('keyboard').addEventListener('pointermove', event => {
  const active = pointers.get(event.pointerId);
  if (!active) return;
  const key = keyAt(event);
  const note = key ? Number(key.dataset.note) : null;
  if (note === active.note) return;
  bridge.noteOff(active.token);
  if (note !== null) bridge.noteOn(active.token, note + bridge.transpose, Number($('velocity').value));
  active.note = note;
});
for (const eventName of ['pointerup', 'pointercancel', 'lostpointercapture']) $('keyboard').addEventListener(eventName, event => {
  const active = pointers.get(event.pointerId);
  if (active) bridge.noteOff(active.token);
  pointers.delete(event.pointerId);
});
for (const [id, delta] of [['octave-down', -12], ['octave-up', 12]]) $(id).addEventListener('click', () => {
  cancelScreenNotes();
  keyboardStart = Math.max(36, Math.min(72, keyboardStart + delta));
  buildKeyboard();
  rememberSession();
});

const pressed = new Set();
window.addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); panic(); pressed.clear(); return; }
  if (event.ctrlKey || event.metaKey || event.altKey || event.target.closest('input,select,textarea,[contenteditable="true"]')) return;
  const key = event.key.toLowerCase();
  const index = pcKeys.indexOf(key);
  if (index < 0 || !bridge.enabled) return;
  event.preventDefault();
  if (event.repeat || pressed.has(key)) return;
  pressed.add(key);
  bridge.noteOn(`pc:${key}`, keyboardStart + 12 + index + bridge.transpose, Number($('velocity').value));
});
window.addEventListener('keyup', event => {
  const key = event.key.toLowerCase();
  pressed.delete(key);
  bridge.noteOff(`pc:${key}`);
});
window.addEventListener('blur', () => { cancelScreenNotes(); pressed.clear(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { cancelScreenNotes(); pressed.clear(); }
});
// Physical MIDI keeps working when the page loses focus. Leaving/freezing the
// page itself silences all four channels and flushes pending CC filters.
window.addEventListener('pagehide', () => { panic(); detachInput(); rememberSession(); });
document.addEventListener('freeze', panic);

$('panic').addEventListener('click', () => { panic(); pressed.clear(); });
$('test-tone').addEventListener('click', () => {
  clearTimeout(noteTimer);
  bridge.noteOn('test:A4', 69, Number($('velocity').value));
  noteTimer = setTimeout(() => bridge.noteOff('test:A4'), 650);
});
$('velocity').addEventListener('input', () => {
  $('velocity-value').textContent = $('velocity').value;
  fillRange($('velocity'));
  rememberSession();
});
$('volume').addEventListener('input', () => bridge.setVolume(Number($('volume').value)));
$('bend').addEventListener('input', () => bridge.setBend(Number($('bend').value) + 8192));
for (const event of ['pointerup', 'pointercancel', 'keyup']) $('bend').addEventListener(event, () => bridge.setBend(8192));
$('bend-center').addEventListener('click', () => bridge.setBend(8192));
$('clear-log').addEventListener('click', () => { messages.length = 0; drawLog(); });

fillRange($('velocity'));
buildKeyboard();
if (!navigator.requestMIDIAccess) help('Web MIDIに対応したChrome / Edgeで開いてください。', 'error');
else if (!window.isSecureContext) help('HTTPS、または localhost のURLで開いてください。', 'error');
