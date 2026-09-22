// helpers injected into page
window.__H = {
  sel() { return window.__AT.getSelection(); },
  selText() { const t = window.__AT.getText(); return window.__AT.getSelection().map(s => t.slice(s.start, s.end)); },
  overlay() { return [...document.querySelectorAll('.kix-canvas-tile-selection svg rect')].map(r => ({ w: +(+r.getAttribute('width')).toFixed(1), x: +(+r.getAttribute('x')).toFixed(1), t: r.getAttribute('transform') })); },
  caret() { const c = document.querySelector('.kix-cursor'); return c && c.style.transform; },
  // client coords for a substring of a visible SVG annotation line
  wordPt(word, occ = 0) {
    const rects = [...document.querySelectorAll('svg rect[aria-label]')];
    let n = 0;
    for (const r of rects) {
      const lbl = r.getAttribute('aria-label'); let i = -1;
      while ((i = lbl.indexOf(word, i + 1)) >= 0) {
        if (n++ < occ) continue;
        const cv = document.createElement('canvas').getContext('2d'); cv.font = r.getAttribute('data-font-css');
        const x0 = cv.measureText(lbl.slice(0, i)).width, w = cv.measureText(word).width;
        const b = r.getBoundingClientRect();
        const scale = b.width / (+r.getAttribute('width'));
        return { x: b.left + (x0 + w / 2) * scale, y: b.top + b.height / 2, xl: b.left + x0 * scale, xr: b.left + (x0 + w) * scale, line: lbl };
      }
    }
    return null;
  },
};
