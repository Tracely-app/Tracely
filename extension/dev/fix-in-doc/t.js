window.__T = {
  diff(a, b) { let i = 0; while (i < a.length && a[i] === b[i]) i++; let j = 0; while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++; return { at: i, removed: a.slice(i, a.length - j), inserted: b.slice(i, b.length - j) }; },
  paste(text, html) { const t = __K.target(); const W = t.ownerDocument.defaultView; const dt = new W.DataTransfer(); dt.setData('text/plain', text); if (html) dt.setData('text/html', html); const ev = new W.ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }); return t.dispatchEvent(ev); },
};
