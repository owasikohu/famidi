import { TARGETS } from './control.js';
export const SETTINGS_KEY = 'famidi-settings-v2';
export function loadSettings(storage) {
  try {
    const value = JSON.parse(storage.getItem(SETTINGS_KEY) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}
export function restoreSettings(bridge, settings) {
  if (settings.config) bridge.configure(settings.config);
  if (Array.isArray(settings.controls) && settings.controls.length === 4) {
    settings.controls.forEach((state, ch) => {
      if (!state || typeof state !== 'object') return;
      for (const [target, spec] of Object.entries(TARGETS)) {
        const value = state[target];
        if (Number.isInteger(value) && value >= 0 && value <= (spec.bend ? 16383 : 127)) bridge.controls[ch][target] = value;
      }
    });
  }
}
export function snapshot(bridge, extra = {}) {
  return { ...extra, version: 2,
    config: { mode: bridge.mode, inputChannel: bridge.inputChannel, transpose: bridge.transpose,
      controlChannel: bridge.controlChannel, mappings: bridge.mappings, pads: bridge.pads, filter: bridge.filter },
    controls: bridge.controls.map(state => ({ ...state, bend: 8192 })),
  };
}
export function saveSettings(storage, value) {
  try { storage.setItem(SETTINGS_KEY, JSON.stringify(value)); return true; } catch { return false; }
}
