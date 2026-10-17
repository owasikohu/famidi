import { TARGETS, defaultMappings, oxygenMappings, defaultPads } from './control.js';
const $ = id => document.getElementById(id);
export const VOICES = ['Pulse 1', 'Pulse 2', 'Triangle', 'Noise'];
export function installControls(bridge, save, initialPreset = 'standard') {
  const preset = ['standard', 'oxygen', 'custom'].includes(initialPreset) ? initialPreset : 'standard';
  $('preset').value = preset;
  function select(choices, value, label, update) {
    const el = document.createElement('select');
    el.setAttribute('aria-label', label);
    for (const [key, text] of choices) {
      const option = document.createElement('option'); option.value = key; option.textContent = text; el.append(option);
    }
    el.value = String(value); el.addEventListener('change', () => update(el.value)); return el;
  }
  function number(value, max, label, update, min = 0) {
    const el = document.createElement('input');
    Object.assign(el, { type: 'number', min, max, value, step: 1, required: true }); el.setAttribute('aria-label', label);
    el.addEventListener('change', () => { if (el.checkValidity()) update(Number(el.value)); }); return el;
  }
  function remove(label, update) {
    const el = document.createElement('button'); el.type = 'button'; el.className = 'delete-row'; el.textContent = '×'; el.setAttribute('aria-label', label); el.addEventListener('click', update); return el;
  }
  function row(elements) {
    const tr = document.createElement('tr');
    for (const el of elements) { const td = document.createElement('td'); td.append(el); tr.append(td); }
    return tr;
  }
  function changeRows(key, rows) {
    if (!bridge.configure({ [key]: rows })) return;
    $('preset').value = 'custom'; drawTables(); save();
  }
  function drawTables() {
    $('cc-mappings').replaceChildren(...bridge.mappings.map((mapping, i) => {
      const update = (key, value) => { const rows = structuredClone(bridge.mappings); rows[i][key] = value; changeRows('mappings', rows); };
      const cc = number(mapping.cc, 127, `割当${i + 1}の入力CC`, value => update('cc', value));
      cc.disabled = mapping.source === 'bend';
      return row([
        select([['cc', 'CC'], ['bend', 'Pitch wheel']], mapping.source, `割当${i + 1}の入力`, value => update('source', value)), cc,
        select(Object.entries(TARGETS).map(([key, spec]) => [key, spec.label]), mapping.target, `割当${i + 1}の操作`, value => update('target', value)),
        select([['auto', '演奏モードに従う'], ['all', '全音源'], ...VOICES.map((name, ch) => [ch, name])], mapping.channel, `割当${i + 1}の送信先`, value => update('channel', ['auto', 'all'].includes(value) ? value : Number(value))),
        remove(`割当${i + 1}を削除`, () => changeRows('mappings', bridge.mappings.filter((_, n) => n !== i))),
      ]);
    }));
    $('pad-mappings').replaceChildren(...bridge.pads.map((pad, i) => {
      const update = (key, value) => { const rows = structuredClone(bridge.pads); rows[i][key] = value; changeRows('pads', rows); };
      return row([
        number(pad.channel + 1, 16, `Pad${i + 1}の入力ch`, value => update('channel', value - 1), 1),
        number(pad.note, 127, `Pad${i + 1}の入力Note`, value => update('note', value)),
        number(pad.noise, 127, `Pad${i + 1}のNoise Note`, value => update('noise', value)),
        remove(`Pad${i + 1}を削除`, () => changeRows('pads', bridge.pads.filter((_, n) => n !== i))),
      ]);
    }));
    $('add-mapping').disabled = bridge.mappings.length >= 64;
    $('add-pad').disabled = bridge.pads.length >= 128;
  }
  $('play-mode').value = bridge.mode;
  $('control-channel').value = String(bridge.controlChannel);
  $('play-mode').addEventListener('change', () => { bridge.configure({ mode: $('play-mode').value }); save(); });
  $('control-channel').addEventListener('change', () => {
    const value = $('control-channel').value;
    bridge.configure({ controlChannel: value === 'all' ? value : Number(value) }); save();
  });
  $('apply-preset').addEventListener('click', () => {
    if ($('preset').value === 'custom') return;
    bridge.configure({ mappings: $('preset').value === 'oxygen' ? oxygenMappings() : defaultMappings(), pads: defaultPads() });
    drawTables(); save();
  });
  $('add-mapping').addEventListener('click', () => changeRows('mappings', [...bridge.mappings, { source: 'cc', cc: 1, target: 'duty', channel: 'auto' }]));
  $('add-pad').addEventListener('click', () => changeRows('pads', [...bridge.pads, { channel: 9, note: 48, noise: 8 }]));
  for (const key of ['outlier', 'smoothing', 'hysteresis']) {
    const el = $(`filter-${key}`); el.value = bridge.filter[key];
    el.addEventListener('change', () => { if (el.checkValidity()) { bridge.configure({ filter: { ...bridge.filter, [key]: Number(el.value) } }); save(); } });
  }
  for (const [id, target, convert] of [
    ['expression', 'expression', el => Number(el.value)], ['duty', 'duty', el => Number(el.value)],
    ['sweep-on', 'sweepOn', el => el.checked ? 127 : 0], ['sweep-up', 'sweepUp', el => el.checked ? 127 : 0],
    ['sweep-time', 'sweepTime', el => Number(el.value) * 16], ['sweep-shift', 'sweepShift', el => Number(el.value) * 16],
  ]) $(id).addEventListener(id === 'expression' ? 'input' : 'change', () => {
    if ($(id).checkValidity()) { bridge.manualControl(target, convert($(id))); save(); }
  });
  drawTables();
  return {
    render() {
      $('control-channel').disabled = bridge.mode === 'poly';
      $('control-channel').value = bridge.mode === 'poly' ? 'poly' : String(bridge.controlChannel);
      const ch = bridge.mode === 'poly' || bridge.controlChannel === 'all' ? 0 : bridge.controlChannel;
      const state = bridge.controls[ch];
      $('mode-help').textContent = {
        original: 'Original互換：入力ch1–4をそのまま各音源へ。最後の音を優先し、離鍵で消音します。',
        mono: 'Mono：入力を選択した音源へ。離鍵すると、保持中の前の音へ戻ります。',
        poly: 'Poly：Pulse 1 / Pulse 2 / Triangleへ空き順に割当。満杯なら最も古い声を使い、離鍵で保持音を復帰。PadはNoiseへ。',
      }[bridge.mode];
      $('route-mode').textContent = { original: 'CH 1–4', mono: 'MONO', poly: '3-VOICE POLY' }[bridge.mode];
      $('route-voices').textContent = bridge.mode === 'original' ? '4 VOICES' : bridge.mode === 'poly' ? 'P1 / P2 / Tri' : VOICES[ch];
      $('voice-mode').textContent = bridge.mode.toUpperCase();
      $('key-priority').textContent = bridge.mode === 'poly' ? '3 VOICE ALLOCATION' : 'LAST NOTE PRIORITY';
      $('voice-channel').textContent = String((bridge.current?.channel ?? ch) + 1).padStart(2, '0');
      $('active-voice').textContent = VOICES[bridge.current?.channel ?? ch];
      $('voice-subtitle').textContent = bridge.mode === 'poly' ? 'PULSE / PULSE / TRIANGLE + NOISE' : '4 CHANNEL USB MIDI';
      $('voice-list').replaceChildren(...VOICES.map((name, channel) => {
        const voice = [...bridge.notes.values()].find(n => n.allocated && n.channel === channel);
        const el = document.createElement('div'); el.className = `voice-row${voice ? ' active' : ''}`;
        const title = document.createElement('span'); title.textContent = name;
        const value = document.createElement('span'); value.textContent = voice ? `${voice.note} / ${voice.velocity}` : '—';
        el.append(title, value); return el;
      }));
      const pulse = ch < 2 || bridge.mode === 'poly' || bridge.controlChannel === 'all';
      $('volume').max = ch < 2 ? 120 : 127; $('volume').step = ch < 2 ? 8 : 1;
      $('volume').value = ch < 2 ? Math.floor(state.volume / 8) * 8 : state.volume;
      $('volume-value').textContent = ch < 2 ? `${Math.floor(state.volume / 8)} / 15` : state.volume;
      $('expression').value = state.expression; $('expression-value').textContent = state.expression;
      $('duty').value = Math.floor(state.duty / 32) * 32;
      $('sweep-on').checked = state.sweepOn >= 64; $('sweep-up').checked = state.sweepUp >= 64;
      $('sweep-time').value = state.sweepTime >> 4; $('sweep-shift').value = state.sweepShift >> 4;
      for (const id of ['duty', 'sweep-on', 'sweep-up', 'sweep-time', 'sweep-shift']) $(id).disabled = !bridge.enabled || !pulse;
      $('expression').disabled = !bridge.enabled;
      $('bend').disabled = $('bend-center').disabled = !bridge.enabled || ch === 3 && bridge.mode !== 'poly' && bridge.controlChannel !== 'all';
      $('bend').value = state.bend - 8192;
    },
  };
}
