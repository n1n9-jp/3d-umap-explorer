#!/usr/bin/env node
/**
 * 計算した座標を表示へ切り替えるとき（点の移動と、空間の構造・空間索引の作り直し）の、メインスレッドの停止時間の計測。
 *
 *   node scripts/spike/switch-stall/make-synth.cjs --out <dataDir>      # 合成データ（7 万点）を作る
 *   node scripts/spike/switch-stall/measure.cjs --root <checkout> --data <dataDir> [--label after] [--port 4350] [--out result.json]
 *
 * `--root` は、ビルド済み（dist/ がある）のチェックアウト。修正の前と後を別々のチェックアウトで測って比べる。
 * 合成データは `dist/data/synth/` へコピーし（dist は git 管理外）、`?data=data/synth/` で開く。
 * UMAP を最初から最後まで計算させ（7 万点・近傍数 15・200 エポック。数分かかる）、次の 3 つの時間帯のメインスレッドの止まりを記録する。
 *   - running  : 計算中（Worker が計算している間。描画とカメラ操作はメインスレッドで続く）。基準になる止まり
 *   - switch   : phase が 'morphing' の間（点を動かし、空間の構造を作り直し、表示を作り直すまで）
 *   - after    : 表示を切り替え終えたあと 3 秒
 * 止まりは 2 通りで見る。
 *   (1) `performance.measure('umap:…')`（src/compute/umapFeature.ts が、メインスレッドで同期的に動く区間に付ける）：
 *       `umap:align`（結果の位置合わせ）、`umap:build`（空間の構造と空間索引の構築。修正の前はここがメインスレッドの計算、後は Worker の結果の取り込みだけ）、
 *       `umap:replaceView`（表示の作り直し）。`build` と `replaceView` は続けて動くので、その合計が、切り替えでメインスレッドが 1 つのタスクで止まる時間。
 *       `umap:structure-worker` は、修正の後の、Worker での構造の計算の所要時間（Worker の起動から結果が届くまで。メインスレッドは止まらない）。
 *       修正の前の比較用のチェックアウトには、同じ名前の `performance.measure` を足して測る（計算の中身は変えない）。
 *   (2) `longtask`（50 ミリ秒を超えるタスク）。ソフトウェア描画（SwiftShader）では、7 万点の 1 フレームの描画だけでメインスレッドが
 *       1.5 秒前後止まるので、描画のコマ落ちが支配的になり、切り替えの止まりは分離できない（参考値として出す）。
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { waitForServer, startPreview, CHROMIUM_ARGS } = require('../../verify/lib.cjs');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const rootDir = path.resolve(opt('root', ''));
const dataDir = path.resolve(opt('data', ''));
const label = opt('label', 'run');
const port = Number(opt('port', '4350'));
const outFile = opt('out', '');
if (!opt('root', '') || !opt('data', '')) { console.error('--root <checkout> --data <dataDir> が必要です'); process.exit(2); }

async function main() {
  const dest = path.join(rootDir, 'dist/data/synth');
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(dataDir, dest, { recursive: true });
  const { base, stop } = startPreview(rootDir, port);
  let browser;
  try {
    await waitForServer(base);
    browser = await chromium.launch({ args: CHROMIUM_ARGS });
    const page = await browser.newPage({ viewport: { width: 960, height: 600 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}?data=data/synth/`);
    await page.waitForFunction(() => window.__explorer && (window.__explorer.ready || window.__explorer.error), null, { timeout: 300000 });
    const ready = await page.evaluate(() => ({ ready: window.__explorer.ready, error: window.__explorer.error ?? null, count: window.__explorer.dataset.getState().current?.count }));
    if (!ready.ready) throw new Error(`データセットを開けません: ${ready.error}`);
    console.log(`[${label}] 表示: ${ready.count} 点`);

    // 計測器をページに入れる
    await page.evaluate(() => {
      const rec = (window.__stall = { long: [], gaps: [], phases: [], cbs: [], t0: performance.now() });
      new PerformanceObserver((list) => { for (const e of list.getEntries()) rec.long.push({ start: e.startTime, dur: e.duration }); }).observe({ entryTypes: ['longtask'] });
      // 描画ループ（requestAnimationFrame のコールバック）の実行時間を記録する
      const raf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (cb) => raf((t) => {
        const a = performance.now();
        try { cb(t); } finally { rec.cbs.push({ start: a, end: performance.now() }); }
      });
      let last = performance.now();
      const beat = () => {
        const now = performance.now();
        rec.gaps.push({ t: now, gap: now - last });
        last = now;
        const s = window.__explorer.umap.getState();
        const ph = s.loaded ? s.phase : 'idle';
        if (!rec.phases.length || rec.phases[rec.phases.length - 1].phase !== ph) rec.phases.push({ t: now, phase: ph });
        setTimeout(beat, 4);
      };
      setTimeout(beat, 4);
    });
    const t0 = Date.now();
    const result = await page.evaluate(() => window.__explorer.umap.compute({ nNeighbors: 15, minDist: 0.1, seed: 42 }));
    console.log(`[${label}] 計算と切り替え: ${((Date.now() - t0) / 1000).toFixed(0)} 秒 ${JSON.stringify(result)}`);
    await page.waitForTimeout(3500);
    const rec = await page.evaluate(() => window.__stall);
    const state = await page.evaluate(() => window.__explorer.umap.getState());
    const marks = await page.evaluate(() => performance.getEntriesByType('measure').filter((e) => e.name.startsWith('umap:')).map((e) => ({ name: e.name, start: e.startTime, ms: e.duration })));
    const ms = (name) => Math.round(marks.filter((m) => m.name === name).reduce((a, m) => a + m.ms, 0) * 10) / 10;
    const sync = { alignMs: ms('umap:align'), buildMs: ms('umap:build'), replaceViewMs: ms('umap:replaceView') };
    sync.structureWorkerWallMs = ms('umap:structure-worker'); // 修正の後だけ（Worker の起動から結果が届くまで。点を動かしている間に進む）
    sync.buildPlusReplaceMs = Math.round((sync.buildMs + sync.replaceViewMs) * 10) / 10;
    sync.maxSingleTaskMs = Math.max(sync.alignMs, sync.buildPlusReplaceMs);

    // 時間帯に分ける
    const ph = rec.phases;
    const firstOf = (name, from = 0) => ph.find((p, i) => i >= from && p.phase === name);
    const running = firstOf('running');
    const morphing = firstOf('morphing');
    const idleAfter = morphing ? ph.find((p) => p.t > morphing.t && p.phase === 'idle') : null;
    if (!running || !morphing || !idleAfter) throw new Error(`phase の変化を記録できませんでした: ${JSON.stringify(ph)}`);
    const windows = {
      running: [running.t, morphing.t],
      switch: [morphing.t, idleAfter.t],
      after: [idleAfter.t, idleAfter.t + 3000],
    };
    const summarize = ([a, b]) => {
      const long = rec.long.filter((e) => e.start + e.dur > a && e.start < b).map((e) => {
        // タスクの中で実行された描画ループのコールバックの時間を引く
        const frame = rec.cbs.filter((c) => c.start >= e.start - 1 && c.end <= e.start + e.dur + 1).reduce((m, c) => m + (c.end - c.start), 0);
        return { dur: e.dur, nonFrame: Math.max(0, e.dur - frame) };
      });
      const gaps = rec.gaps.filter((g) => g.t > a && g.t - g.gap < b);
      const maxGap = gaps.reduce((m, g) => Math.max(m, g.gap), 0);
      const maxLong = long.reduce((m, e) => Math.max(m, e.dur), 0);
      const maxNonFrame = long.reduce((m, e) => Math.max(m, e.nonFrame), 0);
      return {
        ms: Math.round(b - a), maxTimerGapMs: Math.round(maxGap), maxLongTaskMs: Math.round(maxLong), maxNonFrameMs: Math.round(maxNonFrame),
        nonFrameOver100ms: long.filter((e) => e.nonFrame > 100).map((e) => Math.round(e.nonFrame)),
      };
    };
    const summary = Object.fromEntries(Object.entries(windows).map(([k, w]) => [k, summarize(w)]));
    const out = { label, points: ready.count, outcome: result, lastRun: state.lastRun, mainThreadSync: sync, summary, errors };
    console.log(JSON.stringify(out, null, 2));
    if (outFile) fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
  } finally {
    if (browser) await browser.close();
    stop();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
