window.__K = {
  target() { const d = document.querySelector('.docs-texteventtarget-iframe').contentDocument; return d.querySelector('[contenteditable]'); },
  ev(type, key, code, keyCode, o = {}) {
    const t = this.target(); const W = t.ownerDocument.defaultView;
    const e = new W.KeyboardEvent(type, { bubbles: true, cancelable: true, composed: true, key, code, shiftKey: !!o.shift, ctrlKey: !!o.ctrl, metaKey: !!o.meta, altKey: !!o.alt, charCode: o.charCode || 0, view: W });
    if (o.legacy !== false) { Object.defineProperty(e, 'keyCode', { get: () => keyCode }); Object.defineProperty(e, 'which', { get: () => keyCode }); if (type === 'keypress') Object.defineProperty(e, 'charCode', { get: () => o.charCode || 0 }); }
    return t.dispatchEvent(e);
  },
  press(key, code, keyCode, o = {}) { const a = this.ev('keydown', key, code, keyCode, o); this.ev('keyup', key, code, keyCode, o); return a; },
};
