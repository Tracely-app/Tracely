const tgt = "However, Rooster still holds a grudge and blames Maverick for his father's death.";
const t0 = T(); const s = t0.indexOf(tgt);
window.__AT.setSelection(s, s + tgt.length);
snap('selected');
const r1 = __T.paste('PASTED-REPLACEMENT.');
snap('sync after paste ret=' + r1);
await wait(300); snap('300ms');
// variant: Cmd+V keydown arms, then paste event
__K.ev('keydown', 'v', 'KeyV', 86, { meta: true });
const r2 = __T.paste('PASTED-AFTER-CMDV.');
__K.ev('keyup', 'v', 'KeyV', 86, { meta: true });
snap('sync after cmdV+paste ret=' + r2);
await wait(500); snap('800ms');
