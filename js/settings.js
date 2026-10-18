'use strict';

// Settings drawer. Form tabs edit a copy of the active config and commit it
// back as YAML, so the YAML tab and the form tabs never drift apart.
const Settings = {
  hooks: null,   // { getConfig(), getYaml(), isCustom(), apply(yamlText) -> throws on invalid }

  init(hooks) {
    this.hooks = hooks;
    const $ = id => document.getElementById(id);

    $('btn-settings').addEventListener('click', () => this.open());
    $('btn-settings-close').addEventListener('click', () => this.close());
    $('settings-backdrop').addEventListener('click', () => this.close());
    document.addEventListener('keydown', e => { if (e.key === 'Escape') this.close(); });

    document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => this.showTab(tab.dataset.tab)));

    // Simple path-bound inputs (canvas.*, output.*)
    document.querySelectorAll('#settings-drawer [data-path]').forEach(input => {
      const evt = input.type === 'range' ? 'input' : 'change';
      input.addEventListener(evt, () => {
        let v;
        if (input.type === 'checkbox') v = input.checked;
        else if (input.type === 'number' || input.type === 'range' || input.dataset.type === 'number') v = Number(input.value);
        else v = input.value;
        this.edit(cfg => setPath(cfg, input.dataset.path, v));
      });
    });

    $('s-color-mode').addEventListener('click', e => {
      const b = e.target.closest('button[data-value]');
      if (b) this.edit(cfg => { cfg.output.color_mode = b.dataset.value; });
    });

    // Logo
    $('s-logo-src').addEventListener('change', () => {
      const src = $('s-logo-src').value.trim();
      this.edit(cfg => { const el = logoElement(cfg); if (el) el.src = src; });
    });
    $('s-logo-file').addEventListener('change', e => this.uploadLogo(e.target.files[0]));
    $('s-logo-remove').addEventListener('click', () => {
      storeDel(STORE_KEYS.logoData);
      this.edit(cfg => {
        const el = logoElement(cfg);
        if (el && el.src === 'upload:logo') el.src = defaultLogoSrc() || '';
      });
    });
    document.querySelectorAll('[data-logo]').forEach(input => input.addEventListener('change', () => {
      this.edit(cfg => { const el = logoElement(cfg); if (el) el[input.dataset.logo] = Number(input.value); });
    }));

    // Fields tab
    $('s-pronouns').addEventListener('change', () => this.edit(cfg => {
      cfg.pronoun_options = linesOf($('s-pronouns').value);
    }));
    $('s-banners').addEventListener('change', () => this.edit(cfg => {
      const f = cfg.fields.find(x => x.key === 'role');
      if (f) f.options = ['', ...linesOf($('s-banners').value)];
    }));

    // YAML tab
    $('s-yaml-apply').addEventListener('click', () => this.applyYaml($('s-yaml').value));
    $('s-yaml').addEventListener('input', () => {
      try { parseConfigYaml($('s-yaml').value); this.yamlStatus('Valid. Press Apply to use it.', false); }
      catch (e) { this.yamlStatus(e.message, true); }
    });
    $('s-yaml-export').addEventListener('click', () => downloadText(this.hooks.getYaml(), 'badge.yaml', 'text/yaml'));
    $('s-yaml-file').addEventListener('change', async e => {
      const f = e.target.files[0];
      e.target.value = '';
      if (f) this.applyYaml(await f.text());
    });
    $('s-yaml-load-url').addEventListener('click', async () => {
      const url = $('s-yaml-url').value.trim();
      if (!url) return;
      try {
        const res = await fetch(url, { cache: 'no-cache' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        this.applyYaml(await res.text());
      } catch (e) { this.yamlStatus(`Could not load ${url}: ${e.message}`, true); }
    });

    $('s-reset').addEventListener('click', () => {
      if (!confirm('Reset all badge settings and layout to the default? Your uploaded logo will be removed too.')) return;
      resetConfig();
      storeDel(STORE_KEYS.logoData);
      this.hooks.apply(null);
      this.populate();
    });
  },

  open() {
    this.populate();
    document.getElementById('settings-drawer').classList.remove('hidden');
    document.getElementById('settings-backdrop').classList.remove('hidden');
    document.body.classList.add('drawer-open');
  },

  close() {
    document.getElementById('settings-drawer').classList.add('hidden');
    document.getElementById('settings-backdrop').classList.add('hidden');
    document.body.classList.remove('drawer-open');
  },

  showTab(name) {
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('hidden', p.dataset.panel !== name));
    storeSetJSON(STORE_KEYS.ui, { ...storeGetJSON(STORE_KEYS.ui, {}), settingsTab: name });
  },

  // Clone config, mutate, commit as YAML.
  edit(mutator) {
    const cfg = structuredClone(this.hooks.getConfig());
    mutator(cfg);
    try {
      this.hooks.apply(dumpConfigYaml(cfg));
      this.yamlStatus('', false);
    } catch (e) {
      alert(e.message);
    }
    this.populate();
  },

  applyYaml(text) {
    try {
      this.hooks.apply(text);
      this.yamlStatus('Applied.', false);
      this.populate();
    } catch (e) {
      this.yamlStatus(e.message, true);
    }
  },

  yamlStatus(msg, isError) {
    const el = document.getElementById('s-yaml-status');
    el.textContent = msg;
    el.classList.toggle('error', !!isError);
  },

  async uploadLogo(file) {
    if (!file) return;
    if (file.size > 2.5e6) { alert('That image is over 2.5 MB; please use a smaller file (SVG or PNG works best).'); return; }
    const dataUrl = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = () => rej(r.error);
      r.readAsDataURL(file);
    });
    if (!storeSet(STORE_KEYS.logoData, dataUrl)) { alert('Could not save the logo on this device (storage full or blocked).'); return; }
    this.edit(cfg => { const el = logoElement(cfg); if (el) el.src = 'upload:logo'; });
  },

  populate() {
    const cfg = this.hooks.getConfig();
    const $ = id => document.getElementById(id);

    document.querySelectorAll('#settings-drawer [data-path]').forEach(input => {
      const v = getPath(cfg, input.dataset.path);
      if (input.type === 'checkbox') input.checked = !!v;
      else input.value = v ?? '';
    });
    $('s-threshold-val').textContent = `(${cfg.output.bw_threshold})`;
    document.querySelectorAll('#s-color-mode button').forEach(b =>
      b.classList.toggle('active', b.dataset.value === cfg.output.color_mode));
    $('bw-options').classList.toggle('hidden', cfg.output.color_mode !== 'bw');

    // Event vars
    const varsBox = $('s-vars');
    varsBox.innerHTML = '';
    for (const [k, v] of Object.entries(cfg.vars)) {
      const g = document.createElement('div');
      g.className = 'field-group';
      g.innerHTML = `<label></label><input type="text">`;
      g.querySelector('label').textContent = VAR_LABELS[k] || `{${k}}`;
      const input = g.querySelector('input');
      input.value = v;
      input.addEventListener('change', () => this.edit(c => { c.vars[k] = input.value; }));
      varsBox.appendChild(g);
    }

    // Logo
    const logo = logoElement(cfg);
    $('s-logo-box').classList.toggle('hidden', !logo);
    $('s-logo-src').value = logo?.src === 'upload:logo' ? '(uploaded file)' : (logo?.src || '');
    $('s-logo-img').src = logo ? resolveImageSrc(logo.src) : '';
    $('s-logo-remove').classList.toggle('hidden', !storeGet(STORE_KEYS.logoData));
    document.querySelectorAll('[data-logo]').forEach(i => { i.value = logo?.[i.dataset.logo] ?? ''; });

    // Fields
    const fieldsBox = $('s-fields');
    fieldsBox.innerHTML = '';
    cfg.fields.forEach((f, idx) => {
      const row = document.createElement('div');
      row.className = 'field-edit-row';
      row.innerHTML = `
        <code></code>
        <input type="text" class="f-label" aria-label="Label">
        <label class="mini-check"><input type="checkbox" class="f-show"> show</label>
        <label class="mini-check"><input type="checkbox" class="f-req"> required</label>`;
      row.querySelector('code').textContent = f.key;
      const label = row.querySelector('.f-label');
      label.value = f.label || '';
      row.querySelector('.f-show').checked = !f.hidden;
      row.querySelector('.f-req').checked = !!f.required;
      label.addEventListener('change', () => this.edit(c => { c.fields[idx].label = label.value; }));
      row.querySelector('.f-show').addEventListener('change', e => this.edit(c => {
        if (e.target.checked) delete c.fields[idx].hidden; else c.fields[idx].hidden = true;
      }));
      row.querySelector('.f-req').addEventListener('change', e => this.edit(c => { c.fields[idx].required = e.target.checked; }));
      fieldsBox.appendChild(row);
    });
    $('s-pronouns').value = cfg.pronoun_options.join('\n');
    const role = cfg.fields.find(x => x.key === 'role');
    $('s-banners').closest('.field-group').classList.toggle('hidden', !role);
    $('s-banners').value = (role?.options || []).filter(Boolean).join('\n');

    // YAML
    if (document.activeElement !== $('s-yaml')) $('s-yaml').value = this.hooks.getYaml();
    $('s-custom-flag').textContent = this.hooks.isCustom() ? 'Using your customized settings.' : 'Using the default badge.yaml.';

    const tab = storeGetJSON(STORE_KEYS.ui, {}).settingsTab;
    if (tab && document.querySelector(`.tab[data-tab="${tab}"]`)) this.showTab(tab);
  },
};

const VAR_LABELS = { event: 'Event title', event_sub: 'Event subtitle (location / dates)' };

function logoElement(cfg) {
  return cfg.elements.find(e => e.id === 'logo') || cfg.elements.find(e => e.type === 'image');
}

function defaultLogoSrc() {
  try { return logoElement(parseConfigYaml(defaultYamlText))?.src; } catch (_) { return ''; }
}

function linesOf(text) {
  return text.split('\n').map(s => s.trim()).filter(Boolean);
}

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((o, k) => (o[k] ??= {}), obj);
  target[last] = value;
}
