'use strict';

// ── Storage (all access guarded: private mode / blocked storage) ──────────
const STORE_KEYS = {
  configYaml: 'bp_config_yaml',
  logoData:   'bp_logo_data',
  lastEntry:  'bp_last_entry',
  queue:      'bp_queue',
  ui:         'bp_ui',
  importMap:  'bp_import_map',
};

function storeGet(key, fallback = null) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v;
  } catch (_) { return fallback; }
}
function storeSet(key, value) {
  try { localStorage.setItem(key, value); return true; }
  catch (_) { return false; }
}
function storeDel(key) {
  try { localStorage.removeItem(key); } catch (_) {}
}
function storeGetJSON(key, fallback) {
  try { return JSON.parse(storeGet(key)) ?? fallback; } catch (_) { return fallback; }
}
function storeSetJSON(key, value) {
  return storeSet(key, JSON.stringify(value));
}

// ── Defaults filled in when a config omits them ───────────────────────────
const CONFIG_DEFAULTS = {
  canvas: { width_in: 4, height_in: 3, dpi: 250, rotate_output: 0, bleed_in: 0 },
  output: { color_mode: 'greyscale', bw_threshold: 160, bw_dither: false, filename: 'badge-{name}' },
  fonts:  { family: 'Arial, Helvetica, sans-serif' },
  vars:   {},
  fields: [],
  pronoun_options: [],
  pronoun_joiner: ' · ',
  elements: [],
};

const COLOR_MODES = ['greyscale', 'bw', 'color'];
const ELEMENT_TYPES = ['text', 'image', 'qr', 'line', 'rect'];

let defaultYamlText = '';

async function fetchDefaultYaml() {
  const res = await fetch('badge.yaml', { cache: 'no-cache' });
  if (!res.ok) throw new Error(`badge.yaml: HTTP ${res.status}`);
  defaultYamlText = await res.text();
  return defaultYamlText;
}

// Parse + validate YAML text. Throws Error with a readable message.
function parseConfigYaml(text) {
  let raw;
  try {
    raw = jsyaml.load(text);
  } catch (e) {
    throw new Error(`YAML syntax: ${e.reason || e.message}${e.mark ? ` (line ${e.mark.line + 1})` : ''}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Config must be a YAML mapping (key: value).');
  }
  return normalizeConfig(raw);
}

function normalizeConfig(raw) {
  const cfg = {
    ...CONFIG_DEFAULTS,
    ...raw,
    canvas: { ...CONFIG_DEFAULTS.canvas, ...(raw.canvas || {}) },
    output: { ...CONFIG_DEFAULTS.output, ...(raw.output || {}) },
    fonts:  { ...CONFIG_DEFAULTS.fonts,  ...(raw.fonts  || {}) },
    vars:   { ...(raw.vars || {}) },
  };

  const errors = [];
  const { canvas, output } = cfg;
  for (const k of ['width_in', 'height_in', 'dpi']) {
    if (!(Number(canvas[k]) > 0)) errors.push(`canvas.${k} must be a positive number`);
    canvas[k] = Number(canvas[k]);
  }
  if (canvas.width_in * canvas.dpi * canvas.height_in * canvas.dpi > 40e6) {
    errors.push('canvas is too large (width × height × dpi²); lower the dpi');
  }
  canvas.rotate_output = Number(canvas.rotate_output) || 0;
  if (![0, 90, 180, 270].includes(canvas.rotate_output)) errors.push('canvas.rotate_output must be 0, 90, 180 or 270');
  canvas.bleed_in = Number(canvas.bleed_in) || 0;
  if (!COLOR_MODES.includes(output.color_mode)) errors.push(`output.color_mode must be one of ${COLOR_MODES.join(', ')}`);
  output.bw_threshold = Math.max(0, Math.min(255, Number(output.bw_threshold) || 160));

  if (!Array.isArray(cfg.fields)) errors.push('fields must be a list');
  else cfg.fields.forEach((f, i) => {
    if (!f || typeof f.key !== 'string' || !f.key) errors.push(`fields[${i}] needs a key`);
  });
  if (!Array.isArray(cfg.pronoun_options)) errors.push('pronoun_options must be a list');
  cfg.pronoun_options = (cfg.pronoun_options || []).map(String);

  if (!Array.isArray(cfg.elements)) errors.push('elements must be a list');
  else cfg.elements.forEach((el, i) => {
    if (!el || !ELEMENT_TYPES.includes(el.type)) {
      errors.push(`elements[${i}].type must be one of ${ELEMENT_TYPES.join(', ')}`);
    }
  });

  if (errors.length) throw new Error(errors.join('\n'));
  return cfg;
}

function dumpConfigYaml(cfg) {
  return jsyaml.dump(cfg, { lineWidth: 120, flowLevel: 3, noRefs: true });
}

// Active config: saved override if valid, otherwise the shipped badge.yaml.
function loadActiveConfig() {
  const saved = storeGet(STORE_KEYS.configYaml);
  if (saved) {
    try { return { cfg: parseConfigYaml(saved), yaml: saved, custom: true }; }
    catch (e) { console.warn('Saved config invalid, using default:', e.message); }
  }
  return { cfg: parseConfigYaml(defaultYamlText), yaml: defaultYamlText, custom: false };
}

function saveConfigYaml(text) {
  storeSet(STORE_KEYS.configYaml, text);
}

function resetConfig() {
  storeDel(STORE_KEYS.configYaml);
}
