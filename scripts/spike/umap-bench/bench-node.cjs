#!/usr/bin/env node
// Node での計測（条件はブラウザ計測と同じ）。1 条件ごとに別プロセスで実行する。
//   node bench-node.cjs [--only <正規表現>] [--force]
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const only = new RegExp(opt('--only', '.'));
const force = args.includes('--force');
const outFile = path.resolve(__dirname, opt('--out', 'results/node.json'));
const all = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : { runs: {} };

const conds = [];
for (const dataset of ['10k', '70k']) for (const n of [15, 50]) {
  conds.push({ id: `${dataset}_n${n}_atlas_def`, engine: 'atlas', dataset, n, nEpochs: 0 });
  conds.push({ id: `${dataset}_n${n}_atlas_e200`, engine: 'atlas', dataset, n, nEpochs: 200 });
  conds.push({ id: `${dataset}_n${n}_umapjs_def`, engine: 'umapjs', dataset, n, nEpochs: 0 });
  if (dataset === '10k') conds.push({ id: `${dataset}_n${n}_umapjs_e500`, engine: 'umapjs', dataset, n, nEpochs: 500 });
}
for (const c of conds) {
  if (!only.test(c.id)) continue;
  if (all.runs[c.id] && !force) { console.log('skip', c.id); continue; }
  console.log('run', c.id);
  const r = spawnSync('node', ['--max-old-space-size=12000', path.join(__dirname, 'node-run.mjs'), c.engine, c.dataset, String(c.n), String(c.nEpochs), 'node_' + c.id], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) { console.error('  FAILED', (r.stderr || '').slice(-500)); all.runs[c.id] = { id: c.id, cfg: c, error: (r.stderr || '').slice(-500) }; }
  else {
    const j = JSON.parse(r.stdout.trim().split('\n').pop());
    all.runs[c.id] = { id: c.id, cfg: c, ...j };
    console.log(`  init ${j.initMs.toFixed(0)}ms opt ${j.optimizeMs.toFixed(0)}ms epochs ${j.epochs} rssΔ ${j.rssDeltaMB.toFixed(0)}MB`);
  }
  fs.writeFileSync(outFile, JSON.stringify(all, null, 2));
}
