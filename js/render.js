'use strict';

// ── Units ──────────────────────────────────────────────────────────────────
// Numbers are inches; strings like "50%" are a fraction of the badge's
// width (x, w) or height (y, h).
function toPx(v, axis, cfg) {
  const { width_in, height_in, dpi } = cfg.canvas;
  if (typeof v === 'string' && v.trim().endsWith('%')) {
    const f = parseFloat(v) / 100;
    return f * (axis === 'y' ? height_in : width_in) * dpi;
  }
  return (Number(v) || 0) * dpi;
}

function badgeSizePx(cfg) {
  return {
    w: Math.round(cfg.canvas.width_in * cfg.canvas.dpi),
    h: Math.round(cfg.canvas.height_in * cfg.canvas.dpi),
  };
}

// ── Templating / conditions ────────────────────────────────────────────────
function fillTemplate(str, data, cfg) {
  return String(str).replace(/\{(\w+)\}/g, (_, k) => {
    if (data[k] !== undefined && data[k] !== null) return String(data[k]);
    if (cfg.vars[k] !== undefined) return String(cfg.vars[k]);
    return '';
  });
}

const hasValue = (data, key) => String(data[key] ?? '').trim() !== '';

// Apply if/unless/when; returns the effective element or null to skip it.
function resolveElement(el, data) {
  if (el.if && !hasValue(data, el.if)) return null;
  if (el.unless && hasValue(data, el.unless)) return null;
  let out = el;
  if (el.when && typeof el.when === 'object') {
    for (const [key, overrides] of Object.entries(el.when)) {
      if (hasValue(data, key) && overrides && typeof overrides === 'object') out = { ...out, ...overrides };
    }
  }
  return out;
}

// ── Images ─────────────────────────────────────────────────────────────────
const imageCache = new Map();   // src -> { img, ok, tainted, error }

function resolveImageSrc(src) {
  if (src === 'upload:logo') return storeGet(STORE_KEYS.logoData) || '';
  return src || '';
}

function loadImage(src) {
  if (!src) return Promise.resolve(null);
  if (imageCache.has(src)) return imageCache.get(src).promise;
  const entry = { img: new Image(), ok: false, tainted: false, error: null };
  entry.promise = new Promise(resolve => {
    const img = entry.img;
    const isRemote = /^https?:/i.test(src) && !src.startsWith(location.origin);
    if (isRemote) img.crossOrigin = 'anonymous';
    img.onload = () => { entry.ok = true; resolve(entry); };
    img.onerror = () => {
      entry.error = isRemote
        ? `Could not load image ${src} (host may block cross-origin use; try uploading it in Settings → Event).`
        : `Could not load image ${src}`;
      resolve(entry);
    };
    img.src = src;
  });
  imageCache.set(src, entry);
  return entry.promise;
}

async function preloadImages(cfg) {
  const srcs = cfg.elements.filter(e => e.type === 'image').map(e => resolveImageSrc(e.src));
  await Promise.all(srcs.map(loadImage));
}

function forgetImage(src) { imageCache.delete(src); }

// ── Text layout ────────────────────────────────────────────────────────────
function fontString(el, sizePx, cfg) {
  const style = el.style === 'italic' ? 'italic ' : '';
  const weight = el.weight || 400;
  return `${style}${weight} ${sizePx}px ${el.font || cfg.fonts.family}`;
}

function measureWidth(ctx, text, spacingPx) {
  return ctx.measureText(text).width + Math.max(0, text.length - 1) * spacingPx;
}

// Greedy word wrap. Hyphenated words may break after the hyphen; words still
// wider than maxW are broken by characters.
function wrapWords(ctx, text, maxW, spacingPx) {
  const lines = [];
  for (const para of text.split(/\n/)) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const trial = line ? `${line} ${word}` : word;
      if (measureWidth(ctx, trial, spacingPx) > maxW && /\S-\S/.test(word)) {
        // Place hyphen pieces one by one: "Featherstonehaugh-" + "Montgomery".
        const pieces = word.split(/(?<=-)/);
        let first = true;
        for (const piece of pieces) {
          const t = line ? (first ? `${line} ${piece}` : line + piece) : piece;
          if (measureWidth(ctx, t, spacingPx) <= maxW || !line) line = t;
          else { lines.push(line); line = piece; }
          first = false;
        }
        continue;
      }
      if (measureWidth(ctx, trial, spacingPx) <= maxW) { line = trial; continue; }
      if (line) lines.push(line);
      if (measureWidth(ctx, word, spacingPx) <= maxW) { line = word; continue; }
      let chunk = '';
      for (const ch of word) {
        if (measureWidth(ctx, chunk + ch, spacingPx) > maxW && chunk) { lines.push(chunk); chunk = ch; }
        else chunk += ch;
      }
      line = chunk;
    }
    lines.push(line);
  }
  return lines;
}

function truncateToWidth(ctx, text, maxW, spacingPx) {
  if (measureWidth(ctx, text, spacingPx) <= maxW) return text;
  let t = text;
  while (t.length > 1 && measureWidth(ctx, t + '…', spacingPx) > maxW) t = t.slice(0, -1);
  return t.trimEnd() + '…';
}

// Largest font size (from size down to min_size) whose wrapped lines fit the box.
function fitText(ctx, text, el, box, cfg) {
  const dpi = cfg.canvas.dpi;
  const maxSize = toPx(el.size ?? 0.25, 'y', cfg);
  const minSize = Math.min(maxSize, toPx(el.min_size ?? el.size ?? 0.25, 'y', cfg));
  const maxLines = Math.max(1, el.max_lines || 1);
  const lh = el.line_height || 1.12;
  const spacingEm = Number(el.letter_spacing) || 0;
  const step = Math.max(1, dpi / 100);

  for (let s = maxSize; s >= minSize; s -= step) {
    ctx.font = fontString(el, s, cfg);
    const sp = spacingEm * s;
    const lines = wrapWords(ctx, text, box.w, sp);
    if (lines.length <= maxLines && lines.length * s * lh <= box.h + 0.5) {
      return { size: s, lines, lh, sp };
    }
  }
  // Doesn't fit even at min size: wrap, keep maxLines, ellipsize the last.
  const s = Math.max(1, Math.min(minSize, box.h / (lh * maxLines)) || minSize);
  ctx.font = fontString(el, s, cfg);
  const sp = spacingEm * s;
  let lines = wrapWords(ctx, text, box.w, sp);
  if (lines.length > maxLines) {
    const rest = lines.slice(maxLines - 1).reduce((acc, l) => (acc.endsWith('-') ? acc + l : `${acc} ${l}`));
    lines = [...lines.slice(0, maxLines - 1), rest];
  }
  lines = lines.map(l => truncateToWidth(ctx, l, box.w, sp));
  return { size: s, lines, lh, sp };
}

function drawSpacedText(ctx, text, x, y, align, sp) {
  if (!sp) { ctx.textAlign = align; ctx.fillText(text, x, y); return; }
  const w = measureWidth(ctx, text, sp);
  let cx = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
  ctx.textAlign = 'left';
  for (const ch of text) { ctx.fillText(ch, cx, y); cx += ctx.measureText(ch).width + sp; }
}

// ── Element drawers ────────────────────────────────────────────────────────
function elementBox(el, cfg) {
  return {
    x: toPx(el.x, 'x', cfg),
    y: toPx(el.y, 'y', cfg),
    w: toPx(el.w ?? el.size, 'x', cfg),
    h: toPx(el.h ?? el.size, 'y', cfg),
  };
}

function drawText(ctx, el, data, cfg) {
  let text = el.field ? String(data[el.field] ?? '') : fillTemplate(el.text ?? '', data, cfg);
  if (el.prefix && text) text = fillTemplate(el.prefix, data, cfg) + text;
  if (el.suffix && text) text += fillTemplate(el.suffix, data, cfg);
  text = text.trim();
  if (!text) return;
  if (el.transform === 'uppercase') text = text.toUpperCase();
  if (el.transform === 'lowercase') text = text.toLowerCase();

  const box = elementBox(el, cfg);
  const { size, lines, lh, sp } = fitText(ctx, text, el, box, cfg);
  const align = el.align || 'left';
  const valign = el.valign || 'top';
  const blockH = lines.length * size * lh;
  let y0 = box.y;
  if (valign === 'middle') y0 = box.y + (box.h - blockH) / 2;
  if (valign === 'bottom') y0 = box.y + box.h - blockH;
  const x = align === 'center' ? box.x + box.w / 2 : align === 'right' ? box.x + box.w : box.x;

  ctx.font = fontString(el, size, cfg);
  ctx.fillStyle = el.color || '#000';
  ctx.textBaseline = 'middle';
  lines.forEach((line, i) => drawSpacedText(ctx, line, x, y0 + (i + 0.5) * size * lh, align, sp));
}

function drawImage(ctx, el, cfg, warnings) {
  const src = resolveImageSrc(el.src);
  const entry = imageCache.get(src);
  if (!entry) return;
  if (entry.error) { warnings.push(entry.error); return; }
  if (!entry.ok || entry.tainted) return;
  const img = entry.img;
  const box = elementBox(el, cfg);
  const iw = img.naturalWidth || box.w;
  const ih = img.naturalHeight || box.h;
  let dw = box.w, dh = box.h;
  if (el.fit !== 'fill') {
    const scale = el.fit === 'cover' ? Math.max(box.w / iw, box.h / ih) : Math.min(box.w / iw, box.h / ih);
    dw = iw * scale; dh = ih * scale;
  }
  const align = el.align || 'center';
  const valign = el.valign || 'middle';
  const dx = align === 'left' ? box.x : align === 'right' ? box.x + box.w - dw : box.x + (box.w - dw) / 2;
  const dy = valign === 'top' ? box.y : valign === 'bottom' ? box.y + box.h - dh : box.y + (box.h - dh) / 2;
  ctx.save();
  ctx.beginPath(); ctx.rect(box.x, box.y, box.w, box.h); ctx.clip();
  ctx.drawImage(img, dx, dy, dw, dh);
  ctx.restore();
}

// QR drawn module-by-module on whole pixels so it stays crisp.
function drawQr(ctx, el, data, cfg) {
  const value = el.field ? String(data[el.field] ?? '').trim() : fillTemplate(el.text ?? '', data, cfg).trim();
  if (!value || typeof qrcode === 'undefined') return;
  let qr;
  try {
    qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];
    qr = qrcode(0, el.ec_level || 'M');
    qr.addData(value, 'Byte');
    qr.make();
  } catch (_) { return; }   // too long to encode
  const n = qr.getModuleCount();
  const quiet = el.quiet_zone ?? 4;
  const box = elementBox(el, cfg);
  const side = Math.min(box.w, box.h);
  const mod = Math.max(1, Math.floor(side / (n + 2 * quiet)));
  const full = mod * (n + 2 * quiet);
  // Anchor at the bottom-right of the box (QR usually sits in a bottom corner).
  const ox = Math.round(box.x + (el.align === 'left' ? 0 : el.align === 'center' ? (box.w - full) / 2 : box.w - full));
  const oy = Math.round(box.y + (el.valign === 'top' ? 0 : el.valign === 'middle' ? (box.h - full) / 2 : box.h - full));
  ctx.fillStyle = '#fff';
  ctx.fillRect(ox, oy, full, full);
  ctx.fillStyle = '#000';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) ctx.fillRect(ox + (c + quiet) * mod, oy + (r + quiet) * mod, mod, mod);
    }
  }
}

function drawLine(ctx, el, cfg) {
  const x = toPx(el.x, 'x', cfg), y = toPx(el.y, 'y', cfg);
  const t = Math.max(1, toPx(el.thickness ?? 0.02, 'y', cfg));
  const w = el.w !== undefined ? toPx(el.w, 'x', cfg) : 0;
  const h = el.h !== undefined ? toPx(el.h, 'y', cfg) : 0;
  ctx.fillStyle = el.color || '#000';
  if (w >= h) ctx.fillRect(x, y - t / 2, w, t);
  else ctx.fillRect(x - t / 2, y, t, h);
}

function drawRect(ctx, el, cfg) {
  const box = elementBox(el, cfg);
  const r = toPx(el.radius ?? 0, 'x', cfg);
  ctx.beginPath();
  if (r > 0 && ctx.roundRect) ctx.roundRect(box.x, box.y, box.w, box.h, r);
  else ctx.rect(box.x, box.y, box.w, box.h);
  if (el.fill) { ctx.fillStyle = el.fill; ctx.fill(); }
  if (el.stroke) {
    ctx.lineWidth = Math.max(1, toPx(el.stroke_width ?? 0.02, 'x', cfg));
    ctx.strokeStyle = el.stroke;
    ctx.stroke();
  }
}

// ── Colour mode post-process ───────────────────────────────────────────────
// ditherBoxes: canvas-pixel rects (image elements) that get error diffusion in
// bw+dither mode; everything else is thresholded so text and QR stay crisp.
function applyColorMode(ctx, w, h, output, ditherBoxes = []) {
  if (output.color_mode === 'color') return;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const n = w * h;
  const lum = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    // Composite any transparency over white first.
    const a = d[p + 3] / 255;
    const r = d[p] * a + 255 * (1 - a), g = d[p + 1] * a + 255 * (1 - a), b = d[p + 2] * a + 255 * (1 - a);
    lum[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  if (output.color_mode === 'bw') {
    const t = output.bw_threshold;
    const src = output.bw_dither ? Float32Array.from(lum) : null;
    for (let i = 0; i < n; i++) lum[i] = lum[i] < t ? 0 : 255;
    if (src) {
      for (const bx of ditherBoxes) {
        const x0 = Math.max(0, Math.floor(bx.x)), y0 = Math.max(0, Math.floor(bx.y));
        const x1 = Math.min(w, Math.ceil(bx.x + bx.w)), y1 = Math.min(h, Math.ceil(bx.y + bx.h));
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const i = y * w + x;
            const old = Math.max(0, Math.min(255, src[i]));   // clamp so solid areas don't carry error
            const nv = old < t ? 0 : 255;
            lum[i] = nv;
            const err = old - nv;
            if (x + 1 < x1) src[i + 1] += err * 7 / 16;
            if (y + 1 < y1) {
              if (x > x0) src[i + w - 1] += err * 3 / 16;
              src[i + w] += err * 5 / 16;
              if (x + 1 < x1) src[i + w + 1] += err * 1 / 16;
            }
          }
        }
      }
    }
  }
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const v = Math.max(0, Math.min(255, Math.round(lum[i])));
    d[p] = d[p + 1] = d[p + 2] = v;
    d[p + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

// ── Main render ────────────────────────────────────────────────────────────
// Draws the badge onto `canvas` (upright). Returns a list of warnings.
// Call preloadImages(cfg) first so images are ready.
function renderBadge(canvas, cfg, data) {
  const { w: W, h: H } = badgeSizePx(cfg);
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const warnings = [];
  const ditherBoxes = [];

  ctx.save();
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);

  // Bleed: shrink the whole layout into a safe area, centred.
  const b = toPx(cfg.canvas.bleed_in, 'x', cfg);
  if (b > 0) {
    ctx.translate(b, b);
    ctx.scale((W - 2 * b) / W, (H - 2 * b) / H);
  }

  for (const raw of cfg.elements) {
    const el = resolveElement(raw, data);
    if (!el) continue;
    try {
      if (el.type === 'text') drawText(ctx, el, data, cfg);
      else if (el.type === 'image') {
        drawImage(ctx, el, cfg, warnings);
        const bx = elementBox(el, cfg);
        const m = ctx.getTransform();
        ditherBoxes.push({ x: m.a * bx.x + m.e, y: m.d * bx.y + m.f, w: m.a * bx.w, h: m.d * bx.h });
      }
      else if (el.type === 'qr') drawQr(ctx, el, data, cfg);
      else if (el.type === 'line') drawLine(ctx, el, cfg);
      else if (el.type === 'rect') drawRect(ctx, el, cfg);
    } catch (e) {
      warnings.push(`Element ${raw.id || raw.type}: ${e.message}`);
    }
  }
  ctx.restore();

  try {
    applyColorMode(ctx, W, H, cfg.output, ditherBoxes);
  } catch (e) {
    if (e.name !== 'SecurityError') throw e;
    // A cross-origin image tainted the canvas: drop images that aren't
    // same-origin/data and redraw so export still works.
    for (const [src, entry] of imageCache) {
      if (/^https?:/i.test(src) && !src.startsWith(location.origin)) entry.tainted = true;
    }
    const again = renderBadge(canvas, cfg, data);
    return [...again, 'Logo host does not allow CORS, so it was left off. Upload the logo in Settings → Event instead.'];
  }
  return warnings;
}

// Copy the upright canvas into an export canvas with rotate_output applied.
function exportCanvas(src, cfg) {
  const rot = cfg.canvas.rotate_output;
  if (!rot) return src;
  const out = document.createElement('canvas');
  const swap = rot === 90 || rot === 270;
  out.width = swap ? src.height : src.width;
  out.height = swap ? src.width : src.height;
  const ctx = out.getContext('2d');
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate(rot * Math.PI / 180);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return out;
}

function canvasToBlob(canvas) {
  return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}

// Render a badge to a PNG Blob (with rotation) without touching the preview.
async function renderBadgeBlob(cfg, data) {
  await preloadImages(cfg);
  const c = document.createElement('canvas');
  renderBadge(c, cfg, data);
  return canvasToBlob(exportCanvas(c, cfg));
}

function badgeFilename(cfg, data) {
  const base = fillTemplate(cfg.output.filename || 'badge', data, cfg)
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'badge';
  return `${base}.png`;
}
