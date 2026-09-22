const until = async (pred, ms = 2000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return Date.now() - t0; await wait(25); } return -1; };
const AT = window.__AT;
// (a)+(b) select exact sentence by offset, replace via paste
const sent = "However, Rooster still holds a grudge and blames Maverick for his father's death.";
const repl = "However, Rooster still blames Maverick for the death of his father, Goose.";
let t = T(); let s = t.indexOf(sent);
AT.setSelection(s, s + sent.length);
const selOk = JSON.stringify(AT.getSelection()) === JSON.stringify([{ start: s, end: s + sent.length }]);
__T.paste(repl);
const msB = await until(() => T().includes(repl));
snap(`(b) replace selOk=${selOk} ms=${msB}`);
// (c) insert after sentence
t = T(); s = t.indexOf(repl) + repl.length;
AT.setSelection(s, s);
const cite = " (Top Gun: Maverick, Paramount, 2022)";
__T.paste(cite);
const msC = await until(() => T().includes(repl + cite));
snap(`(c) insert-after ms=${msC}`);
// (d1) append line at end: caret at end of last non-empty paragraph, Enter via keypress(13), then paste
t = T(); const lastText = "recommended to watch it."; s = t.indexOf(lastText) + lastText.length;
AT.setSelection(s, s);
__K.ev('keydown', 'Enter', 'Enter', 13); __K.ev('keypress', 'Enter', 'Enter', 13, { charCode: 13 }); __K.ev('keyup', 'Enter', 'Enter', 13);
const msEnter = await until(() => T().includes(lastText + "\n\n\n"), 800);
snap(`(d1) Enter keypress ms=${msEnter}`);
const line = "Works Cited: Top Gun: Maverick. Paramount Pictures, 2022.";
__T.paste(line);
const msD = await until(() => T().includes(line));
snap(`(d1) appended line ms=${msD}`);
// (d2) paste containing a newline
t = T(); s = t.indexOf(line) + line.length;
AT.setSelection(s, s);
__T.paste("\nSecond line via pasted newline.");
const msD2 = await until(() => T().includes("Second line via pasted newline."));
snap(`(d2) paste with \\n ms=${msD2} nlBefore=${JSON.stringify(T().slice(T().indexOf('Second line') - 2, T().indexOf('Second line')))}`);
// (e) beforeinput insertParagraph
t = T(); s = t.indexOf("Second line via pasted newline.") + "Second line via pasted newline.".length;
AT.setSelection(s, s);
const tg = __K.target(); const W = tg.ownerDocument.defaultView;
tg.dispatchEvent(new W.InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertParagraph' }));
tg.dispatchEvent(new W.InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: 'Third line via beforeinput.' }));
await wait(300);
snap(`(e) beforeinput insertParagraph+insertText`);
// (f) HTML paste with a link
t = T(); s = t.indexOf(cite) + cite.length - 1; // before ')'
AT.setSelection(s, s);
__T.paste(' link', ' <a href="https://example.com/source">link</a>');
await until(() => T().includes(' link)'));
snap(`(f) html paste`);
window.__annotations = AT.getAnnotations();
snap('annotations=' + JSON.stringify(AT.getAnnotations()).slice(0, 400));
// (g) undo once
__K.ev('keydown', 'z', 'KeyZ', 90, { meta: true }); __K.ev('keyup', 'z', 'KeyZ', 90, { meta: true });
await wait(400);
snap('(g) after one Cmd+Z');
window.__finalText = T();
