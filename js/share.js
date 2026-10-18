'use strict';

function canShareFiles() {
  try {
    const f = new File([''], 'test.png', { type: 'image/png' });
    return !!(navigator.canShare && navigator.canShare({ files: [f] }));
  } catch (_) { return false; }
}

// Call directly from a click handler with blobs that are already built, so
// navigator.share runs inside the user gesture (iOS Safari requires this).
// Resolves 'shared' | 'cancelled' | 'unsupported'; rejects on other errors.
async function shareFiles(items, title) {
  const files = items.map(({ blob, filename }) => new File([blob], filename, { type: 'image/png' }));
  if (!navigator.canShare || !navigator.canShare({ files })) return 'unsupported';
  try {
    await navigator.share({ files, title });
    return 'shared';
  } catch (err) {
    if (err.name === 'AbortError') return 'cancelled';
    throw err;
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function downloadText(text, filename, type = 'text/plain') {
  downloadBlob(new Blob([text], { type }), filename);
}
