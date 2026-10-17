// Run with: node web-midi/tests/browser.mjs (Playwright in build-web-tools).
// MIDI ports are mocks; actual hardware is exercised manually in Windows.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(pathToFileURL(resolve(import.meta.dirname, '../../build-web-tools/node_modules/playwright/index.mjs')));
const directory = process.env.QA_OUTPUT || '/tmp/famidi-web-qa';
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || '/snap/bin/chromium', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1 });
const errors = [];
context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
await context.addInitScript(() => {
  window.midiSent = [];
  window.midiRequests = 0;
  function port(id, name, type) {
    return { id, name, type, state: 'connected', connection: 'closed', onmidimessage: null,
      async open() { this.connection = 'open'; window.midiAccess.onstatechange?.({ port: this }); return this; },
      async close() { this.connection = 'closed'; return this; },
      clear() {}, send(bytes) { window.midiSent.push({ port: this.id, bytes: [...bytes] }); } };
  }
  window.keyboardPort = port('oxygen', 'Oxygen 25', 'input');
  window.famidiPort = port('famidi', 'famidi Pulse 1', 'output');
  window.midiAccess = {
    inputs: new Map([['oxygen', window.keyboardPort]]),
    outputs: new Map([['famidi', window.famidiPort], ['other', port('other', 'Other output', 'output')]]),
    onstatechange: null,
  };
  Object.defineProperty(navigator, 'requestMIDIAccess', { configurable: true, value: async options => {
    window.midiRequests++;
    if (window.denyMidi) throw new DOMException('Permission denied', 'NotAllowedError');
    if (options.sysex !== false) throw new Error('Unexpected SysEx request');
    return window.midiAccess;
  } });
  window.playInput = bytes => window.keyboardPort.onmidimessage?.({ data: new Uint8Array(bytes) });
});

try {
  const page = await context.newPage();
  await page.goto(process.env.QA_URL || 'http://127.0.0.1:8765', { waitUntil: 'networkidle' });
  assert.equal(await page.title(), 'famidi — MIDI Console');
  assert.equal(await page.evaluate(() => window.midiRequests), 0);
  await page.screenshot({ path: `${directory}/desktop-disconnected.png`, fullPage: true });
  await page.locator('#connect').click();
  await page.waitForFunction(() => document.querySelector('#session-status').textContent === '演奏できます');
  assert.equal(await page.locator('#input-port').inputValue(), 'oxygen');
  assert.equal(await page.locator('#output-port').inputValue(), 'famidi');
  await page.evaluate(() => window.playInput([0x95, 69, 120]));
  await page.waitForFunction(() => document.querySelector('#current-note').textContent === 'A4');
  assert(await page.locator('[data-note="69"]').evaluate(el => el.classList.contains('active')));
  assert(await page.evaluate(() => window.midiSent.some(m => m.bytes.join() === '144,69,120')));
  await page.screenshot({ path: `${directory}/desktop-connected.png`, fullPage: true });
  await page.evaluate(() => window.playInput([0xe5, 127, 127]));
  await page.waitForFunction(() => document.querySelector('#bend-value').textContent === '+2.00');
  await page.evaluate(() => window.playInput([0x85, 69, 0]));
  await page.waitForFunction(() => document.querySelector('#current-note').textContent === '—');

  await page.locator('h1').click();
  await page.keyboard.down('a');
  await page.waitForFunction(() => document.querySelector('#current-note').textContent === 'C4');
  await page.keyboard.up('a');
  await page.waitForFunction(() => document.querySelector('#current-note').textContent === '—');
  await page.locator('[data-note="60"]').hover({ position: { x: 7, y: 130 } });
  await page.mouse.down();
  await page.waitForFunction(() => document.querySelector('#current-note').textContent === 'C4');
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('#current-note').textContent === '—');

  await page.evaluate(() => window.playInput([0x90, 69, 127]));
  await page.locator('#panic').click();
  await page.waitForFunction(() => document.querySelector('#held-count').textContent === '00');
  assert(await page.evaluate(() => window.midiSent.some(m => m.bytes.join() === '128,69,0')));
  await page.locator('#transpose-up').click();
  await page.evaluate(() => window.playInput([0x90, 69, 100]));
  await page.waitForFunction(() => document.querySelector('#current-note').textContent === 'A♯4');
  assert(await page.locator('[data-note="69"]').evaluate(el => el.classList.contains('active')));
  await page.evaluate(() => window.playInput([0x80, 69, 0]));
  await page.locator('#transpose-down').click();

  // Original preserves channel assignments; Poly adds allocation and Noise pads.
  await page.locator('#play-mode').selectOption('original');
  await page.evaluate(() => { window.midiSent.length = 0; for (let ch = 0; ch < 4; ch++) window.playInput([0x90 | ch, 69, 100]); });
  await page.waitForFunction(() => document.querySelectorAll('.voice-row.active').length === 4);
  assert(await page.evaluate(() => [0, 1, 2, 3].every(ch => window.midiSent.some(m => m.bytes.join() === `${0x90 | ch},69,100`))));
  await page.locator('#play-mode').selectOption('poly');
  await page.evaluate(() => { window.midiSent.length = 0; for (const n of [60, 64, 67]) window.playInput([0x90, n, 100]); window.playInput([0x99, 36, 110]); });
  await page.waitForFunction(() => document.querySelectorAll('.voice-row.active').length === 4);
  assert(await page.evaluate(() => window.midiSent.some(m => m.bytes.join() === '146,67,100') && window.midiSent.some(m => m.bytes.join() === '147,4,110')));
  await page.screenshot({ path: `${directory}/poly-four-voices.png`, fullPage: true });
  await page.locator('#preset').selectOption('oxygen'); await page.locator('#apply-preset').click();
  assert.equal(await page.getByLabel('割当4の入力CC', { exact: true }).inputValue(), '1');
  await page.evaluate(() => window.playInput([0xb0, 1, 127]));
  await page.waitForFunction(() => window.midiSent.some(m => m.bytes.join() === '176,70,96'));
  await page.locator('#filter-smoothing').fill('0'); await page.locator('#filter-smoothing').dispatchEvent('change');
  await page.locator('#add-mapping').click();
  const count = await page.locator('#cc-mappings tr').count();
  await page.getByLabel(`割当${count}の入力CC`, { exact: true }).fill('22');
  await page.getByLabel(`割当${count}の入力CC`, { exact: true }).dispatchEvent('change');
  await page.getByLabel(`割当${count}の操作`, { exact: true }).selectOption('expression');
  await page.getByLabel(`割当${count}の送信先`, { exact: true }).selectOption('1');
  await page.evaluate(() => window.playInput([0xb0, 22, 64]));
  await page.waitForFunction(() => window.midiSent.some(m => m.bytes.join() === '177,11,64'));
  assert((await page.locator('#activity-log').textContent()).includes('IN CC 22'));
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.locator('#play-mode').inputValue(), 'poly');
  assert.equal(await page.locator('#filter-smoothing').inputValue(), '0');
  assert.equal(await page.locator('#cc-mappings tr').count(), count);
  assert.equal(await page.evaluate(() => window.midiRequests), 0); // never auto-grant/open ports on reload
  await page.locator('#connect').click();
  await page.waitForFunction(() => Boolean(window.keyboardPort.onmidimessage));
  await page.evaluate(() => window.playInput([0xb0, 22, 64]));
  await page.waitForFunction(() => window.midiSent.some(m => m.bytes.join() === '177,11,64'));
  await page.locator('#preset').selectOption('standard'); await page.locator('#apply-preset').click();
  await page.locator('#play-mode').selectOption('mono');

  // A deliberate screen-only choice must survive Web MIDI's port-open events.
  await page.locator('#input-port').selectOption('');
  await page.waitForFunction(() => document.querySelector('#session-status').textContent === '演奏できます');
  assert.equal(await page.locator('#input-port').inputValue(), '');
  await page.locator('#test-tone').click();
  await page.waitForFunction(() => document.querySelector('#current-note').textContent === 'A4');
  await page.waitForFunction(() => document.querySelector('#current-note').textContent === '—');
  await page.locator('#input-port').selectOption('oxygen');
  await page.waitForFunction(() => Boolean(window.keyboardPort.onmidimessage));
  await page.evaluate(() => window.playInput([0x90, 69, 100]));
  await page.evaluate(() => { window.keyboardPort.state = 'disconnected'; window.midiAccess.onstatechange({ port: window.keyboardPort }); });
  await page.waitForFunction(() => document.querySelector('#session-status').textContent === '待機中');
  assert((await page.locator('#connection-help').textContent()).includes('接続が外れました'));
  assert.equal(await page.locator('#current-note').textContent(), '—');

  const mobile = await context.newPage();
  await mobile.setViewportSize({ width: 390, height: 844 });
  await mobile.goto(process.env.QA_URL || 'http://127.0.0.1:8765', { waitUntil: 'networkidle' });
  assert(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await mobile.screenshot({ path: `${directory}/mobile.png`, fullPage: true });

  const denied = await context.newPage();
  await denied.goto(process.env.QA_URL || 'http://127.0.0.1:8765');
  await denied.evaluate(() => { window.denyMidi = true; });
  await denied.locator('#connect').click();
  await denied.waitForFunction(() => document.querySelector('#connection-help').textContent.includes('許可されていません'));
  assert.equal(await denied.locator('#session-status').textContent(), '接続待ち');
  assert.deepEqual(errors, []);
  console.log('Browser QA passed: permission, routing, ch1, PC/pointer keyboard, panic, transpose, hotplug, screen-only, mobile, denial, Original/Poly, Noise pads, Oxygen/custom mapping, monitor and settings reload.');
  console.log(`Screenshots: ${directory}`);
} finally {
  await browser.close();
}
