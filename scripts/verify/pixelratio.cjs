#!/usr/bin/env node
/**
 * 画面上の大きさが pixelRatio（deviceScaleFactor）によらないことを、ヘッドレス Chromium で検証する。
 *
 *   node scripts/verify/pixelratio.cjs [--data data/mnist/] [--no-build] [--out artifacts/pixelratio]
 *
 * deviceScaleFactor 1 と 2 の同じ大きさ（CSS ピクセル）の画面で、同じ視点を描いて比べる。
 *   - 遠方の点：ホームの視点で、周りに点のない遠い点を選び、中心を含む明るい画素の塊の面積を CSS ピクセル² で測る。
 *   - 数字への切り替え：孤立した点を、画面上の大きさ（CSS ピクセル）が 3・6・8・11・14・18・28 になる距離から見て、
 *     塊の面積（CSS ピクセル²）と、点のセル内で塊が占める割合を測る。切り替え前（丸い点）は小さく、切り替え後（数字）は
 *     数字の形になる。
 * 面積の比（2 / 1）が 0.8〜1.25 に収まらなければ失敗（終了コード 1）。画像は --out に、CSS ピクセルの同じ範囲を
 * 切り出して並べたもの（左 dsf 1、右 dsf 2）を保存する。
 */
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { loadDataset, waitForServer, startPreview, CHROMIUM_ARGS, sub, add, mul, len, norm } = require('./lib.cjs');

const root = path.resolve(__dirname, '../..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const dataPath = opt('data', 'data/mnist/').replace(/\/?$/, '/');
const outDir = path.resolve(root, opt('out', 'artifacts/pixelratio'));
const port = Number(opt('port', '4322'));
const viewport = { width: 1280, height: 800 };
const POINT_SIZE = 0.004; // DEFAULT_PARAMS.pointSize
const SIZES_CSS = [3, 6, 8, 11, 14, 18, 28];

/** 近傍 radius 以内にほかの点がない点のうち、点群の中心から最も遠いもの（外側から見ると背後が空く）。 */
function isolatedPoints({ positions, count }, center, radius, n) {
  const P = (i) => [positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]];
  const cand = [];
  for (let i = 0; i < count; i++) cand.push([len(sub(P(i), center)), i]);
  cand.sort((a, b) => b[0] - a[0]);
  const out = [];
  for (const [, i] of cand) {
    let ok = true;
    for (let j = 0; j < count && ok; j++) if (j !== i && len(sub(P(j), P(i))) < radius) ok = false;
    if (ok) out.push(i);
    if (out.length >= n) break;
  }
  return out.map((i) => ({ index: i, pos: P(i) }));
}

async function main() {
  const ds = loadDataset(path.join(root, 'public', dataPath));
  const center = ds.manifest.bounds.center;
  if (!args.includes('--no-build')) execSync('npm run build', { cwd: root, stdio: 'inherit' });
  fs.mkdirSync(outDir, { recursive: true });
  const iso = isolatedPoints(ds, center, 0.03, 1)[0];
  const outward = norm(sub(iso.pos, center));

  const { base, stop } = startPreview(root, port);
  let browser;
  const failures = [];
  const consoleErrors = [];
  const results = {};
  try {
    await waitForServer(base);
    browser = await chromium.launch({ args: CHROMIUM_ARGS });
    for (const dsf of [1, 2]) {
      const page = await browser.newPage({ viewport, deviceScaleFactor: dsf });
      page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`[dsf ${dsf}] ${m.text()}`); });
      page.on('pageerror', (e) => consoleErrors.push(`[dsf ${dsf}] ${e.message}`));
      await page.goto(`${base}?${new URLSearchParams({ data: dataPath })}`);
      await page.waitForFunction(() => window.__explorer && (window.__explorer.ready || window.__explorer.error), null, { timeout: 60000 });
      const res = { far: null, digits: [] };

      // 中心の点を含む明るい画素の塊の面積（描画バッファの画素）と、外接する範囲を返す。
      const measure = async (cx, cy, halfCss) => page.evaluate(({ cx, cy, halfCss }) => {
        const ex = window.__explorer;
        const s = ex.picking.bufferScale();
        const { width, height, rgba } = ex.picking.readFrame();
        const bg = [7, 8, 12];
        const lit = (x, y) => {
          const o = 4 * (y * width + x);
          return Math.abs(rgba[o] - bg[0]) + Math.abs(rgba[o + 1] - bg[1]) + Math.abs(rgba[o + 2] - bg[2]) > 60;
        };
        const x0 = Math.round(cx * s), y0 = Math.round(cy * s), h = Math.round(halfCss * s);
        // 中心から最も近い明るい画素を種にする
        let seed = null, best = Infinity;
        for (let y = y0 - 3; y <= y0 + 3; y++) for (let x = x0 - 3; x <= x0 + 3; x++) {
          if (lit(x, y) && Math.hypot(x - x0, y - y0) < best) { best = Math.hypot(x - x0, y - y0); seed = [x, y]; }
        }
        // 塊は8近傍で、窓の中だけたどる（数字の線は細く途切れることがあるので、窓の中の明るい画素の総数も返す）
        let area = 0;
        if (seed) {
          const seen = new Set([seed[1] * width + seed[0]]);
          const q = [seed];
          while (q.length) {
            const [x, y] = q.pop(); area++;
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx, ny = y + dy, k = ny * width + nx;
              if (Math.abs(nx - x0) > h || Math.abs(ny - y0) > h || seen.has(k) || !lit(nx, ny)) continue;
              seen.add(k); q.push([nx, ny]);
            }
          }
        }
        let litInWindow = 0;
        for (let y = y0 - h; y <= y0 + h; y++) for (let x = x0 - h; x <= x0 + h; x++) if (lit(x, y)) litInWindow++;
        // 切り出し（CSS ピクセルの範囲 ±halfCss を、描画バッファの画素のまま）
        const c = document.createElement('canvas'); c.width = c.height = 2 * h + 1;
        const g = c.getContext('2d'); const img = g.createImageData(2 * h + 1, 2 * h + 1);
        for (let y = -h; y <= h; y++) for (let x = -h; x <= h; x++) {
          const o = 4 * ((y0 + y) * width + (x0 + x)), p = 4 * ((y + h) * (2 * h + 1) + (x + h));
          img.data[p] = rgba[o]; img.data[p + 1] = rgba[o + 1]; img.data[p + 2] = rgba[o + 2]; img.data[p + 3] = 255;
        }
        g.putImageData(img, 0, 0);
        return { scale: s, areaCss: area / (s * s), litCss: litInWindow / (s * s), png: c.toDataURL('image/png') };
      }, { cx, cy, halfCss });

      // 1) 遠方の点：ホームの視点で、孤立した遠い点（奥側）
      const home = await page.evaluate(() => window.__explorer.homeView());
      await page.evaluate((v) => window.__explorer.setView(v), home);
      await page.evaluate(() => window.__explorer.measureFrames(2));
      const far = await page.evaluate(() => {
        const ex = window.__explorer;
        const n = ex.picking.count;
        const pts = [];
        for (let i = 0; i < n; i++) { const p = ex.picking.project(i); if (p.depth > 0) pts.push({ i, ...p }); }
        // 画面上で 8 CSS ピクセル以内にほかの点がない点を、遠い順に
        const cell = 8, grid = new Map();
        for (const p of pts) { const k = `${Math.floor(p.clientX / cell)},${Math.floor(p.clientY / cell)}`; (grid.get(k) ?? grid.set(k, []).get(k)).push(p); }
        const lonely = pts.filter((p) => {
          if (p.clientX < 20 || p.clientY < 20 || p.clientX > innerWidth - 20 || p.clientY > innerHeight - 20) return false;
          const gx = Math.floor(p.clientX / cell), gy = Math.floor(p.clientY / cell);
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) for (const q of grid.get(`${gx + dx},${gy + dy}`) ?? []) {
            if (q.i !== p.i && Math.hypot(q.clientX - p.clientX, q.clientY - p.clientY) < cell) return false;
          }
          return true;
        });
        lonely.sort((a, b) => b.distance - a.distance);
        return lonely.slice(0, 40).map((p) => ({ i: p.i, x: p.clientX, y: p.clientY, distance: p.distance }));
      });
      res.far = [];
      for (const p of far) {
        const m = await measure(p.x, p.y, 4);
        res.far.push({ ...p, areaCss: m.areaCss, png: m.png });
      }

      // 2) 数字への切り替え：孤立した点を、画面上の大きさが SIZES_CSS になる距離から見る
      const pxPerUnitAt1 = 0.5 * viewport.height / Math.tan(Math.PI / 6); // CSS ピクセル / ワールド単位（距離 1）
      for (const sizeCss of SIZES_CSS) {
        const s = (POINT_SIZE * pxPerUnitAt1) / sizeCss; // この距離で、ビルボードがちょうど sizeCss（下支えがなければ）
        const pos = add(iso.pos, mul(outward, s));
        await page.evaluate((v) => window.__explorer.setView(v), { pos, look: iso.pos });
        await page.evaluate(() => window.__explorer.measureFrames(2));
        const pr = await page.evaluate((i) => window.__explorer.picking.project(i), iso.index);
        const m = await measure(pr.clientX, pr.clientY, Math.max(8, sizeCss * 0.75));
        res.digits.push({ sizeCss, distance: s, areaCss: m.areaCss, litCss: m.litCss, png: m.png });
      }
      results[dsf] = res;
      await page.close();
    }

    // 比べる
    const ratio = (a, b) => (a > 0 ? b / a : NaN);
    const farRows = results[1].far.map((p) => {
      const q = results[2].far.find((x) => x.i === p.i);
      return q ? { i: p.i, a1: p.areaCss, a2: q.areaCss, r: ratio(p.areaCss, q.areaCss) } : null;
    }).filter(Boolean);
    console.log(`遠方の点（ホームの視点、孤立した遠い点 ${farRows.length} 個。先頭 10 個を表示）：塊の面積（CSS ピクセル²）`);
    for (const r of farRows.slice(0, 10)) console.log(`  点 ${r.i}: dsf1 ${r.a1.toFixed(2)} / dsf2 ${r.a2.toFixed(2)}（比 ${r.r.toFixed(2)}）`);
    const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const m1 = mean(farRows.map((r) => r.a1)), m2 = mean(farRows.map((r) => r.a2));
    const farRatio = m2 / m1;
    console.log(`  面積の平均 dsf1 ${m1.toFixed(2)} / dsf2 ${m2.toFixed(2)}（比 ${farRatio.toFixed(2)}）。最小サイズ 3 CSS ピクセルの丸い点の半径 ${(0.4 * 3).toFixed(1)} → 面積 ≈ ${(Math.PI * 1.2 * 1.2).toFixed(1)}`);
    if (!(farRatio > 0.8 && farRatio < 1.25)) failures.push(`遠方の点の面積の比 ${farRatio.toFixed(2)}`);

    console.log(`数字への切り替え（点 ${iso.index}）：画面上の大きさ（CSS ピクセル）ごとの、中心の塊の面積 / 窓の中の明るい画素（CSS ピクセル²）`);
    SIZES_CSS.forEach((sz, k) => {
      const a = results[1].digits[k], b = results[2].digits[k];
      const r = ratio(a.areaCss, b.areaCss), rl = ratio(a.litCss, b.litCss);
      console.log(`  ${String(sz).padStart(2)}px（距離 ${a.distance.toFixed(3)}）: dsf1 ${a.areaCss.toFixed(1)} / ${a.litCss.toFixed(1)}、dsf2 ${b.areaCss.toFixed(1)} / ${b.litCss.toFixed(1)}（比 ${r.toFixed(2)} / ${rl.toFixed(2)}）`);
      if (!(rl > 0.8 && rl < 1.25)) failures.push(`${sz}px の明るい画素の比 ${rl.toFixed(2)}`);
    });

    // 画像：左 dsf 1（2 倍に拡大）、右 dsf 2（等倍）。どちらも CSS ピクセルの同じ範囲
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    await page.setContent('<body style="margin:0;background:#333"></body>');
    const sheet = async (file, items, title) => {
      await page.evaluate(({ items, title }) => {
        document.body.innerHTML = `<div style="color:#ddd;font:14px sans-serif;padding:8px">${title}</div>`;
        const wrap = document.createElement('div'); wrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:12px;padding:8px';
        for (const it of items) {
          const cell = document.createElement('div'); cell.style.cssText = 'color:#ddd;font:12px sans-serif';
          cell.innerHTML = `<div>${it.label}</div>`;
          const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:4px';
          for (const [src, k] of [[it.a, 2], [it.b, 1]]) {
            const img = new Image(); img.src = src; img.style.imageRendering = 'pixelated';
            img.onload = () => { img.width = img.naturalWidth * k * 4; };
            row.appendChild(img);
          }
          cell.appendChild(row); wrap.appendChild(cell);
        }
        document.body.appendChild(wrap);
      }, { items, title });
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(outDir, file), fullPage: true });
    };
    await sheet('digits.png', SIZES_CSS.map((sz, k) => ({ label: `${sz}px`, a: results[1].digits[k].png, b: results[2].digits[k].png })),
      '数字への切り替え：各組の左が deviceScaleFactor 1、右が 2（同じ CSS ピクセルの範囲を同じ表示倍率で）');
    await sheet('far.png', results[1].far.slice(0, 8).map((p) => ({ label: `点 ${p.i}`, a: p.png, b: results[2].far.find((x) => x.i === p.i)?.png ?? p.png })),
      '遠方の点：各組の左が deviceScaleFactor 1、右が 2');
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ iso, farRows, digits: SIZES_CSS.map((sz, k) => ({ sizeCss: sz, dsf1: { area: results[1].digits[k].areaCss, lit: results[1].digits[k].litCss }, dsf2: { area: results[2].digits[k].areaCss, lit: results[2].digits[k].litCss } })), consoleErrors }, null, 2));
    if (consoleErrors.length) failures.push(`コンソールエラー:\n${consoleErrors.join('\n')}`);
    console.log(failures.length ? `失敗:\n${failures.join('\n')}` : '失敗: なし');
    process.exitCode = failures.length ? 1 : 0;
  } finally {
    if (browser) await browser.close();
    stop();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
