import { chromium, EXE } from "./pw.mjs";
const b = await chromium.launch({ executablePath: EXE, headless: true });
const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
await p.goto('https://docs.google.com/document/d/1J6UBuUcjzmmFmtMhmScUGc4iTRkKv-RFAXGy2U6tWfo/edit', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(6000);
console.log(JSON.stringify(await p.evaluate(async () => { const at = await window._docs_annotate_getAnnotatedText('tracely'); const t = at.getText(); let h = 0; for (const c of t) h = (h * 31 + c.charCodeAt(0)) | 0; return { len: t.length, h, hasMarkers: /Zq|PASTED|APPENDED|Works Cited|storyline|Typed/.test(t) }; })));
await b.close();
