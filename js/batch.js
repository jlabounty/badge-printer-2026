'use strict';

// ── Entry normalization (shared by single form and CSV) ────────────────────
function normalizeUrl(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s;
  if (/^[\w-]+(\.[\w-]+)+(\/|$)/.test(s)) return 'https://' + s;
  return s;
}

function normalizeEntry(cfg, data) {
  const out = {};
  for (const f of cfg.fields) {
    let v = String(data[f.key] ?? '').trim();
    if (f.type === 'url') v = normalizeUrl(v);
    out[f.key] = v;
  }
  return out;
}

// ── CSV ────────────────────────────────────────────────────────────────────
// Clean up pasted text: drop a BOM and markdown code fences, straighten
// smart quotes (copying from a rendered page turns " into “ ”).
function cleanCsvText(text) {
  return String(text)
    .replace(/^\uFEFF/, '')
    .replace(/[\u201C\u201D\u201E]/g, '"')
    .split(/\r\n|\r|\n/)
    .filter(line => !/^\s*(```|~~~)/.test(line))
    .join('\n');
}

// Comma, tab (pasted from a spreadsheet or rendered table) or semicolon,
// whichever appears most often outside quotes on the first line.
function detectDelimiter(text) {
  const line = text.split('\n').find(l => l.trim()) || '';
  const counts = { ',': 0, '\t': 0, ';': 0 };
  let inQ = false;
  for (const ch of line) {
    if (ch === '"') inQ = !inQ;
    else if (!inQ && ch in counts) counts[ch]++;
  }
  const [best, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return n ? best : ',';
}

// RFC4180-ish: quoted fields, escaped quotes, delimiters/newlines in quotes.
function parseCsv(text, delim = ',') {
  const rows = [];
  let row = [], field = '', inQ = false;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQ) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field.trim() === '') { field = ''; inQ = true; }
    else if (ch === delim) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

const HEADER_ALIASES = {
  name:     ['fullname', 'attendee', 'attendeename', 'displayname', 'badgename', 'preferredname'],
  company:  ['organization', 'organisation', 'org', 'affiliation', 'employer', 'institution', 'school', 'university', 'chapter'],
  pronouns: ['pronoun', 'pronounsforbadge'],
  url:      ['linkedin', 'linkedinurl', 'website', 'profile', 'profileurl', 'link', 'qr', 'qrurl'],
  role:     ['banner', 'badgetype', 'type', 'ribbon', 'attendeetype', 'ticket', 'tickettype'],
};
const normHeader = h => String(h).toLowerCase().replace(/[^a-z0-9]/g, '');

// Map CSV header columns to field keys. Returns { map: {colIdx: key}, first, last }.
function mapHeaders(headers, cfg) {
  const map = {};
  let first = -1, last = -1;
  headers.forEach((h, i) => {
    const n = normHeader(h);
    if (['firstname', 'first', 'givenname'].includes(n)) first = i;
    if (['lastname', 'last', 'surname', 'familyname'].includes(n)) last = i;
    for (const f of cfg.fields) {
      const keys = [normHeader(f.key), normHeader(f.label || ''), ...(HEADER_ALIASES[f.key] || [])];
      if (keys.includes(n) && !Object.values(map).includes(f.key)) { map[i] = f.key; break; }
    }
  });
  return { map, first, last };
}

function csvToEntries(text, cfg) {
  const clean = cleanCsvText(text);
  const rows = parseCsv(clean, detectDelimiter(clean));
  if (!rows.length) throw new Error('No rows found.');
  // The header is the first row (of the first few) whose columns match any
  // field, so a stray title line above it doesn't break the import.
  const h = rows.slice(0, 5).findIndex(r => {
    const m = mapHeaders(r, cfg);
    return Object.keys(m.map).length || m.first >= 0;
  });
  if (h < 0) {
    const seen = rows[0].map(c => c.trim()).filter(Boolean).slice(0, 6).join(' | ');
    throw new Error(`No columns matched. Expected headers like: ${cfg.fields.map(f => f.key).join(', ')}. First row was: ${seen || '(empty)'}`);
  }
  const headers = rows[h];
  const data = rows.slice(h + 1);
  if (!data.length) throw new Error('Found the header row but no badge rows under it.');
  const { map, first, last } = mapHeaders(headers, cfg);
  const hasName = Object.values(map).includes('name');
  const pronounField = cfg.fields.find(f => f.type === 'pronouns');
  return data.map(cells => {
    const e = {};
    for (const [idx, key] of Object.entries(map)) e[key] = (cells[idx] ?? '').trim();
    if (!hasName && (first >= 0 || last >= 0)) {
      e.name = [cells[first], cells[last]].map(s => (s || '').trim()).filter(Boolean).join(' ');
    }
    if (pronounField && e[pronounField.key]) {
      e[pronounField.key] = mergePronouns(splitPronounText(e[pronounField.key]), cfg.pronoun_joiner);
    }
    return normalizeEntry(cfg, e);
  });
}

// ── Queue ──────────────────────────────────────────────────────────────────
const Batch = {
  rows: [],          // [{ id, data, printed }]
  current: 0,
  blobs: new Map(),  // id -> { sig, blob, url }
  renderToken: 0,
  hooks: null,       // { getConfig, onSelect(row), onEdit(index), status(msg) }

  init(hooks) {
    this.hooks = hooks;
    const saved = storeGetJSON(STORE_KEYS.queue, null);
    if (saved && Array.isArray(saved.rows)) {
      this.rows = saved.rows;
      this.current = Math.min(saved.current || 0, Math.max(0, this.rows.length - 1));
    }
  },

  save() {
    storeSetJSON(STORE_KEYS.queue, { rows: this.rows, current: this.current });
  },

  importEntries(entries) {
    let n = Date.now();
    for (const data of entries) this.rows.push({ id: String(n++), data, printed: false });
    if (this.rows.length === entries.length) this.current = 0;
    this.save();
    this.refresh();
  },

  clear() {
    for (const b of this.blobs.values()) URL.revokeObjectURL(b.url);
    this.blobs.clear();
    this.rows = [];
    this.current = 0;
    this.save();
    this.refresh();
  },

  unmarkAll() {
    this.rows.forEach(r => { r.printed = false; });
    this.save();
    this.renderList();
  },

  remove(i) {
    const [row] = this.rows.splice(i, 1);
    const b = this.blobs.get(row.id);
    if (b) { URL.revokeObjectURL(b.url); this.blobs.delete(row.id); }
    if (this.current >= this.rows.length) this.current = Math.max(0, this.rows.length - 1);
    this.save();
    this.refresh();
  },

  updateRow(i, data) {
    if (!this.rows[i]) return;
    this.rows[i].data = data;
    this.save();
    this.refresh();
  },

  select(i) {
    if (!this.rows.length) return;
    this.current = Math.max(0, Math.min(i, this.rows.length - 1));
    this.save();
    this.renderList();
    this.hooks.onSelect(this.rows[this.current]);
  },

  currentRow() { return this.rows[this.current] || null; },

  nextUnprinted(from) {
    for (let k = 1; k <= this.rows.length; k++) {
      const i = (from + k) % this.rows.length;
      if (!this.rows[i].printed) return i;
    }
    return -1;
  },

  markPrinted(i) {
    if (!this.rows[i]) return;
    this.rows[i].printed = true;
    this.save();
  },

  // Signature of what a row's PNG depends on.
  sig(row) { return this.hooks.configSig() + '|' + JSON.stringify(row.data); },

  readyBlob(row) {
    const b = row && this.blobs.get(row.id);
    return b && b.sig === this.sig(row) ? b : null;
  },

  allReady() { return this.rows.length > 0 && this.rows.every(r => this.readyBlob(r)); },

  // Render every stale row's PNG in the background (keeps share-all instant).
  async prerenderAll() {
    const token = ++this.renderToken;
    const cfg = this.hooks.getConfig();
    for (const row of [...this.rows]) {
      if (token !== this.renderToken) return;
      if (this.readyBlob(row)) continue;
      const sig = this.sig(row);
      const blob = await renderBadgeBlob(cfg, row.data);
      if (token !== this.renderToken) return;
      const old = this.blobs.get(row.id);
      if (old) URL.revokeObjectURL(old.url);
      this.blobs.set(row.id, { sig, blob, url: URL.createObjectURL(blob), filename: badgeFilename(cfg, row.data) });
      const img = document.querySelector(`.queue-row[data-id="${row.id}"] img`);
      if (img) img.src = this.blobs.get(row.id).url;
      await new Promise(r => setTimeout(r, 0));
    }
    this.hooks.onReady?.();
  },

  refresh() {
    this.renderList();
    const row = this.currentRow();
    this.hooks.onSelect(row);
    this.prerenderAll();
  },

  renderList() {
    const list = document.getElementById('queue-list');
    const printed = this.rows.filter(r => r.printed).length;
    document.getElementById('queue-count').textContent =
      this.rows.length ? `${printed}/${this.rows.length} printed` : '';
    list.innerHTML = '';
    if (!this.rows.length) {
      list.innerHTML = '<p class="empty-note">No badges queued. Import a CSV above.</p>';
      return;
    }
    this.rows.forEach((row, i) => {
      const el = document.createElement('div');
      el.className = 'queue-row' + (i === this.current ? ' current' : '') + (row.printed ? ' printed' : '');
      el.dataset.id = row.id;
      const b = this.readyBlob(row);
      el.innerHTML = `
        <span class="q-num">${i + 1}</span>
        <img alt="" ${b ? `src="${b.url}"` : ''}>
        <span class="q-text"><b></b><small></small></span>
        <span class="q-status" title="${row.printed ? 'Printed' : 'Not printed'}">${row.printed ? '✓' : ''}</span>
        <button type="button" class="q-btn q-edit" aria-label="Edit">Edit</button>
        <button type="button" class="q-btn q-del" aria-label="Remove">×</button>`;
      el.querySelector('b').textContent = row.data.name || '(no name)';
      el.querySelector('small').textContent = [row.data.company, row.data.role].filter(Boolean).join(' · ');
      el.addEventListener('click', e => {
        if (e.target.closest('.q-edit')) this.hooks.onEdit(i);
        else if (e.target.closest('.q-del')) this.remove(i);
        else this.select(i);
      });
      list.appendChild(el);
    });
    list.querySelector('.current')?.scrollIntoView({ block: 'nearest' });
  },
};
