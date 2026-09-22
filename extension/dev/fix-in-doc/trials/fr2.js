const until = async (pred, ms = 2000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return Date.now() - t0; await wait(25); } return -1; };
const AT = window.__AT;
// keypress typing burst first (no dialogs open)
let t = T(); let s = t.indexOf('watch it.') + 'watch it.'.length;
AT.setSelection(s, s);
const str = ' Typed via forty synthetic keypresses!!!';
const t0 = performance.now();
for (const ch of str) { const kc = ch === ' ' ? 32 : ch.toUpperCase().charCodeAt(0); __K.ev('keydown', ch, '', kc, { shift: ch !== ch.toLowerCase() || ch === '!' }); __K.ev('keypress', ch, '', ch.charCodeAt(0), { charCode: ch.charCodeAt(0), shift: ch !== ch.toLowerCase() || ch === '!' }); __K.ev('keyup', ch, '', kc); }
const dt = performance.now() - t0;
await wait(500);
t = T(); s = t.indexOf('watch it.');
snap(`(3) ${str.length} keypresses dispatch=${dt.toFixed(0)}ms result=${JSON.stringify(t.slice(s, s + 60))}`);
// Find & replace with diff
const before = T();
__K.press('h', 'KeyH', 72, { meta: true, shift: true });
await wait(800);
const dlg = document.querySelector('.appsDocsUiWizFindandreplacedialogContainer');
const f = dlg.querySelector('input[aria-label="Find"]'), r = dlg.querySelector('input[aria-label="Replace with"]');
f.focus(); f.value = 'story line'; f.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
r.focus(); r.value = 'storyline'; r.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
await wait(700);
const btn = [...dlg.querySelectorAll('button')].find(b => b.textContent.trim() === 'Replace');
const disabledBefore = btn.disabled;
btn.click();
await wait(500);
const d = __T.diff(before, T());
snap(`(2) F&R Replace: disabledBefore=${disabledBefore} diff=${JSON.stringify(d)}`);
const xs = [...dlg.querySelectorAll('button')].map(b => (b.getAttribute('aria-label') || b.textContent.trim()).slice(0, 20));
snap('dialog buttons=' + JSON.stringify(xs));
