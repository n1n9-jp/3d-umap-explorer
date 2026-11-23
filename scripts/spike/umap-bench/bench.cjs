#!/usr/bin/env node
// ヘッドレス Chromium で dist/ のページを開き、条件ごとに Worker で UMAP を計算して計測する。
//   node bench.cjs [--only <正規表現>] [--force] [--out results/browser.json]
// 条件ごとに新しいブラウザを起動する（メモリ・JIT の状態を揃えるため）。結果は条件ごとに追記して保存する。
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { start } = require('./server.cjs');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const only = new RegExp(opt('--only', '.'));
const force = args.includes('--force');
const outFile = path.resolve(__dirname, opt('--out', 'results/browser.json'));
const TRIAL_TIMEOUT_MS = Number(opt('--timeout', 40 * 60 * 1000));

// 条件の一覧。atlas の既定エポック数は run() が決める（10k は 500 だった）。umap-js の既定は 10k・7万点とも 200。
function conditions() {
  const list = [];
  for (const dataset of ['10k', '70k']) {
    for (const n of [15, 50]) {
      const base = { dataset, n, seed: 42, minDist: 0.1 };
      const small = dataset === '10k';
      list.push({ id: `${dataset}_n${n}_atlas_def`, engine: 'atlas', nEpochs: 0, ...base, warmRun: small, repeat: small, save: `${dataset}_n${n}_atlas_def` });
      list.push({ id: `${dataset}_n${n}_atlas_e200`, engine: 'atlas', nEpochs: 200, ...base, warmRun: small, repeat: small, save: `${dataset}_n${n}_atlas_e200` });
      list.push({ id: `${dataset}_n${n}_umapjs_def`, engine: 'umapjs', nEpochs: 0, ...base, warmRun: small, repeat: small, save: `${dataset}_n${n}_umapjs_def` });
      if (small) list.push({ id: `${dataset}_n${n}_umapjs_e500`, engine: 'umapjs', nEpochs: 500, ...base, warmRun: false, repeat: false, save: `${dataset}_n${n}_umapjs_e500` });
    }
  }
  // 追加: atlas の初期化を random にした場合、step() で進めて途中の座標を読む場合
  list.push({ id: '10k_n15_atlas_def_random', engine: 'atlas', nEpochs: 0, dataset: '10k', n: 15, seed: 42, minDist: 0.1, initializeMethod: 'random', save: '10k_n15_atlas_def_random' });
  list.push({ id: '10k_n15_atlas_step200', engine: 'atlas', nEpochs: 200, mode: 'step', chunk: 10, snapshots: true, dataset: '10k', n: 15, seed: 42, minDist: 0.1, save: '10k_n15_atlas_step200' });
  list.push({ id: '10k_n15_atlas_stepdecay200', engine: 'atlas', nEpochs: 200, mode: 'stepdecay', chunk: 10, snapshots: true, dataset: '10k', n: 15, seed: 42, minDist: 0.1, save: '10k_n15_atlas_stepdecay200' });
  list.push({ id: '10k_n15_atlas_stepdecay200_c1', engine: 'atlas', nEpochs: 200, mode: 'stepdecay', chunk: 1, dataset: '10k', n: 15, seed: 42, minDist: 0.1, save: '10k_n15_atlas_stepdecay200_c1' });
  // 中断の確認（2 秒後 / 3 秒後に cancel を送る）。yieldEvery はイベントループへ戻る間隔
  const cb = { dataset: '10k', n: 15, seed: 42, minDist: 0.1 };
  list.push({ id: '10k_n15_atlas_cancel_run', engine: 'atlas', nEpochs: 0, mode: 'run', cancelAfterMs: 2000, ...cb });
  list.push({ id: '10k_n15_atlas_cancel_stepdecay_noyield', engine: 'atlas', nEpochs: 200, mode: 'stepdecay', chunk: 10, yieldEvery: 0, cancelAfterMs: 2000, ...cb });
  list.push({ id: '10k_n15_atlas_cancel_stepdecay_yield', engine: 'atlas', nEpochs: 200, mode: 'stepdecay', chunk: 10, yieldEvery: 1, cancelAfterMs: 2000, ...cb });
  list.push({ id: '10k_n15_umapjs_cancel_noyield', engine: 'umapjs', nEpochs: 0, yieldEvery: 0, cancelAfterMs: 3000, ...cb });
  list.push({ id: '10k_n15_umapjs_cancel_yield5', engine: 'umapjs', nEpochs: 0, yieldEvery: 5, cancelAfterMs: 3000, ...cb });
  list.push({ id: '10k_n15_atlas_stepdecay200_yield', engine: 'atlas', nEpochs: 200, mode: 'stepdecay', chunk: 10, yieldEvery: 1, snapshots: true, save: '10k_n15_atlas_stepdecay200_yield', ...cb });
  list.push({ id: '10k_n15_umapjs_def_yield5', engine: 'umapjs', nEpochs: 0, yieldEvery: 5, save: '10k_n15_umapjs_def_yield5', ...cb });
  // WebGPU（gpu: true）の動作確認。この環境には実 GPU がなく、SwiftShader（CPU によるソフトウェア実装）の WebGPU で動くかだけを見る（速度は参考外）
  list.push({ id: '10k_n15_atlas_gpu_swiftshader_e50', engine: 'atlas', nEpochs: 50, gpu: true, launchArgs: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-angle=swiftshader', '--disable-vulkan-surface'], save: '10k_n15_atlas_gpu_swiftshader_e50', ...cb });
  list.push({ id: '10k_n15_atlas_cpu_e50', engine: 'atlas', nEpochs: 50, save: '10k_n15_atlas_cpu_e50', ...cb });
  return list;
}

// ブラウザ関連プロセスの RSS（匿名メモリ）の合計（KB）。Worker はレンダラープロセスの中で動く
function chromeMemKB() {
  let total = 0, renderer = 0;
  for (const pid of fs.readdirSync('/proc').filter((s) => /^\d+$/.test(s))) {
    try {
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      if (!/chrom|headless_shell/i.test(cmd)) continue;
      const st = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      const anon = Number((st.match(/RssAnon:\s+(\d+)/) || [])[1] || 0);
      const rss = Number((st.match(/VmRSS:\s+(\d+)/) || [])[1] || 0);
      total += anon;
      if (/--type=renderer/.test(cmd)) renderer += rss;
    } catch { /* プロセスが消えた */ }
  }
  return { anonKB: total, rendererRssKB: renderer };
}

function sampler() {
  const base = chromeMemKB();
  let peak = { ...base };
  const timer = setInterval(() => {
    const m = chromeMemKB();
    if (m.anonKB > peak.anonKB) peak.anonKB = m.anonKB;
    if (m.rendererRssKB > peak.rendererRssKB) peak.rendererRssKB = m.rendererRssKB;
  }, 100);
  return { stop() { clearInterval(timer); return { baseAnonMB: base.anonKB / 1024, peakAnonMB: peak.anonKB / 1024, deltaAnonMB: (peak.anonKB - base.anonKB) / 1024, baseRendererRssMB: base.rendererRssKB / 1024, peakRendererRssMB: peak.rendererRssKB / 1024 }; } };
}

function withTimeout(p, ms, what) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout: ' + what)), ms); })]).finally(() => clearTimeout(t));
}

async function runCondition(url, cond) {
  const browser = await chromium.launch({ args: cond.launchArgs || [] });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    page.on('pageerror', (e) => console.error('  pageerror', e.message));
    page.on('console', (m) => { if (m.type() === 'error') console.error('  console.error', m.text()); });
    await page.goto(url);
    await page.waitForFunction(() => window.benchReady === true);
    await page.waitForTimeout(500);
    const out = { id: cond.id, cfg: cond };
    const s1 = sampler();
    out.trialA = await withTimeout(page.evaluate((c) => window.bench.trial(c), cond), TRIAL_TIMEOUT_MS, cond.id + ' A');
    out.memA = s1.stop();
    if (cond.repeat) {
      out.trialB = await withTimeout(page.evaluate((c) => window.bench.trial({ ...c, warmRun: false, save: c.save + '_B' }), cond), TRIAL_TIMEOUT_MS, cond.id + ' B');
      out.crossWorkerBitIdentical = out.trialA.run1.hash === out.trialB.run1.hash;
    }
    return out;
  } finally {
    await browser.close();
  }
}

(async () => {
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const all = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : { runs: {} };

  // ベースライン（アイドル時と、メインスレッドを 200ms 止めたとき）
  if (force || !all.baseline) {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.goto(url);
    await page.waitForFunction(() => window.benchReady === true);
    all.env = await page.evaluate(() => window.bench.info());
    all.baseline = await page.evaluate(() => window.bench.baseline());
    await browser.close();
    console.log('baseline', JSON.stringify(all.baseline));
    fs.writeFileSync(outFile, JSON.stringify(all, null, 2));
  }

  for (const cond of conditions()) {
    if (!only.test(cond.id)) continue;
    if (all.runs[cond.id] && !force) { console.log('skip (done)', cond.id); continue; }
    const t0 = Date.now();
    console.log('run', cond.id);
    try {
      const r = await runCondition(url, cond);
      all.runs[cond.id] = r;
      const a = r.trialA.run1;
      console.log(`  startup ${r.trialA.startupMs.toFixed(0)}ms init ${a.initMs.toFixed(0)}ms opt ${a.optimizeMs.toFixed(0)}ms epochs ${a.epochsDone} raf median ${r.trialA.raf.median?.toFixed(1)} max ${r.trialA.raf.max?.toFixed(1)} mem+${r.memA.deltaAnonMB.toFixed(0)}MB (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    } catch (e) {
      console.error('  FAILED', cond.id, e.message);
      all.runs[cond.id] = { id: cond.id, cfg: cond, error: e.message };
    }
    fs.writeFileSync(outFile, JSON.stringify(all, null, 2));
  }
  server.close();
})();
