#!/usr/bin/env node
// results/*.json から README 用の表（Markdown）を作って標準出力へ出す。
const fs = require('fs');
const path = require('path');
const R = (f) => { const p = path.join(__dirname, 'results', f); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; };
const br = R('browser.json'), nd = R('node.json'), q = R('quality.json');
const f0 = (x) => (x == null ? '—' : Math.round(x).toLocaleString('en-US'));
const f1 = (x) => (x == null ? '—' : x.toFixed(1));
const s = (ms) => (ms == null ? '—' : (ms / 1000).toFixed(ms >= 10000 ? 1 : 2));
const f3 = (x) => (x == null ? '—' : x.toFixed(3));
const label = { atlas: 'embedding-atlas (Wasm)', umapjs: 'umap-js' };
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

function cold(run) {
  const t = [run.trialA, run.trialB].filter(Boolean);
  const pick = (g) => mean(t.map(g));
  const prep = (x) => x.startupMs + (x.run1.convertMs ?? 0) + x.run1.initMs;
  return {
    samples: t.length,
    prepMs: pick(prep),
    startupMs: pick((x) => x.startupMs),
    convertMs: pick((x) => x.run1.convertMs ?? 0),
    initMs: pick((x) => x.run1.initMs),
    optMs: pick((x) => x.run1.optimizeMs),
    totalMs: pick((x) => prep(x) + x.run1.optimizeMs),
    spread: t.length > 1 ? Math.abs(t[0].run1.optimizeMs - t[1].run1.optimizeMs) / mean(t.map((x) => x.run1.optimizeMs)) : null,
    rafMedian: pick((x) => x.raf.median),
    rafP95: pick((x) => x.raf.p95),
    rafMax: Math.max(...t.map((x) => x.raf.max)),
    epochs: t[0].run1.epochsDone,
  };
}

const ids = Object.keys(br.runs).sort((a, b) => {
  const key = (id) => [id.startsWith('10k') ? 0 : 1, Number((id.match(/_n(\d+)_/) || [])[1] || 0), id];
  const A = key(a), B = key(b); return A[0] - B[0] || A[1] - B[1] || (A[2] < B[2] ? -1 : 1);
});
const main = ids.filter((id) => /^(10k|70k)_n(15|50)_(atlas_def|atlas_e200|umapjs_def|umapjs_e500)$/.test(id));

console.log('### 計測結果（ブラウザ: ヘッドレス Chromium、Worker 内）\n');
console.log('時間は秒。「準備」= Worker 起動（モジュール評価）＋ kNN の配列変換（umap-js のみ）＋ 初期化（Wasm の読み込み、グラフ構築、初期座標）。「最適化」= エポックの反復。' +
  '10k は 2 回（別々の Worker）の平均、70k は 1 回。rAF はメインスレッドの `requestAnimationFrame` の間隔（ms）。メモリは計算中のブラウザ全プロセスの匿名メモリの増加量の最大値（MB）。\n');
console.log('| 点数 | n | 手段 | エポック | 準備 | 最適化 | 合計 | rAF 中央値 / p95 / 最大 (ms) | メモリ増 (MB) | Node 合計 (準備+最適化) | ブラウザ/Node |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|');
for (const id of main) {
  const r = br.runs[id];
  const [, ds, n, eng, ep] = id.match(/^(\w+?)_n(\d+)_(atlas|umapjs)_(\w+)$/).slice(0, 5).length ? id.match(/^(\w+?)_n(\d+)_(atlas|umapjs)_(\w+)$/) : [];
  if (r.error) { console.log(`| ${ds} | ${n} | ${label[eng]} | ${ep} | 未計測（${r.error.slice(0, 60)}） | | | | | | |`); continue; }
  const c = cold(r);
  const nr = nd && nd.runs[id] && !nd.runs[id].error ? nd.runs[id] : null;
  const nodeTotal = nr ? (nr.convertMs ?? 0) + nr.initMs + nr.optimizeMs : null;
  const note = ds === '70k' && eng === 'atlas' ? (ep === 'e200' ? '（同条件の再測定）' : '（既定）') : '';
  console.log(`| ${ds} | ${n} | ${label[eng]}${note} | ${c.epochs} | ${s(c.prepMs)} | ${s(c.optMs)} | **${s(c.totalMs)}** | ${f1(c.rafMedian)} / ${f1(c.rafP95)} / ${f1(c.rafMax)} | ${f0(r.memA.deltaAnonMB)} | ${nr ? s(nodeTotal) : '未計測'} | ${nr ? (c.totalMs / nodeTotal).toFixed(2) + '×' : '—'} |`);
}

console.log('\n### 準備の内訳（秒）と同一 Worker での 2 回目（ウォーム）\n');
console.log('| 条件 | Worker 起動 | 配列変換 | 初期化 | 準備 計 | 2 回目の準備（ウォーム） | 2 回目の最適化 | 最適化のばらつき（2 回の差/平均） |');
console.log('|---|---|---|---|---|---|---|---|');
for (const id of main) {
  const r = br.runs[id]; if (r.error) continue;
  const c = cold(r);
  const w = r.trialA.run2;
  console.log(`| ${id} | ${s(c.startupMs)} | ${s(c.convertMs)} | ${s(c.initMs)} | ${s(c.prepMs)} | ${w ? s((w.convertMs ?? 0) + w.initMs) : '—'} | ${w ? s(w.optimizeMs) : '—'} | ${c.spread == null ? '—' : (c.spread * 100).toFixed(1) + '%'} |`);
}

if (q) {
  console.log('\n### 結果の質（3 次元の近傍のラベル一致率、高次元 15 近傍の再現率、ラベル重心の配置）\n');
  console.log('「配置の相関」= ラベルごとの重心どうしの距離（45 組）の、既存の事前計算との相関（1 に近いほど、数字どうしの並びが同じ）。7万点は合成データで、ラベル一致率は参考外（複製された点が近傍になるため）。\n');
  console.log('| 条件 | 同ラベル率 10近傍 | 同ラベル率 15近傍 | 高次元15近傍の再現率 | 配置の相関 |');
  console.log('|---|---|---|---|---|');
  const ref = q.reference_umaplearn_public;
  console.log(`| 既存の事前計算（umap-learn 0.6.0、public/data/mnist/positions.f32） | ${f3(ref.sameLabel10)} | ${f3(ref.sameLabel15)} | ${f3(ref.knnRecall15)} | 1 |`);
  const rows = main.concat(['10k_n15_atlas_def_random', '10k_n15_atlas_step200', '10k_n15_atlas_stepdecay200_yield', '10k_n15_atlas_stepdecay200_c1', '10k_n15_atlas_cpu_e50', '10k_n15_atlas_gpu_swiftshader_e50']);
  for (const id of rows) {
    const m = q[id + '_run1']; if (!m) continue;
    console.log(`| ${id} | ${f3(m.sameLabel10)} | ${f3(m.sameLabel15)} | ${f3(m.knnRecall15)} | ${m.centroidDistCorrVsReference == null ? '—' : f3(m.centroidDistCorrVsReference)} |`);
  }
}

console.log('\n### 再現性（ビット単位の一致、SHA-256）\n');
console.log('| 条件 | 同じ Worker の 2 回 | 別々の Worker の 2 回 | Node との一致 |');
console.log('|---|---|---|---|');
for (const id of main) {
  const r = br.runs[id]; if (r.error) continue;
  const nr = nd && nd.runs[id] && !nd.runs[id].error ? nd.runs[id] : null;
  const yn = (v) => (v == null ? '—' : v ? '一致' : '**不一致**');
  console.log(`| ${id} | ${yn(r.trialA.sameWorkerBitIdentical)} | ${yn(r.crossWorkerBitIdentical)} | ${nr ? yn(nr.hash === r.trialA.run1.hash) : '未計測'} |`);
}

if (br.baseline) {
  console.log('\n### rAF のベースライン\n');
  const b = br.baseline;
  console.log(`- アイドル時: 中央値 ${f1(b.idle.median)} ms、最大 ${f1(b.idle.max)} ms（${b.idle.count} フレーム）`);
  console.log(`- メインスレッドを 200 ms 止めたとき: 最大 ${f1(b.blocked200ms.max)} ms（計測が止まりを検出できることの確認）`);
}

{
  console.log('\n### step() 方式と中断（10k・n=15）\n');
  console.log('| 条件 | 準備 | 最適化 | エポック | 途中座標の受信 | 中断要求 → 応答 | 中断時のエポック |');
  console.log('|---|---|---|---|---|---|---|');
  for (const id of Object.keys(br.runs).filter((k) => /^10k_n15_(atlas_(step|cancel)|umapjs_(cancel|def_yield))/.test(k))) {
    const r = br.runs[id]; if (r.error) continue;
    const a = r.trialA, x = a.run1;
    const sn = a.snapshots ? `${a.snapshots.count} 回（初回 ${s(a.snapshots.firstAtMs)} 秒、最後 ${s(a.snapshots.lastAtMs)} 秒）` : '—';
    const cn = a.cancel ? (a.cancel.cancelled ? `${s(a.cancel.cancelAtMs)} 秒 → ${((a.cancel.resultAtMs - a.cancel.cancelAtMs)).toFixed(0)} ms で停止` : `${s(a.cancel.cancelAtMs)} 秒に送信 → 届かず、完了（${s(a.cancel.resultAtMs)} 秒）まで処理されない`) : '—';
    console.log(`| ${id} | ${s((x.convertMs ?? 0) + x.initMs)} | ${s(x.optimizeMs)} | ${x.epochsDone} | ${sn} | ${cn} | ${a.cancel ? a.cancel.epochsDone : '—'} |`);
  }
}
