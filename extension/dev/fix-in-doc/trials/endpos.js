const AT = window.__AT;
const t = T();
AT.setSelection(1, 1);
__K.press('ArrowDown', 'ArrowDown', 40, { meta: true });
await wait(200);
const macEnd = AT.getSelection();
AT.setSelection(1, 1);
__K.press('End', 'End', 35, { ctrl: true });
await wait(200);
const ctrlEnd = AT.getSelection();
snap(`len=${t.length} tail=${JSON.stringify(t.slice(-6))} cmdDown=${JSON.stringify(macEnd)} ctrlEnd=${JSON.stringify(ctrlEnd)}`);
// try setSelection at t.length-2 / -3 and see where selection lands
for (const k of [1, 2, 3, 4]) { AT.setSelection(t.length - k, t.length - k); await wait(50); snap(`setSelection(len-${k}) -> ${JSON.stringify(AT.getSelection())}`); }
// append using doc-end caret: paste " " not needed; paste "\nAPPENDED END LINE"
AT.setSelection(macEnd[0].start, macEnd[0].start);
__T.paste('APPENDED AT DOC END');
await wait(300);
const t2 = T();
snap(`after paste at doc end: tail=${JSON.stringify(t2.slice(-40))}`);
