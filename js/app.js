'use strict';

const app = {
  cfg: null,
  yaml: '',
  custom: false,
  configVersion: 0,
  mode: 'single',
  pronounPicker: null,
  editingRow: null,     // queue index being edited in the single form
  stashedEntry: null,   // single-form contents saved while editing a row
  single: null,         // { sig, blob, filename } pre-rendered PNG for the share button
  renderTimer: null,
  renderToken: 0,
};

const $ = id => document.getElementById(id);

// ── Config ─────────────────────────────────────────────────────────────────
// Apply YAML text (null = back to default). Throws if invalid.
function applyConfigYaml(text) {
  let cfg, yaml, custom;
  if (text === null) {
    cfg = parseConfigYaml(defaultYamlText); yaml = defaultYamlText; custom = false;
  } else {
    cfg = parseConfigYaml(text); yaml = text; custom = true;
    saveConfigYaml(text);
  }
  const entry = app.cfg ? readForm() : null;
  const pronounState = app.pronounPicker?.getState();
  app.cfg = cfg; app.yaml = yaml; app.custom = custom;
  app.configVersion++;
  buildForm();
  if (entry) fillForm(entry, pronounState);
  scheduleRender(0);
  if (app.mode === 'batch') Batch.refresh();
}

const configSig = () => String(app.configVersion) + (storeGet(STORE_KEYS.logoData) || '').length;

// ── Form ───────────────────────────────────────────────────────────────────
function buildForm() {
  const form = $('badge-form');
  form.innerHTML = '';
  app.pronounPicker = null;

  for (const f of app.cfg.fields) {
    if (f.hidden) continue;
    const group = document.createElement('div');
    group.className = 'field-group';
    const id = `f-${f.key}`;
    const label = document.createElement('label');
    label.htmlFor = id;
    label.textContent = (f.label || f.key) + (f.required ? ' *' : '');
    group.appendChild(label);

    if (f.type === 'pronouns') {
      label.removeAttribute('for');
      const box = document.createElement('div');
      box.id = id;
      group.appendChild(box);
      app.pronounPicker = createPronounPicker(box, {
        options: app.cfg.pronoun_options,
        joiner: app.cfg.pronoun_joiner,
        onChange: () => onFormChange(),
      });
    } else if (f.type === 'select') {
      const sel = document.createElement('select');
      sel.id = id;
      sel.dataset.key = f.key;
      for (const opt of f.options || []) {
        const o = document.createElement('option');
        o.value = opt;
        o.textContent = opt === '' ? 'None' : opt;
        sel.appendChild(o);
      }
      if (f.allow_custom) {
        const o = document.createElement('option');
        o.value = '__custom__';
        o.textContent = 'Other (type it)…';
        sel.appendChild(o);
      }
      group.appendChild(sel);
      const custom = document.createElement('input');
      custom.type = 'text';
      custom.className = 'select-custom hidden';
      custom.placeholder = `Custom ${(f.label || f.key).toLowerCase()}`;
      custom.dataset.customFor = f.key;
      group.appendChild(custom);
      sel.addEventListener('change', () => {
        custom.classList.toggle('hidden', sel.value !== '__custom__');
        if (sel.value === '__custom__') custom.focus();
        onFormChange();
      });
      custom.addEventListener('input', onFormChange);
    } else {
      const input = document.createElement(f.type === 'textarea' ? 'textarea' : 'input');
      input.id = id;
      input.dataset.key = f.key;
      if (f.type === 'url') {
        input.type = 'url';
        input.inputMode = 'url';
        input.autocapitalize = 'none';
        input.spellcheck = false;
      } else if (f.type !== 'textarea') {
        input.type = 'text';
        input.autocapitalize = f.key === 'name' ? 'words' : 'sentences';
      }
      if (f.placeholder) input.placeholder = f.placeholder;
      input.addEventListener('input', onFormChange);
      group.appendChild(input);
    }
    if (f.hint) {
      const hint = document.createElement('p');
      hint.className = 'field-hint';
      hint.textContent = f.hint;
      group.appendChild(hint);
    }
    form.appendChild(group);
  }
}

function readForm() {
  const data = {};
  for (const f of app.cfg.fields) {
    if (f.hidden) { data[f.key] = ''; continue; }
    if (f.type === 'pronouns') { data[f.key] = app.pronounPicker ? app.pronounPicker.value() : ''; continue; }
    const el = document.querySelector(`#badge-form [data-key="${f.key}"]`);
    if (!el) continue;
    if (f.type === 'select' && el.value === '__custom__') {
      data[f.key] = document.querySelector(`#badge-form [data-custom-for="${f.key}"]`).value;
    } else data[f.key] = el.value;
  }
  return data;
}

function fillForm(data, pronounState) {
  for (const f of app.cfg.fields) {
    if (f.hidden) continue;
    const v = data[f.key] ?? '';
    if (f.type === 'pronouns') {
      if (!app.pronounPicker) continue;
      if (pronounState) app.pronounPicker.setState(pronounState);
      else app.pronounPicker.set(v);
      continue;
    }
    const el = document.querySelector(`#badge-form [data-key="${f.key}"]`);
    if (!el) continue;
    if (f.type === 'select') {
      const custom = document.querySelector(`#badge-form [data-custom-for="${f.key}"]`);
      const known = (f.options || []).find(o => o.toLowerCase() === String(v).toLowerCase());
      if (known !== undefined) { el.value = known; custom.value = ''; custom.classList.add('hidden'); }
      else if (f.allow_custom) { el.value = '__custom__'; custom.value = v; custom.classList.remove('hidden'); }
      else el.value = '';
    } else el.value = v;
  }
}

function onFormChange() {
  if (app.editingRow === null && $('remember-checkbox').checked) {
    storeSetJSON(STORE_KEYS.lastEntry, { data: readForm(), pronouns: app.pronounPicker?.getState() });
  }
  scheduleRender();
}

function clearForm() {
  fillForm({}, null);
  app.pronounPicker?.clear();
  if ($('remember-checkbox').checked) storeDel(STORE_KEYS.lastEntry);
  scheduleRender(0);
  document.querySelector('#badge-form input')?.focus();
}

function missingRequired(data) {
  return app.cfg.fields.find(f => f.required && !f.hidden && !String(data[f.key] || '').trim());
}

// ── Rendering ──────────────────────────────────────────────────────────────
function currentData() {
  if (app.mode === 'batch' && app.editingRow === null) return Batch.currentRow()?.data || null;
  return normalizeEntry(app.cfg, readForm());
}

function scheduleRender(delay = 120) {
  clearTimeout(app.renderTimer);
  app.renderTimer = setTimeout(renderPreview, delay);
}

async function renderPreview() {
  const token = ++app.renderToken;
  const cfg = app.cfg;
  const data = currentData() || {};
  await preloadImages(cfg);
  if (token !== app.renderToken) return;
  const canvas = $('badge-canvas');
  const warnings = renderBadge(canvas, cfg, data);
  const warnEl = $('render-warnings');
  warnEl.textContent = [...new Set(warnings)].join(' ');
  warnEl.classList.toggle('hidden', !warnings.length);

  // Pre-build the PNG so Share can call navigator.share inside the tap.
  const sig = configSig() + '|' + JSON.stringify(data);
  const blob = await canvasToBlob(exportCanvas(canvas, cfg));
  if (token !== app.renderToken) return;
  app.single = { sig, blob, filename: badgeFilename(cfg, data) };
}

async function getSingleBlob() {
  const data = normalizeEntry(app.cfg, readForm());
  const sig = configSig() + '|' + JSON.stringify(data);
  if (app.single && app.single.sig === sig) return app.single;
  await renderPreview();
  return app.single;
}

function status(msg) {
  $('status-note').textContent = msg || '';
}

// ── Single actions ─────────────────────────────────────────────────────────
function checkRequired() {
  const missing = missingRequired(readForm());
  if (!missing) return true;
  status(`Please fill in ${missing.label || missing.key}.`);
  document.querySelector(`#badge-form [data-key="${missing.key}"]`)?.focus();
  return false;
}

async function onShareSingle() {
  if (!checkRequired()) return;
  const data = normalizeEntry(app.cfg, readForm());
  const sig = configSig() + '|' + JSON.stringify(data);
  // Fast path: blob already built, so share runs synchronously in the gesture.
  const item = app.single && app.single.sig === sig ? app.single : await getSingleBlob();
  try {
    const r = await shareFiles([item], `Badge: ${data.name || ''}`);
    if (r === 'unsupported') { downloadBlob(item.blob, item.filename); status('Sharing not available, so the PNG was downloaded.'); }
    else if (r === 'shared') status('Sent to printer app.');
  } catch (e) {
    status(`Share failed: ${e.message}. Try Download instead.`);
  }
}

async function onDownloadSingle() {
  if (!checkRequired()) return;
  const item = await getSingleBlob();
  downloadBlob(item.blob, item.filename);
}

// ── Batch actions ──────────────────────────────────────────────────────────
async function rowItem(row) {
  const ready = Batch.readyBlob(row);
  if (ready) return ready;
  const blob = await renderBadgeBlob(app.cfg, row.data);
  return { blob, filename: badgeFilename(app.cfg, row.data) };
}

async function onShareNext() {
  const row = Batch.currentRow();
  if (!row) { status('Queue is empty. Import a CSV first.'); return; }
  const i = Batch.current;
  const item = await rowItem(row);
  try {
    const r = await shareFiles([item], `Badge: ${row.data.name || ''}`);
    if (r === 'cancelled') return;
    if (r === 'unsupported') downloadBlob(item.blob, item.filename);
    Batch.markPrinted(i);
    const next = Batch.nextUnprinted(i);
    if (next < 0) { Batch.renderList(); status('All badges in the queue are marked printed.'); }
    else { Batch.select(next); status(`Badge ${i + 1} sent. Next up: ${next + 1}.`); }
  } catch (e) {
    status(`Share failed: ${e.message}`);
  }
}

async function onShareAll() {
  if (!Batch.rows.length) { status('Queue is empty.'); return; }
  if (!Batch.allReady()) { status('Still preparing badge images… try again in a moment.'); Batch.prerenderAll(); return; }
  let rows = Batch.rows.filter(r => !r.printed);
  if (!rows.length) rows = Batch.rows;
  const items = rows.map(r => Batch.readyBlob(r));
  try {
    const r = await shareFiles(items, `${items.length} badges`);
    if (r === 'unsupported') { status('This browser or app can\'t share several files at once. Use Share & next.'); return; }
    if (r === 'shared') {
      rows.forEach(row => Batch.markPrinted(Batch.rows.indexOf(row)));
      Batch.renderList();
      status(`Shared ${items.length} badges.`);
    }
  } catch (e) {
    status(`Share all failed (${e.message}). The printer app may only accept one image; use Share & next.`);
  }
}

async function onDownloadAll() {
  if (!Batch.rows.length) { status('Queue is empty.'); return; }
  const files = [];
  for (let i = 0; i < Batch.rows.length; i++) {
    status(`Preparing ${i + 1}/${Batch.rows.length}…`);
    const item = await rowItem(Batch.rows[i]);
    files.push({ name: `${String(i + 1).padStart(3, '0')}-${item.filename}`, blob: item.blob });
  }
  const zip = await buildZip(files);
  const day = new Date().toISOString().slice(0, 10);
  downloadBlob(zip, `badges-${day}.zip`);
  status(`Downloaded ${files.length} badges as a zip.`);
}

async function importCsvText(text) {
  try {
    const entries = csvToEntries(text, app.cfg);
    Batch.importEntries(entries);
    status(`Imported ${entries.length} badge${entries.length === 1 ? '' : 's'}.`);
    $('csv-paste-box').classList.add('hidden');
  } catch (e) {
    status(`CSV import failed: ${e.message}`);
  }
}

// ── Editing queue rows in the single form ──────────────────────────────────
function editRow(i) {
  const row = Batch.rows[i];
  if (!row) return;
  app.stashedEntry = { data: readForm(), pronouns: app.pronounPicker?.getState() };
  app.editingRow = i;
  fillForm(row.data, null);
  $('edit-row-num').textContent = i + 1;
  $('edit-row-note').classList.remove('hidden');
  setMode('single', true);
}

function finishEdit(save) {
  const i = app.editingRow;
  if (i === null) return;
  if (save) Batch.updateRow(i, normalizeEntry(app.cfg, readForm()));
  app.editingRow = null;
  $('edit-row-note').classList.add('hidden');
  if (app.stashedEntry) fillForm(app.stashedEntry.data, app.stashedEntry.pronouns);
  app.stashedEntry = null;
  setMode('batch');
  Batch.select(i);
}

// ── Mode ───────────────────────────────────────────────────────────────────
function setMode(mode, keepEditing = false) {
  if (!keepEditing && app.editingRow !== null) finishEdit(false);
  app.mode = mode;
  document.querySelectorAll('.format-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  const editing = app.editingRow !== null;
  $('single-section').classList.toggle('hidden', mode !== 'single');
  $('batch-section').classList.toggle('hidden', mode !== 'batch');
  $('single-actions').classList.toggle('hidden', mode !== 'single' || editing);
  $('batch-actions').classList.toggle('hidden', mode !== 'batch');
  storeSetJSON(STORE_KEYS.ui, { ...storeGetJSON(STORE_KEYS.ui, {}), mode });
  status('');
  if (mode === 'batch') Batch.refresh();
  else scheduleRender(0);
}

// ── Init ───────────────────────────────────────────────────────────────────
async function init() {
  try {
    await fetchDefaultYaml();
  } catch (e) {
    if (!storeGet(STORE_KEYS.configYaml)) {
      const err = $('load-error');
      err.textContent = `Could not load badge.yaml (${e.message}). Serve this folder over http(s), e.g. "python3 -m http.server".`;
      err.classList.remove('hidden');
      return;
    }
  }
  let active;
  try { active = loadActiveConfig(); }
  catch (e) {
    const err = $('load-error');
    err.textContent = `badge.yaml is invalid: ${e.message}`;
    err.classList.remove('hidden');
    return;
  }
  app.cfg = active.cfg; app.yaml = active.yaml; app.custom = active.custom;
  buildForm();

  const ui = storeGetJSON(STORE_KEYS.ui, {});
  $('remember-checkbox').checked = !!ui.remember;
  if (ui.remember) {
    const last = storeGetJSON(STORE_KEYS.lastEntry, null);
    if (last) fillForm(last.data || {}, last.pronouns);
  }
  $('remember-checkbox').addEventListener('change', e => {
    storeSetJSON(STORE_KEYS.ui, { ...storeGetJSON(STORE_KEYS.ui, {}), remember: e.target.checked });
    if (e.target.checked) onFormChange(); else storeDel(STORE_KEYS.lastEntry);
  });

  Batch.init({
    getConfig: () => app.cfg,
    configSig,
    onSelect: () => { if (app.mode === 'batch') scheduleRender(0); },
    onEdit: editRow,
  });

  Settings.init({
    getConfig: () => app.cfg,
    getYaml: () => app.yaml,
    isCustom: () => app.custom,
    apply: applyConfigYaml,
  });

  document.querySelectorAll('.format-btn').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('btn-clear').addEventListener('click', clearForm);
  $('btn-share').addEventListener('click', onShareSingle);
  $('btn-download').addEventListener('click', onDownloadSingle);
  $('btn-batch-share-next').addEventListener('click', onShareNext);
  $('btn-batch-share-all').addEventListener('click', onShareAll);
  $('btn-batch-download-all').addEventListener('click', onDownloadAll);
  $('btn-edit-save').addEventListener('click', () => finishEdit(true));
  $('btn-edit-cancel').addEventListener('click', () => finishEdit(false));
  $('btn-queue-clear').addEventListener('click', () => { if (confirm('Remove all badges from the queue?')) Batch.clear(); });
  $('btn-queue-reset').addEventListener('click', () => Batch.unmarkAll());
  $('btn-csv-paste-toggle').addEventListener('click', () => $('csv-paste-box').classList.toggle('hidden'));
  $('btn-csv-import').addEventListener('click', () => importCsvText($('csv-paste').value));
  $('csv-file').addEventListener('change', async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) importCsvText(await f.text());
  });

  const shareOk = canShareFiles();
  $('btn-share').classList.toggle('hidden', !shareOk);
  $('btn-batch-share-next').textContent = shareOk ? 'Share & next' : 'Download & next';
  $('btn-batch-share-all').classList.toggle('hidden', !shareOk);
  $('share-note').classList.toggle('hidden', shareOk);

  setMode(ui.mode === 'batch' ? 'batch' : 'single');

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', init);
