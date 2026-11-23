#!/usr/bin/env node
/**
 * 2 つのディレクトリの同名の PNG を画素単位で比べる（変更の前後で表示が同じかの確認用）。
 *
 *   node scripts/verify/imagediff.cjs <前のディレクトリ> <後のディレクトリ> [--exclude x,y,w,h ...]
 *
 * --exclude の矩形（CSS ピクセル）の中は比べない（UI の追加部分など）。違う画素があれば、数と範囲を出し、終了コード 1 で終わる。
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const args = process.argv.slice(2);
const [dirA, dirB] = args;
const excludes = [];
for (let i = 2; i < args.length; i++) if (args[i] === '--exclude') excludes.push(args[++i].split(',').map(Number));

async function main() {
  const files = fs.readdirSync(dirA).filter((f) => f.endsWith('.png') && fs.existsSync(path.join(dirB, f)));
  const browser = await chromium.launch();
  const page = await browser.newPage();
  let bad = 0;
  for (const f of files) {
    const a = fs.readFileSync(path.join(dirA, f)).toString('base64');
    const b = fs.readFileSync(path.join(dirB, f)).toString('base64');
    const r = await page.evaluate(async ({ a, b, excludes }) => {
      const load = async (s) => { const img = new Image(); img.src = `data:image/png;base64,${s}`; await img.decode(); return img; };
      const [ia, ib] = await Promise.all([load(a), load(b)]);
      if (ia.width !== ib.width || ia.height !== ib.height) return { sizeMismatch: true };
      const read = (img) => { const c = new OffscreenCanvas(img.width, img.height); const g = c.getContext('2d'); g.drawImage(img, 0, 0); return g.getImageData(0, 0, img.width, img.height).data; };
      const da = read(ia), db = read(ib);
      let n = 0, maxDiff = 0; const box = [Infinity, Infinity, -Infinity, -Infinity];
      for (let y = 0; y < ia.height; y++) for (let x = 0; x < ia.width; x++) {
        if (excludes.some(([ex, ey, ew, eh]) => x >= ex && x < ex + ew && y >= ey && y < ey + eh)) continue;
        const o = 4 * (y * ia.width + x);
        const d = Math.max(Math.abs(da[o] - db[o]), Math.abs(da[o + 1] - db[o + 1]), Math.abs(da[o + 2] - db[o + 2]));
        if (d > 0) { n++; maxDiff = Math.max(maxDiff, d); box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], y); box[2] = Math.max(box[2], x); box[3] = Math.max(box[3], y); }
      }
      return { n, maxDiff, box, total: ia.width * ia.height };
    }, { a, b, excludes });
    if (r.sizeMismatch) { console.log(`${f}: 大きさが違う`); bad++; continue; }
    console.log(`${f}: 違う画素 ${r.n} / ${r.total}${r.n ? `（最大差 ${r.maxDiff}、範囲 x ${r.box[0]}..${r.box[2]}, y ${r.box[1]}..${r.box[3]}）` : ''}`);
    if (r.n) bad++;
  }
  await browser.close();
  process.exitCode = bad ? 1 : 0;
}
main().catch((e) => { console.error(e); process.exit(1); });
