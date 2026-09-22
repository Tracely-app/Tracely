const AT = window.__AT;
// Find & replace first, on pristine text
const before = T();
__K.press('h', 'KeyH', 72, { meta: true, shift: true });
await wait(800);
const dlg = document.querySelector('.appsDocsUiWizFindandreplacedialogContainer');
const f = dlg.querySelector('input[aria-label="Find"]'), r = dlg.querySelector('input[aria-label="Replace with"]');
f.focus(); f.value = 'story line'; f.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
r.focus(); r.value = 'storyline'; r.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
await wait(700);
const btn = [...dlg.querySelectorAll('button')].find(b => b.textContent.trim() === 'Replace');
const counter = [...dlg.querySelectorAll('*')].filter(e => e.children.length === 0 && /\d+\s*of\s*\d+/.test(e.textContent)).map(e => e.textContent.trim());
const disabledBefore = btn.disabled;
btn.click();
await wait(500);
snap(`(2) F&R Replace: counter=${counter} disabledBefore=${disabledBefore} diff=${JSON.stringify(__T.diff(before, T()))} sel=${JSON.stringify(AT.getSelection())}`);
[...dlg.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Close').click();
await wait(500);
snap(`dialog visible after Close: ${dlg.getBoundingClientRect().width > 0 && getComputedStyle(dlg).visibility !== 'hidden'}`);
// keypress typing with safe keyCodes: letters/digits real VK, everything else keyCode 0
let t = T(); let s = t.indexOf('watch it.') + 'watch it.'.length;
AT.setSelection(s, s);
const str = ' Typed, via 40 synthetic keypresses (ok)!';
const vk = ch => /[a-z0-9 ]/i.test(ch) ? ch.toUpperCase().charCodeAt(0) : 0;
const t0 = performance.now();
for (const ch of str) { const shift = /[A-Z!()]/.test(ch); __K.ev('keydown', ch, '', vk(ch), { shift }); __K.ev('keypress', ch, '', ch.charCodeAt(0), { charCode: ch.charCodeAt(0), shift }); __K.ev('keyup', ch, '', vk(ch), { shift }); }
const dt = performance.now() - t0;
await wait(500);
t = T(); s = t.indexOf('watch it.');
snap(`(3) ${str.length} keypresses dispatch=${dt.toFixed(0)}ms exact=${t.includes('watch it.' + str)} result=${JSON.stringify(t.slice(s, s + 60))}`);
