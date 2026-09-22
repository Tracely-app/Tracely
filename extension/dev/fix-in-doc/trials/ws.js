const until = async (pred, ms = 1500) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return Date.now() - t0; await wait(25); } return -1; };
const AT = window.__AT;
const copyRange = (s, e) => { AT.setSelection(s, e); const t = __K.target(); const W = t.ownerDocument.defaultView; const dt = new W.DataTransfer(); t.dispatchEvent(new W.ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: dt })); return { plain: dt.getData('text/plain'), html: dt.getData('text/html').replace(/<meta[^>]*>/, '').slice(0, 420) }; };
const anchor = "his father's death.";
async function ins(label, fn, marker) {
  const t = T(); const s = t.indexOf(anchor) + anchor.length;
  AT.setSelection(s, s);
  const before = T();
  fn();
  await until(() => T() !== before);
  const after = T();
  const d = __T.diff(before, after);
  snap(`${label}: inserted=${JSON.stringify(after.slice(s, s + (after.length - before.length)))}`);
  return { s, len: after.length - before.length };
}
await ins('plain " A1"', () => __T.paste(' A1'));
await ins('plain "\\u00a0A2"', () => __T.paste(' A2'));
await ins('html pre-wrap " A3"', () => __T.paste(' A3', '<meta charset="utf-8"><span style="white-space:pre-wrap;"> A3</span>'));
await ins('html "&nbsp;A4"', () => __T.paste(' A4', '<span>&nbsp;A4</span>'));
await ins('plain "A5 " trailing', () => __T.paste('A5 '));
await ins('keypress space then paste A6', () => { __K.ev('keydown', ' ', 'Space', 32); __K.ev('keypress', ' ', 'Space', 32, { charCode: 32 }); __K.ev('keyup', ' ', 'Space', 32); __T.paste('A6'); });
await wait(200);
snap('final window: ' + JSON.stringify(T().slice(T().indexOf(anchor), T().indexOf(anchor) + 60)));
// formatting readback: original sentence vs pasted plain vs pasted html
const t = T(); const i = t.indexOf(anchor);
const orig = copyRange(i, i + 6);
const k1 = t.indexOf('A1'); const p1 = copyRange(k1, k1 + 2);
const k4 = t.indexOf('A4'); const p4 = copyRange(k4, k4 + 2);
snap('fmt orig=' + JSON.stringify(orig));
snap('fmt plainPaste=' + JSON.stringify(p1));
snap('fmt htmlPaste=' + JSON.stringify(p4));
