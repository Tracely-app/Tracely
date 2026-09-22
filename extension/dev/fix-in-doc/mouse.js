window.__M = {
  fire(type, x, y, o = {}) {
    const el = document.elementFromPoint(x, y);
    const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
    const ev = new Ctor(type, { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, screenX: x, screenY: y + 80, button: 0, buttons: /down|move/.test(type) ? 1 : 0, detail: o.detail ?? 1, shiftKey: !!o.shift, pointerId: 1, pointerType: 'mouse', isPrimary: true, ...o.extra });
    return el.dispatchEvent(ev);
  },
  click(x, y, n = 1, o = {}) {
    for (let i = 1; i <= n; i++) {
      if (o.pointer) this.fire('pointerdown', x, y, { ...o, detail: i });
      this.fire('mousedown', x, y, { ...o, detail: i });
      if (o.pointer) this.fire('pointerup', x, y, { ...o, detail: i });
      this.fire('mouseup', x, y, { ...o, detail: i });
      this.fire('click', x, y, { ...o, detail: i });
      if (i === 2) this.fire('dblclick', x, y, { ...o, detail: 2 });
    }
  },
};
