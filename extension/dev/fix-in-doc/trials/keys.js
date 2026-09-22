const tgt = "his father's death.";
const t0 = T(); const end = t0.indexOf(tgt) + tgt.length;
window.__AT.setSelection(end, end);
snap('caret placed');
for (const ch of ' Zq') {
  const code = ch === ' ' ? 'Space' : 'Key' + ch.toUpperCase();
  const kc = ch === ' ' ? 32 : ch.toUpperCase().charCodeAt(0);
  const shift = ch !== ch.toLowerCase();
  __K.ev('keydown', ch, code, kc, { shift });
  __K.ev('keypress', ch, code, ch.charCodeAt(0), { shift, charCode: ch.charCodeAt(0) });
  __K.ev('keyup', ch, code, kc, { shift });
}
snap('sync after keys');
await wait(100); snap('100ms');
await wait(600); snap('700ms');
