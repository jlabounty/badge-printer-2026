'use strict';

// ── Merging ────────────────────────────────────────────────────────────────
// Selected pronoun sets that share a form are merged into one deduplicated
// slash set, subject forms first, then the remaining forms:
//   ["he/they", "she/they", "they/them"] -> "he/she/they/them"
// Sets with nothing in common stay separate, joined with `joiner`:
//   ["she/they", "fae/faer"]             -> "she/they · fae/faer"
// Phrases without a slash ("any pronouns", "ask me") are their own unit.
//
// The result is a list of units { key, text, group, slash } so the picker can
// reorder them; formatUnits() turns units back into the badge string.
function mergeUnits(entries) {
  const sets = [];   // { index, tokens[] } for slash entries, { index, phrase } otherwise
  entries.forEach((raw, index) => {
    const entry = String(raw || '').trim();
    if (!entry) return;
    if (entry.includes('/')) {
      const tokens = entry.split('/').map(t => t.trim()).filter(Boolean);
      if (tokens.length) sets.push({ index, tokens });
    } else {
      sets.push({ index, phrase: entry });
    }
  });

  // Union slash sets that share any form (case-insensitive).
  const parent = sets.map((_, i) => i);
  const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const owner = new Map();   // token key -> set index
  sets.forEach((s, i) => {
    if (!s.tokens) return;
    for (const t of s.tokens) {
      const k = t.toLowerCase();
      if (owner.has(k)) parent[find(i)] = find(owner.get(k));
      else owner.set(k, i);
    }
  });

  // Groups in order of first appearance.
  const groups = new Map();  // root -> [sets]
  sets.forEach((s, i) => {
    const r = s.tokens ? find(i) : `p${i}`;
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(s);
  });

  const units = [];
  const seenPhrase = new Set();
  let g = 0;
  for (const members of groups.values()) {
    if (members[0].phrase !== undefined) {
      const k = members[0].phrase.toLowerCase();
      if (!seenPhrase.has(k)) {
        seenPhrase.add(k);
        units.push({ key: k, text: members[0].phrase, group: g, slash: false });
      }
      g++;
      continue;
    }
    const subjects = [], others = [], seen = new Set();
    for (const s of members) {
      s.tokens.forEach((t, i) => {
        const k = t.toLowerCase();
        if (seen.has(k)) return;
        seen.add(k);
        (i === 0 ? subjects : others).push(t);
      });
    }
    for (const t of [...subjects, ...others]) units.push({ key: t.toLowerCase(), text: t, group: g, slash: true });
    g++;
  }
  return units;
}

// Order units by a saved key order while keeping each group's forms together:
// groups sort by their best-ranked form, forms sort within their group.
// Keys missing from the order keep their default position after ranked ones.
function orderUnits(units, order) {
  if (!order || !order.length) return units;
  const rank = new Map(order.map((k, i) => [k, i]));
  const blocks = new Map();
  units.forEach((u, i) => {
    const r = rank.has(u.key) ? rank.get(u.key) : order.length + i;
    if (!blocks.has(u.group)) blocks.set(u.group, []);
    blocks.get(u.group).push({ u, r });
  });
  return [...blocks.values()]
    .map(list => list.sort((a, b) => a.r - b.r))
    .sort((a, b) => a[0].r - b[0].r)
    .flat()
    .map(x => x.u);
}

// Adjacent forms from the same group join with "/", everything else with joiner.
function formatUnits(units, joiner = ' · ') {
  let out = '';
  units.forEach((u, i) => {
    const prev = units[i - 1];
    if (prev) out += prev.slash && u.slash && prev.group === u.group ? '/' : joiner;
    out += u.text;
  });
  return out;
}

function mergePronouns(entries, joiner = ' · ') {
  return formatUnits(mergeUnits(entries), joiner);
}

// Split a free-form pronoun string (CSV cell, typed text) into entries.
function splitPronounText(text) {
  return String(text || '')
    .split(/\s*[,;·|]\s*|\s+and\s+/i)
    .map(s => s.trim())
    .filter(Boolean);
}

// ── Pronoun picker widget ──────────────────────────────────────────────────
// Toggle chips (multi-select, tap order kept), fill-in-the-blank entries,
// and an order row where each form can be moved left/right (he/they ↔ they/he).
// Calls onChange(string) whenever the result changes.
function createPronounPicker(container, { options, joiner, onChange }) {
  const state = { selected: [], custom: [], order: null, override: null };

  container.innerHTML = `
    <div class="chip-grid pronoun-chips"></div>
    <div class="inline-add">
      <input type="text" class="pronoun-custom-input" placeholder="Fill in your own (e.g. fae/faer)"
             autocomplete="off" autocapitalize="none">
      <button type="button" class="btn-add pronoun-custom-add">Add</button>
    </div>
    <div class="pronoun-order hidden">
      <span class="pronoun-result-label">Order:</span>
      <div class="order-pills"></div>
    </div>
    <div class="pronoun-result">
      <span class="pronoun-result-label">On badge:</span>
      <input type="text" class="pronoun-result-input" placeholder="(none)" autocomplete="off">
    </div>`;

  const chipsEl = container.querySelector('.pronoun-chips');
  const orderRow = container.querySelector('.pronoun-order');
  const orderEl = container.querySelector('.order-pills');
  const customInput = container.querySelector('.pronoun-custom-input');
  const resultInput = container.querySelector('.pronoun-result-input');

  const units = () => orderUnits(mergeUnits([...state.selected, ...state.custom]), state.order);
  const computed = () => formatUnits(units(), joiner);
  const value = () => (state.override !== null ? state.override : computed());

  function renderChips() {
    chipsEl.innerHTML = '';
    const lower = options.map(o => o.toLowerCase());
    const chipList = [...options, ...state.custom.filter(c => !lower.includes(c.toLowerCase()))];
    for (const opt of chipList) {
      const isCustom = state.custom.includes(opt);
      const active = state.selected.includes(opt) || isCustom;
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip' + (active ? ' active' : '') + (isCustom ? ' custom' : '');
      chip.textContent = opt + (isCustom ? ' ×' : '');
      chip.setAttribute('aria-pressed', active);
      chip.addEventListener('click', () => {
        if (isCustom) state.custom = state.custom.filter(c => c !== opt);
        else if (state.selected.includes(opt)) state.selected = state.selected.filter(s => s !== opt);
        else state.selected.push(opt);
        state.override = null;
        update();
      });
      chipsEl.appendChild(chip);
    }
  }

  // Swap with the neighbour inside the same set (he/they -> they/he); at a
  // set's edge, swap the whole set with the neighbouring set or phrase.
  function move(i, delta) {
    const us = units();
    const u = us[i], nb = us[i + delta];
    if (!nb) return;
    let keys;
    if (nb.group === u.group) {
      keys = us.map(x => x.key);
      [keys[i], keys[i + delta]] = [keys[i + delta], keys[i]];
    } else {
      const blocks = [];
      us.forEach((x, k) => {
        if (!k || us[k - 1].group !== x.group) blocks.push({ group: x.group, keys: [] });
        blocks[blocks.length - 1].keys.push(x.key);
      });
      const a = blocks.findIndex(b => b.group === u.group);
      const b = blocks.findIndex(b => b.group === nb.group);
      [blocks[a], blocks[b]] = [blocks[b], blocks[a]];
      keys = blocks.flatMap(b => b.keys);
    }
    state.order = keys;
    state.override = null;
    update();
  }

  function renderOrder() {
    const us = units();
    orderRow.classList.toggle('hidden', us.length < 2);
    orderEl.innerHTML = '';
    us.forEach((u, i) => {
      if (i) {
        const sep = document.createElement('span');
        sep.className = 'order-sep';
        sep.textContent = us[i - 1].group === u.group ? '/' : '·';
        orderEl.appendChild(sep);
      }
      const pill = document.createElement('span');
      pill.className = 'order-pill';
      pill.innerHTML = `<button type="button" class="order-btn" aria-label="Move left">‹</button><span></span><button type="button" class="order-btn" aria-label="Move right">›</button>`;
      pill.querySelector('span').textContent = u.text;
      const [left, right] = pill.querySelectorAll('button');
      left.disabled = i === 0;
      right.disabled = i === us.length - 1;
      left.addEventListener('click', () => move(i, -1));
      right.addEventListener('click', () => move(i, 1));
      orderEl.appendChild(pill);
    });
  }

  function refresh() {
    renderChips();
    renderOrder();
    resultInput.value = value();
  }

  function update() {
    refresh();
    onChange(value());
  }

  function addCustom() {
    const entries = splitPronounText(customInput.value);
    customInput.value = '';
    for (const e of entries) {
      const match = options.find(o => o.toLowerCase() === e.toLowerCase());
      if (match) { if (!state.selected.includes(match)) state.selected.push(match); }
      else if (!state.custom.includes(e)) state.custom.push(e);
    }
    state.override = null;
    update();
  }

  container.querySelector('.pronoun-custom-add').addEventListener('click', addCustom);
  customInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addCustom(); } });
  // Typing in the box but not pressing Add still counts once focus leaves.
  customInput.addEventListener('blur', () => { if (customInput.value.trim()) addCustom(); });
  resultInput.addEventListener('input', () => {
    state.override = resultInput.value === computed() ? null : resultInput.value;
    onChange(value());
  });

  refresh();

  return {
    value,
    // Restore from a saved/imported string.
    set(text) {
      state.selected = [];
      state.custom = [];
      state.order = null;
      state.override = null;
      for (const e of splitPronounText(text)) {
        const match = options.find(o => o.toLowerCase() === e.toLowerCase());
        if (match) state.selected.push(match);
        else state.custom.push(e);
      }
      // Keep exact text if merging would change what was saved.
      if (text && computed() !== text) state.override = text;
      refresh();
    },
    clear() { this.set(''); },
    // Exact picker state, for "remember my info" and row editing.
    getState() {
      return { selected: [...state.selected], custom: [...state.custom], order: state.order && [...state.order], override: state.override };
    },
    setState(s) {
      state.selected = (s?.selected || []).filter(o => options.includes(o));
      state.custom = [...(s?.custom || [])];
      state.order = s?.order || null;
      state.override = s?.override ?? null;
      refresh();
    },
  };
}
