'use strict';

// ── Column guessing ────────────────────────────────────────────────────────
const normHeader = h => String(h).toLowerCase().replace(/[^a-z0-9]/g, '');

// Exact header matches (normalized), checked before substring matches.
const HEADER_ALIASES = {
  name:     ['name', 'fullname', 'attendee', 'attendeename', 'displayname', 'badgename', 'preferredname', 'nameonbadge'],
  company:  ['company', 'organization', 'organisation', 'org', 'affiliation', 'employer', 'institution', 'school', 'university', 'chapter'],
  pronouns: ['pronouns', 'pronoun'],
  url:      ['url', 'linkedin', 'linkedinurl', 'website', 'profile', 'profileurl', 'link', 'qr', 'qrurl'],
  role:     ['role', 'banner', 'badgetype', 'type', 'ribbon', 'attendeetype', 'ticket', 'tickettype', 'category'],
};
// Substring matches, in priority order (e.g. a LinkedIn column beats "Website").
const HEADER_CONTAINS = {
  name:     ['nameonbadge', 'badgename', 'preferredname', 'fullname'],
  company:  ['affiliation', 'organization', 'organisation', 'company', 'employer', 'institution', 'university', 'school'],
  pronouns: ['pronoun'],
  url:      ['linkedin', 'website', 'url', 'profile'],
  role:     ['badgetype', 'attendeetype', 'tickettype', 'registrationtype', 'ticket', 'category', 'banner', 'role'],
};
const FIRST_NAME = ['firstname', 'first', 'givenname', 'preferredfirstname'];
const LAST_NAME = ['lastname', 'last', 'surname', 'familyname'];

function guessMapping(headers, cfg, saved = {}) {
  const norm = headers.map(normHeader);
  const used = new Set();
  const map = {};
  const take = i => { used.add(i); return i; };
  const savedCol = h => (h ? headers.findIndex((x, i) => x === h && !used.has(i)) : -1);

  for (const f of cfg.fields) {
    let i = savedCol(saved.fields?.[f.key]);
    if (i < 0) {
      const exact = [normHeader(f.key), normHeader(f.label || ''), ...(HEADER_ALIASES[f.key] || [])].filter(Boolean);
      i = norm.findIndex((n, k) => !used.has(k) && exact.includes(n));
    }
    if (i < 0) {
      for (const needle of HEADER_CONTAINS[f.key] || [normHeader(f.key)]) {
        i = norm.findIndex((n, k) => !used.has(k) && n.includes(needle));
        if (i >= 0) break;
      }
    }
    map[f.key] = i >= 0 ? take(i) : -1;
  }

  // Name split across First/Last columns.
  let lastCol = savedCol(saved.last);
  if (map.name === -1 || map.name === undefined) {
    const first = norm.findIndex((n, k) => !used.has(k) && FIRST_NAME.includes(n));
    if (first >= 0 && 'name' in map) map.name = take(first);
  }
  if (lastCol < 0 && map.name >= 0 && FIRST_NAME.includes(norm[map.name])) {
    lastCol = norm.findIndex((n, k) => !used.has(k) && LAST_NAME.includes(n));
  }
  return { map, lastCol };
}

function mappedCount(headers, cfg) {
  const { map } = guessMapping(headers, cfg);
  return Object.values(map).filter(i => i >= 0).length;
}

// The header is the row (among the first 10) that matches the most fields,
// so title rows above a spreadsheet's header are skipped.
function detectHeaderRow(rows, cfg) {
  let best = 0, bestScore = -1;
  rows.slice(0, 10).forEach((r, i) => {
    const score = mappedCount(r, cfg);
    if (score > bestScore) { best = i; bestScore = score; }
  });
  return best;
}

const BANNER_SYNONYMS = [
  [/speak|keynote|present|panel/i, 'speaker'],
  [/sponsor|exhibit|partner|vendor/i, 'sponsor'],
  [/organi[sz]|committee|board/i, 'organizer'],
  [/volunt/i, 'volunteer'],
  [/staff|crew/i, 'staff'],
];

// Map a ticket/category value to a banner option ('' = no banner).
function guessBanner(value, options, saved = {}) {
  if (Object.hasOwn(saved, value)) return saved[value];
  const opts = options.filter(Boolean);
  if (!opts.length) return '__keep__';
  const v = value.toLowerCase();
  const exact = opts.find(o => o.toLowerCase() === v);
  if (exact) return exact;
  const contained = opts.find(o => v.includes(o.toLowerCase()));
  if (contained) return contained;
  for (const [re, target] of BANNER_SYNONYMS) {
    if (re.test(value)) {
      const o = opts.find(x => x.toLowerCase() === target);
      if (o) return o;
    }
  }
  return '';
}

const FILTER_MODES = { is: 'is', contains: 'contains', not: 'is not', notcontains: "doesn't contain" };

function filterMatch(cell, mode, needle) {
  const v = String(cell ?? '').trim().toLowerCase();
  if (mode === 'contains') return v.includes(needle);
  if (mode === 'not') return v !== needle;
  if (mode === 'notcontains') return !v.includes(needle);
  return v === needle;
}

// Turn mapped rows into badge entries.
function buildEntries(rows, headerRow, st, cfg) {
  const data = rows.slice(headerRow + 1);
  const pronounField = cfg.fields.find(f => f.type === 'pronouns');
  const roleField = cfg.fields.find(f => f.key === 'role');
  const needle = st.filter.text.trim().toLowerCase();
  const entries = [];
  let skipped = 0, filtered = 0;
  for (const cells of data) {
    if (st.filter.col >= 0 && needle && !filterMatch(cells[st.filter.col], st.filter.mode, needle)) {
      filtered++;
      continue;
    }
    const e = {};
    for (const f of cfg.fields) {
      const i = st.map[f.key];
      e[f.key] = i >= 0 ? String(cells[i] ?? '').trim() : '';
    }
    if (st.lastCol >= 0 && 'name' in e) {
      e.name = [e.name, String(cells[st.lastCol] ?? '').trim()].filter(Boolean).join(' ');
    }
    if (pronounField && e[pronounField.key]) {
      e[pronounField.key] = mergePronouns(splitPronounText(e[pronounField.key]), cfg.pronoun_joiner);
    }
    if (roleField && e.role) {
      const target = st.roleValues[e.role] ?? guessBanner(e.role, roleField.options || []);
      e.role = target === '__keep__' ? e.role : target;
    }
    if (!String(e.name ?? '').trim()) { skipped++; continue; }
    entries.push(normalizeEntry(cfg, e));
  }
  return { entries, skipped, filtered };
}

// ── Mapping dialog ─────────────────────────────────────────────────────────
const Importer = {
  hooks: null,     // { getConfig, queueLength, onImport(entries, replace), status(msg) }
  st: null,

  init(hooks) {
    this.hooks = hooks;
    document.getElementById('btn-import-close').addEventListener('click', () => this.close());
    document.getElementById('btn-import-cancel').addEventListener('click', () => this.close());
    document.getElementById('import-backdrop').addEventListener('click', () => this.close());
    document.getElementById('btn-import-go').addEventListener('click', () => this.commit());
    const body = document.getElementById('import-body');
    body.addEventListener('change', e => this.onChange(e));
  },

  // sheets: [{ name, rows }]
  open(sheets, sourceName) {
    const cfg = this.hooks.getConfig();
    const usable = sheets.filter(s => s.rows.length);
    if (!usable.length) throw new Error('No rows found.');
    const saved = storeGetJSON(STORE_KEYS.importMap, {});
    this.st = {
      sheets: usable, sourceName, sheetIdx: 0, headerRow: 0,
      map: {}, lastCol: -1, roleValues: {}, filter: { col: -1, text: '', mode: 'is' },
      replace: !!saved.replace, saved,
    };
    // Prefer the sheet whose header matches the most fields.
    let best = -1;
    usable.forEach((s, i) => {
      const score = mappedCount(s.rows[detectHeaderRow(s.rows, cfg)], cfg);
      if (score > best) { best = score; this.st.sheetIdx = i; }
    });
    this.selectSheet(this.st.sheetIdx);
    document.getElementById('import-modal').classList.remove('hidden');
    document.getElementById('import-backdrop').classList.remove('hidden');
    document.body.classList.add('drawer-open');
  },

  close() {
    document.getElementById('import-modal').classList.add('hidden');
    document.getElementById('import-backdrop').classList.add('hidden');
    document.body.classList.remove('drawer-open');
    this.st = null;
  },

  rows() { return this.st.sheets[this.st.sheetIdx].rows; },
  headers() { return this.rows()[this.st.headerRow] || []; },

  selectSheet(i) {
    this.st.sheetIdx = i;
    this.st.headerRow = detectHeaderRow(this.rows(), this.hooks.getConfig());
    this.remap();
  },

  remap() {
    const st = this.st;
    const headers = this.headers();
    const g = guessMapping(headers, this.hooks.getConfig(), st.saved);
    st.map = g.map;
    st.lastCol = g.lastCol;
    const fh = st.saved.filter?.header;
    const fcol = fh ? headers.indexOf(fh) : -1;
    st.filter = { col: fcol, text: fcol >= 0 ? st.saved.filter.text || '' : '', mode: (fcol >= 0 && st.saved.filter.mode) || 'is' };
    st.roleValues = {};
    this.render();
  },

  onChange(e) {
    const t = e.target;
    const st = this.st;
    if (!st) return;
    const v = t.value;
    if (t.id === 'imp-sheet') return this.selectSheet(Number(v));
    if (t.id === 'imp-header') { st.headerRow = Number(v); return this.remap(); }
    if (t.dataset.field) st.map[t.dataset.field] = Number(v);
    else if (t.id === 'imp-last') st.lastCol = Number(v);
    else if (t.dataset.roleValue !== undefined) st.roleValues[t.dataset.roleValue] = v;
    else if (t.id === 'imp-filter-col') st.filter.col = Number(v);
    else if (t.id === 'imp-filter-text') st.filter.text = v;
    else if (t.id === 'imp-filter-mode') st.filter.mode = v;
    else if (t.id === 'imp-replace') st.replace = t.checked;
    this.render();
  },

  colLabel(i) {
    const letters = n => (n >= 26 ? letters(Math.floor(n / 26) - 1) : '') + String.fromCharCode(65 + (n % 26));
    const h = this.headers()[i] || '(no header)';
    const sample = this.rows().slice(this.st.headerRow + 1).map(r => r[i]).find(x => x && String(x).trim());
    const ex = sample ? ` (e.g. ${String(sample).slice(0, 28)}${String(sample).length > 28 ? '…' : ''})` : '';
    return `${letters(i)} · ${h}${ex}`;
  },

  columnSelect(attrs, selected, noneLabel = '— not used —') {
    const n = Math.max(this.headers().length, ...this.rows().slice(0, 20).map(r => r.length));
    let html = `<select ${attrs}><option value="-1">${escapeHtml(noneLabel)}</option>`;
    for (let i = 0; i < n; i++) {
      html += `<option value="${i}"${i === selected ? ' selected' : ''}>${escapeHtml(this.colLabel(i))}</option>`;
    }
    return html + '</select>';
  },

  render() {
    const st = this.st;
    const cfg = this.hooks.getConfig();
    const rows = this.rows();
    const roleField = cfg.fields.find(f => f.key === 'role');
    let html = '';

    // Source
    html += `<div class="field-group"><label>Source</label><p class="imp-source">${escapeHtml(st.sourceName)}</p>`;
    if (st.sheets.length > 1) {
      html += `<select id="imp-sheet">${st.sheets.map((s, i) =>
        `<option value="${i}"${i === st.sheetIdx ? ' selected' : ''}>Sheet: ${escapeHtml(s.name)} (${s.rows.length} rows)</option>`).join('')}</select>`;
    }
    html += `<label class="sub-label" for="imp-header">Header row</label><select id="imp-header">${rows.slice(0, 10).map((r, i) =>
      `<option value="${i}"${i === st.headerRow ? ' selected' : ''}>Row ${i + 1}: ${escapeHtml(r.filter(Boolean).slice(0, 4).join(' | ').slice(0, 60))}</option>`).join('')}</select></div>`;

    // Columns
    html += '<div class="field-group"><label>Columns</label>';
    for (const f of cfg.fields) {
      if (f.hidden) continue;
      html += `<div class="imp-row"><span class="imp-field">${escapeHtml(f.label || f.key)}</span>${this.columnSelect(`data-field="${escapeHtml(f.key)}"`, st.map[f.key])}</div>`;
      if (f.key === 'name') {
        html += `<div class="imp-row"><span class="imp-field sub">+ last name</span>${this.columnSelect('id="imp-last"', st.lastCol, '— none (name is one column) —')}</div>`;
      }
    }
    html += '</div>';

    // Banner values
    if (roleField && st.map.role >= 0) {
      const counts = new Map();
      for (const r of rows.slice(st.headerRow + 1)) {
        const v = String(r[st.map.role] ?? '').trim();
        if (v) counts.set(v, (counts.get(v) || 0) + 1);
      }
      const values = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);
      if (values.length) {
        const opts = (roleField.options || []).filter(Boolean);
        html += `<div class="field-group"><label>${escapeHtml(roleField.label || 'Banner')} for each value</label>`;
        for (const [v, n] of values) {
          const cur = st.roleValues[v] ?? guessBanner(v, roleField.options || [], st.saved.roleValues || {});
          st.roleValues[v] = cur;
          html += `<div class="imp-row"><span class="imp-field">${escapeHtml(v)} <small>×${n}</small></span><select data-role-value="${escapeHtml(v)}">` +
            `<option value=""${cur === '' ? ' selected' : ''}>No banner</option>` +
            opts.map(o => `<option value="${escapeHtml(o)}"${cur === o ? ' selected' : ''}>${escapeHtml(o)}</option>`).join('') +
            `<option value="__keep__"${cur === '__keep__' ? ' selected' : ''}>Use as-is: “${escapeHtml(v)}”</option></select></div>`;
        }
        html += '</div>';
      }
    }

    // Filter
    const off = st.filter.col < 0 ? ' disabled' : '';
    const filterValues = st.filter.col < 0 ? [] : [...new Set(rows.slice(st.headerRow + 1)
      .map(r => String(r[st.filter.col] ?? '').trim()).filter(Boolean))].slice(0, 50);
    html += `<div class="field-group"><label>Only include rows where</label><div class="imp-filter">` +
      this.columnSelect('id="imp-filter-col"', st.filter.col, '— all rows —') +
      `<select id="imp-filter-mode"${off}>${Object.entries(FILTER_MODES).map(([k, l]) =>
        `<option value="${k}"${k === st.filter.mode ? ' selected' : ''}>${l}</option>`).join('')}</select>` +
      `<input type="text" id="imp-filter-text" list="imp-filter-values" placeholder="value (e.g. Checked in)" value="${escapeHtml(st.filter.text)}"${off}>` +
      `<datalist id="imp-filter-values">${filterValues.map(v => `<option value="${escapeHtml(v)}">`).join('')}</datalist></div></div>`;

    // Preview
    const { entries, skipped, filtered } = buildEntries(rows, st.headerRow, st, cfg);
    const cols = cfg.fields.filter(f => !f.hidden);
    html += `<div class="field-group"><label>Preview</label><div class="imp-preview"><table><thead><tr>${cols.map(f =>
      `<th>${escapeHtml(f.label || f.key)}</th>`).join('')}</tr></thead><tbody>${entries.slice(0, 5).map(e =>
      `<tr>${cols.map(f => `<td>${escapeHtml(e[f.key] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    const notes = [];
    if (skipped) notes.push(`${skipped} skipped (no name)`);
    if (filtered) notes.push(`${filtered} filtered out`);
    html += `<p class="field-hint">${entries.length} badge${entries.length === 1 ? '' : 's'}${notes.length ? ` · ${notes.join(' · ')}` : ''}${entries.length > 5 ? ' · showing first 5' : ''}</p></div>`;

    if (this.hooks.queueLength() > 0) {
      html += `<label class="checkbox-row"><input type="checkbox" id="imp-replace"${st.replace ? ' checked' : ''}><span>Replace the current queue (${this.hooks.queueLength()} badges) instead of adding</span></label>`;
    }

    const body = document.getElementById('import-body');
    const scroll = body.scrollTop;
    body.innerHTML = html;
    body.scrollTop = scroll;
    const go = document.getElementById('btn-import-go');
    go.textContent = `Import ${entries.length} badge${entries.length === 1 ? '' : 's'}`;
    go.disabled = !entries.length;
  },

  commit() {
    const st = this.st;
    if (!st) return;
    const cfg = this.hooks.getConfig();
    const headers = this.headers();
    const { entries } = buildEntries(this.rows(), st.headerRow, st, cfg);
    if (!entries.length) return;
    // Remember choices by header text so the next export maps itself.
    const fields = {};
    for (const [k, i] of Object.entries(st.map)) if (i >= 0 && headers[i]) fields[k] = headers[i];
    storeSetJSON(STORE_KEYS.importMap, {
      fields,
      last: st.lastCol >= 0 ? headers[st.lastCol] : '',
      roleValues: { ...(st.saved.roleValues || {}), ...st.roleValues },
      filter: st.filter.col >= 0 && st.filter.text ? { header: headers[st.filter.col], text: st.filter.text, mode: st.filter.mode } : null,
      replace: st.replace,
    });
    const replace = st.replace && this.hooks.queueLength() > 0;
    this.close();
    this.hooks.onImport(entries, replace);
  },
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Read a dropped/picked file into sheets: .xlsx natively, otherwise as text.
async function fileToSheets(file) {
  const buf = await file.arrayBuffer();
  if (isLegacyXls(buf)) throw new Error('Old .xls files aren\'t supported. In Excel, use Save As → .xlsx or .csv.');
  if (isZipBuffer(buf)) return readXlsx(buf);
  return [{ name: file.name, rows: textToRows(new TextDecoder().decode(buf)) }];
}
