const until = async (pred, ms = 2000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return Date.now() - t0; await wait(25); } return -1; };
const AT = window.__AT;
// 1) focus is elsewhere in the page (like a click on a Tracely card button)
const inp = document.createElement('input'); inp.id = 'tracely-fake-card-input'; inp.style.cssText = 'position:fixed;top:10px;left:600px;z-index:99999'; document.body.appendChild(inp); inp.focus();
const focusedBefore = document.activeElement === inp;
const sent = "Better than the original, which was pretty cheesy after all.";
let t = T(); let s = t.indexOf(sent);
AT.setSelection(s, s + sent.length);
const selOk = AT.getSelection()[0].end - AT.getSelection()[0].start === sent.length;
__T.paste('It improves on the original.');
const ms1 = await until(() => T().includes('It improves on the original.'));
snap(`(1) paste while page focus on <input>: focusedBefore=${focusedBefore} selOk=${selOk} ms=${ms1} activeNow=${document.activeElement.tagName}.${(document.activeElement.className||'').slice(0,30)}`);
// 1b) NBSP char code check
t = T(); s = t.indexOf('It improves on the original.') + 'It improves on the original.'.length;
AT.setSelection(s, s); __T.paste(' NB');
await until(() => T().includes('NB'));
t = T(); const k = t.indexOf('NB');
snap(`(1b) char before NB code=${t.charCodeAt(k - 1)}`);
// 2) Find and replace dialog -> Replace
inp.focus();
__K.press('h', 'KeyH', 72, { meta: true, shift: true });
await wait(800);
const dlg = document.querySelector('.appsDocsUiWizFindandreplacedialogContainer');
const f = dlg.querySelector('input[aria-label="Find"]'), r = dlg.querySelector('input[aria-label="Replace with"]');
f.focus(); f.value = 'story line'; f.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
r.focus(); r.value = 'storyline'; r.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
await wait(700);
const btn = [...dlg.querySelectorAll('button')].find(b => b.textContent.trim() === 'Replace');
const counter = [...dlg.querySelectorAll('*')].filter(e => e.children.length === 0 && /\d+\s*of\s*\d+/.test(e.textContent)).map(e => e.textContent.trim());
btn.click();
const ms2 = await until(() => T().includes('great storyline'));
snap(`(2) find&replace Replace click: counter=${counter} disabled=${btn.disabled} ms=${ms2}`);
// close dialog via its X button
const x = [...dlg.querySelectorAll('button')].find(b => /close/i.test(b.getAttribute('aria-label') || ''));
if (x) x.click();
await wait(400);
snap(`(2b) dialog closed=${!dlg.offsetParent || getComputedStyle(dlg).display==='none'} closeBtn=${!!x}`);
// 3) typing a word via keypress at a caret, check speed for 40 chars
t = T(); s = t.indexOf('watch it.') + 'watch it.'.length;
AT.setSelection(s, s);
const str = ' Typed via forty synthetic keypresses!!!';
const t0 = performance.now();
for (const ch of str) { const kc = ch.toUpperCase().charCodeAt(0); __K.ev('keydown', ch, '', kc, { shift: ch !== ch.toLowerCase() }); __K.ev('keypress', ch, '', ch.charCodeAt(0), { charCode: ch.charCodeAt(0), shift: ch !== ch.toLowerCase() }); __K.ev('keyup', ch, '', kc); }
const dt = performance.now() - t0;
const ms3 = await until(() => T().includes(str));
snap(`(3) 40 keypresses dispatch=${dt.toFixed(0)}ms applied=${ms3}`);
