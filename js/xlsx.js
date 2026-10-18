'use strict';

// Minimal .xlsx reader: unzip with the browser's DecompressionStream, then
// read cell text from the sheet XML. Values only (no formulas/formatting),
// which is all a badge import needs.
// readXlsx(ArrayBuffer) -> Promise<[{ name, rows: string[][] }]>

const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function unzipEntries(buf) {
  const dv = new DataView(buf);
  // End of central directory: scan back over a possible trailing comment.
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid .xlsx file (zip directory not found).');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Corrupt .xlsx file (bad zip entry).');
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(buf, p + 46, nameLen));
    const dataOff = localOff + 30 + dv.getUint16(localOff + 26, true) + dv.getUint16(localOff + 28, true);
    entries.set(name, { method, data: new Uint8Array(buf, dataOff, compSize) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function readZipText(entries, name) {
  const e = entries.get(name);
  if (!e) return null;
  let bytes = e.data;
  if (e.method === 8) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  } else if (e.method !== 0) {
    throw new Error(`Unsupported compression in .xlsx (method ${e.method}).`);
  }
  return new TextDecoder().decode(bytes);
}

function parseXml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Corrupt .xlsx file (bad XML).');
  return doc;
}

const byTag = (node, tag) => [...node.getElementsByTagNameNS('*', tag)];

// Text of a shared-string <si> or inline <is>, skipping phonetic runs.
function richText(node) {
  return byTag(node, 't').filter(t => t.parentNode.localName !== 'rPh').map(t => t.textContent).join('');
}

function colIndex(ref) {
  const letters = /^[A-Z]+/i.exec(ref || '');
  if (!letters) return -1;
  let n = 0;
  for (const ch of letters[0].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function resolveTarget(target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = ('xl/' + target).split('/');
  const out = [];
  for (const part of parts) { if (part === '..') out.pop(); else if (part !== '.') out.push(part); }
  return out.join('/');
}

function sheetRows(doc, shared) {
  const rows = [];
  for (const rowEl of byTag(doc, 'row')) {
    const r = Number(rowEl.getAttribute('r')) - 1;
    const rowIdx = Number.isInteger(r) && r >= 0 ? r : rows.length;
    const cells = [];
    let next = 0;
    for (const c of byTag(rowEl, 'c')) {
      let ci = colIndex(c.getAttribute('r'));
      if (ci < 0) ci = next;
      next = ci + 1;
      const t = c.getAttribute('t');
      const v = byTag(c, 'v')[0]?.textContent ?? '';
      let val;
      if (t === 's') val = shared[Number(v)] ?? '';
      else if (t === 'inlineStr') val = byTag(c, 'is')[0] ? richText(byTag(c, 'is')[0]) : '';
      else if (t === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
      else val = v;
      cells[ci] = val;
    }
    rows[rowIdx] = Array.from(cells, x => (x ?? '').trim());
  }
  return Array.from(rows, r => r || []).filter(r => r.some(c => c !== ''));
}

async function readXlsx(buf) {
  const entries = unzipEntries(buf);
  const wbText = await readZipText(entries, 'xl/workbook.xml');
  if (!wbText) throw new Error('Not an Excel workbook (xl/workbook.xml missing).');
  const relsText = await readZipText(entries, 'xl/_rels/workbook.xml.rels');
  const rels = new Map();
  if (relsText) for (const rel of byTag(parseXml(relsText), 'Relationship')) {
    rels.set(rel.getAttribute('Id'), resolveTarget(rel.getAttribute('Target')));
  }
  const ssText = await readZipText(entries, 'xl/sharedStrings.xml');
  const shared = ssText ? byTag(parseXml(ssText), 'si').map(richText) : [];

  const sheets = [];
  for (const s of byTag(parseXml(wbText), 'sheet')) {
    const rid = s.getAttributeNS(NS_REL, 'id') || s.getAttribute('r:id');
    const path = rels.get(rid);
    const text = path && await readZipText(entries, path);
    if (!text) continue;
    sheets.push({ name: s.getAttribute('name') || `Sheet ${sheets.length + 1}`, rows: sheetRows(parseXml(text), shared) });
  }
  if (!sheets.length) throw new Error('No worksheets found in the .xlsx file.');
  return sheets;
}

function isZipBuffer(buf) {
  const b = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
  return b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
}

function isLegacyXls(buf) {
  const b = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
  return b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0;
}
