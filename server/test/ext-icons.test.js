/* The toolbar icons are the Tracely mark. Owner, 2026-10-14: "also swap the
 * toolbar icons to the new logo". Until 2.21.51 they were the old white paper
 * plane on an orange square; now they are the desktop's logo
 * (src/renderer/src/assets/figma-logo.png), like the launcher (content.js
 * MARK_PNG) and the Settings sidebar (icons/mark.png). The PNGs are decoded
 * here, so the test reads the pixels, not only the header. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.join(HERE, "..", "..", "extension");

// An 8-bit RGBA, non-interlaced PNG, as { w, h, px(x, y) → [r, g, b, a] }.
function decode(file) {
  const buf = readFileSync(file);
  assert.equal(buf.subarray(1, 4).toString("latin1"), "PNG", file);
  let at = 8, w = 0, h = 0;
  const idat = [];
  while (at < buf.length) {
    const len = buf.readUInt32BE(at), type = buf.subarray(at + 4, at + 8).toString("latin1"), data = buf.subarray(at + 8, at + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      assert.deepEqual([data[8], data[9], data[12]], [8, 6, 0], `${file}: 8-bit RGBA, not interlaced`);
    }
    if (type === "IDAT") idat.push(data);
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat)), stride = w * 4, out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? out[y * stride + i - 4] : 0, b = y ? out[(y - 1) * stride + i] : 0, c = i >= 4 && y ? out[(y - 1) * stride + i - 4] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f];
      out[y * stride + i] = (row[i] + pred) & 255;
    }
  }
  return { w, h, px: (x, y) => [...out.subarray(y * stride + x * 4, y * stride + x * 4 + 4)] };
}

for (const n of [16, 48, 128]) {
  test(`icon${n}.png is the Tracely mark: orange on transparent, no white plane`, () => {
    const img = decode(path.join(EXT, "icons", `icon${n}.png`));
    assert.deepEqual([img.w, img.h], [n, n]);
    let solid = 0;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const [r, g, b, a] = img.px(x, y);
      if (a < 200) continue;
      solid++;
      // The plane was white on orange: a solid pixel here is warm (orange to yellow), never white or grey.
      assert.ok(r > 200 && b < 170 && r - b > 80, `icon${n} (${x},${y}) is not the mark's orange: ${[r, g, b, a]}`);
    }
    assert.ok(solid > n * n * 0.12, `icon${n}: the mark is drawn (${solid} solid pixels)`);
    // The old icon filled its square; the mark leaves the corners clear.
    for (const [x, y] of [[0, n - 1], [n - 1, n - 1]]) assert.equal(img.px(x, y)[3], 0, `icon${n} corner (${x},${y})`);
  });
}

test("icon128 keeps Chrome's 16px of transparent padding around 96px of art", () => {
  const img = decode(path.join(EXT, "icons", "icon128.png"));
  for (let i = 0; i < 128; i++) for (let j = 0; j < 16; j++) {
    for (const [x, y] of [[i, j], [i, 127 - j], [j, i], [127 - j, i]]) assert.ok(img.px(x, y)[3] <= 8, `(${x},${y}) is inside the padding`);
  }
});

test("the manifest still names the same three files, for the toolbar and the extension", () => {
  const m = JSON.parse(readFileSync(path.join(EXT, "manifest.json"), "utf8"));
  const want = { 16: "icons/icon16.png", 48: "icons/icon48.png", 128: "icons/icon128.png" };
  assert.deepEqual(m.icons, want);
  assert.deepEqual(m.action.default_icon, want);
});
