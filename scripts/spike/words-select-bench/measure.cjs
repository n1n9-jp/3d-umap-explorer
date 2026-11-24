#!/usr/bin/env node
/**
 * 単語の文字の「選び直し 1 回の時間」と「点ごとの倍率の属性の GPU への転送量」の計測（スパイク。アプリ本体には組み込まない）。
 *
 *   node scripts/spike/switch-stall/make-synth.cjs --out <dataDir>     # 合成データ（MNIST を 7 回複製して雑音を加えた 7 万点。単語は仮の文字列）
 *   node scripts/spike/words-select-bench/measure.cjs --root <checkout> --data <dataDir> [--label after] [--frames 24] [--port 4351] [--out result.json]
 *
 * `--root` は、ビルド済み（dist/ がある）のチェックアウト。修正の前と後を別々のチェックアウトで測って比べる。
 * 合成データは `dist/data/synth/` へコピーし（dist は git 管理外）、`?data=data/synth/` で開く。
 *
 * 測るもの（点群の内部の視点で、カメラを 1 フレームごとに少しずつ回して、毎フレーム単語を選び直させる）:
 *   - 選び直し 1 回の時間: WordLabels の `getState().select`（`lastMs` は単語の選び方と、周りの丸い点の探索の合計。
 *     修正の後は、周りの丸い点の探索の分 `clearMs` も出る）。選び直しごとの値を集め、平均・中央値・最大を出す
 *   - 点ごとの倍率の属性（instanceDotScale。7 万点で 280 KB）への `bufferSubData` の回数とバイト数。WebGL の呼び出しを包んで数えるので、
 *     修正の前と後で同じ方法で測れる（属性のバッファは、`bufferData` の大きさが 点の数 × 4 バイトのもの）。フレームごとの量を出す
 * ソフトウェア描画（SwiftShader）では、7 万点の 1 フレームの描画に 1 秒以上かかるので、フレーム数と状態の変化で待つ（時間では待たない）。
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { loadDataset, computeViews, waitForServer, startPreview, CHROMIUM_ARGS, sub, add, mul, norm, len } = require('../../verify/lib.cjs');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const rootDir = path.resolve(opt('root', ''));
const dataDir = path.resolve(opt('data', ''));
const label = opt('label', 'run');
const port = Number(opt('port', '4351'));
const outFile = opt('out', '');
const FRAMES = Number(opt('frames', '24'));
if (!opt('root', '') || !opt('data', '')) { console.error('--root <checkout> --data <dataDir> が必要です'); process.exit(2); }

const stats = (a) => {
  if (!a.length) return { n: 0 };
  const s = [...a].sort((x, y) => x - y);
  const r = (v) => Math.round(v * 100) / 100;
  return { n: s.length, mean: r(s.reduce((p, c) => p + c, 0) / s.length), median: r(s[Math.floor(s.length / 2)]), max: r(s[s.length - 1]), min: r(s[0]) };
};

async function main() {
  const dest = path.join(rootDir, 'dist/data/synth');
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(dataDir, dest, { recursive: true });
  const ds = loadDataset(dataDir);
  // 合成データは MNIST を複製したものなので、MNIST の視点の求め方（最も密なクラスタの内部）をそのまま使う
  const view = computeViews(ds).views.find((v) => v.name === '3-inside');
  const { base, stop } = startPreview(rootDir, port);
  let browser;
  try {
    await waitForServer(base);
    browser = await chromium.launch({ args: CHROMIUM_ARGS });
    const page = await browser.newPage({ viewport: { width: 960, height: 600 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    // WebGL の呼び出しを包んで、点ごとの倍率の属性のバッファへの bufferSubData を数える（フレームごと）
    await page.addInitScript((count) => {
      const rec = (window.__uploads = { frame: 0, perFrame: [], target: null });
      const wrap = (proto) => {
        const bind = proto.bindBuffer, data = proto.bufferData, sub = proto.bufferSubData;
        const bound = new Map();
        proto.bindBuffer = function (target, buf) { bound.set(target, buf); return bind.call(this, target, buf); };
        proto.bufferData = function (target, src, usage) {
          const bytes = typeof src === 'number' ? src : src.byteLength;
          if (target === this.ARRAY_BUFFER && bytes === count * 4) rec.target = bound.get(target);
          return data.apply(this, arguments);
        };
        proto.bufferSubData = function (target, offset, src, srcOffset, length) {
          if (rec.target && bound.get(target) === rec.target) {
            const bytes = length !== undefined ? length * src.BYTES_PER_ELEMENT : src.byteLength;
            const f = (rec.perFrame[rec.frame] ??= { calls: 0, bytes: 0 });
            f.calls++; f.bytes += bytes;
          }
          return sub.apply(this, arguments);
        };
      };
      wrap(WebGL2RenderingContext.prototype);
      const raf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (cb) => raf((t) => { rec.frame++; cb(t); });
    }, ds.count);
    await page.goto(`${base}?data=data/synth/`);
    await page.waitForFunction(() => window.__explorer && (window.__explorer.ready || window.__explorer.error), null, { timeout: 300000 });
    const ready = await page.evaluate(() => ({ ready: window.__explorer.ready, error: window.__explorer.error ?? null, count: window.__explorer.dataset.getState().current?.count }));
    if (!ready.ready) throw new Error(`データセットを開けません: ${ready.error}`);
    console.log(`[${label}] 表示: ${ready.count} 点`);

    const frames = (n) => page.evaluate((k) => window.__explorer.measureFrames(k), n);
    const words = () => page.evaluate(() => window.__explorer.words.getState());
    // 内部の視点へ。単語が出るまで（カメラが止まって、選び直しと切り替えが終わるまで）待つ
    await page.evaluate((v) => window.__explorer.setView(v), { pos: view.pos, look: view.look });
    let w = null;
    for (let k = 0; k < 30; k++) { await frames(1); w = await words(); if (w.shown.length > 0 && w.fading === 0) break; }
    console.log(`[${label}] 静止: 単語 ${w.shown.length} 語、丸い点を小さくした点 ${w.cleared} 個`);

    // 1 フレームごとに視線を回す（約 1.7 度）。毎フレーム、単語の選び直しが走る
    const pos = view.pos;
    let dir = norm(sub(view.look, view.pos));
    const turn = (d, a) => [d[0] * Math.cos(a) - d[2] * Math.sin(a), d[1], d[0] * Math.sin(a) + d[2] * Math.cos(a)];
    const selectMs = [], clearMs = [], clearedCounts = [], shownCounts = [], uploadFrames = [];
    let prevCount = (await words()).select.count;
    const frame0 = await page.evaluate(() => window.__uploads.frame);
    for (let k = 0; k < FRAMES; k++) {
      dir = turn(dir, 0.03);
      await page.evaluate((v) => window.__explorer.setView(v), { pos, look: add(pos, mul(dir, 0.3)) });
      await frames(1);
      const s = await words();
      if (s.select.count !== prevCount) {
        selectMs.push(s.select.lastMs);
        if (s.select.clearMs !== undefined) clearMs.push(s.select.clearMs);
        prevCount = s.select.count;
      }
      clearedCounts.push(s.cleared);
      shownCounts.push(s.shown.length);
    }
    const up = await page.evaluate(() => window.__uploads);
    const perFrame = [];
    for (let f = frame0; f < up.frame; f++) perFrame.push(up.perFrame[f] ?? { calls: 0, bytes: 0 });
    const bytes = perFrame.map((f) => f.bytes), calls = perFrame.map((f) => f.calls);
    const out = {
      label, points: ready.count, frames: FRAMES,
      selectMs: stats(selectMs), clearMs: stats(clearMs),
      shownWords: stats(shownCounts), clearedPoints: stats(clearedCounts),
      dotScaleUploadBytesPerFrame: stats(bytes), dotScaleUploadCallsPerFrame: stats(calls),
      dotScaleUploadFramesWithUpload: bytes.filter((b) => b > 0).length, renderedFrames: perFrame.length,
      dotScaleTotalBytes: ready.count * 4,
      errors,
    };
    console.log(JSON.stringify(out, null, 2));
    if (outFile) fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
  } finally {
    if (browser) await browser.close();
    stop();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
