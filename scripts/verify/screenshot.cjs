#!/usr/bin/env node
/**
 * ビルドしてプレビューサーバーを起動し、ヘッドレス Chromium で4つの視点のスクリーンショットを撮る。
 *
 *   node scripts/verify/screenshot.cjs [--data data/mnist/] [--no-build] [--size 0.004] [--out artifacts]
 *
 * 視点（俯瞰・クラスタの縁・内部・さらに深い位置）は、データから密な領域を計算して決める。
 * フレーム時間の実測値とコンソールエラーの有無を出力し、エラーがあれば終了コード 1 で終わる。
 */
const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '../..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const dataPath = opt('data', 'data/mnist/').replace(/\/?$/, '/');
const outDir = path.resolve(root, opt('out', 'artifacts'));
const sizeParam = opt('size', null);
const port = Number(opt('port', '4317'));
const width = Number(opt('width', '1280')), height = Number(opt('height', '800'));

// ---------- データから視点を決める ----------

function loadDataset(dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const pb = fs.readFileSync(path.join(dir, manifest.positions.file));
  const positions = new Float32Array(pb.buffer.slice(pb.byteOffset, pb.byteOffset + pb.byteLength));
  const labels = new Uint8Array(fs.readFileSync(path.join(dir, manifest.labels.file)));
  return { manifest, positions, labels, count: manifest.count };
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return mul(a, 1 / l); };

/** 半径 r 以内の近傍数を格子ハッシュで数え、最も密な点を返す。 */
function densestPoint({ positions, count }, r) {
  const cell = r, key = (x, y, z) => `${x},${y},${z}`;
  const grid = new Map();
  const ci = (v) => Math.floor(v / cell);
  for (let i = 0; i < count; i++) {
    const k = key(ci(positions[3 * i]), ci(positions[3 * i + 1]), ci(positions[3 * i + 2]));
    let a = grid.get(k); if (!a) grid.set(k, (a = [])); a.push(i);
  }
  const neighbors = new Int32Array(count);
  let best = 0;
  for (let i = 0; i < count; i++) {
    const x = positions[3 * i], y = positions[3 * i + 1], z = positions[3 * i + 2];
    let n = 0;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const a = grid.get(key(ci(x) + dx, ci(y) + dy, ci(z) + dz)); if (!a) continue;
      for (const j of a) {
        const ex = positions[3 * j] - x, ey = positions[3 * j + 1] - y, ez = positions[3 * j + 2] - z;
        if (ex * ex + ey * ey + ez * ez < r * r) n++;
      }
    }
    neighbors[i] = n;
    if (n > neighbors[best]) best = i;
  }
  return { index: best, neighbors: neighbors[best] };
}

/** 近傍点の距離の中央値（密な領域の点間隔の目安）。総当たりだが 1万点なら数秒。 */
function nearestNeighborStats({ positions, count }, sample) {
  const ds = [];
  for (const i of sample) {
    let best = Infinity;
    for (let j = 0; j < count; j++) {
      if (j === i) continue;
      const d = Math.hypot(positions[3 * j] - positions[3 * i], positions[3 * j + 1] - positions[3 * i + 1], positions[3 * j + 2] - positions[3 * i + 2]);
      if (d < best) best = d;
    }
    ds.push(best);
  }
  ds.sort((a, b) => a - b);
  return { median: ds[Math.floor(ds.length / 2)], p10: ds[Math.floor(ds.length * 0.1)] };
}

function computeViews(ds) {
  const { positions, labels, count } = ds;
  const P = (i) => [positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]];
  const dense = densestPoint(ds, 0.04);
  const C = P(dense.index);
  const label = labels[dense.index];

  // そのラベルの点のうち、密な点から 0.4 以内のもの（同じラベルの離れた塊を除く）でクラスタを近似する
  const members = [];
  for (let i = 0; i < count; i++) if (labels[i] === label && len(sub(P(i), C)) < 0.4) members.push(i);
  let L = [0, 0, 0];
  for (const i of members) L = add(L, P(i));
  L = mul(L, 1 / members.length);
  const radii = members.map((i) => len(sub(P(i), L))).sort((a, b) => a - b);
  const r50 = radii[Math.floor(radii.length * 0.5)], r90 = radii[Math.floor(radii.length * 0.9)];

  // 点群の中心から見てクラスタの外側の向き（全体の外から入っていく）
  let out = norm(L);
  if (len(L) < 1e-3) out = [0, 0, 1];

  const nn = nearestNeighborStats(ds, members.filter((_, k) => k % Math.max(1, Math.floor(members.length / 200)) === 0));
  const round = (v) => v.map((x) => Number(x.toFixed(4)));
  // 俯瞰：バウンディングボックスの中心から、全体が画面に収まる距離（縦の視野角 60°）
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], positions[3 * i + k]); mx[k] = Math.max(mx[k], positions[3 * i + k]); }
  const bc = mul(add(mn, mx), 0.5);
  let br = 0;
  for (let i = 0; i < count; i++) br = Math.max(br, len(sub(P(i), bc)));
  const overviewPos = add(bc, mul(norm([1.9, 1.2, 2.0]), (br / Math.sin(Math.PI / 6)) * 0.95));
  return {
    info: { densestIndex: dense.index, label, neighborsWithin004: dense.neighbors, clusterSize: members.length,
      clusterCenter: round(L), r50: +r50.toFixed(4), r90: +r90.toFixed(4), nnMedian: +nn.median.toFixed(5), nnP10: +nn.p10.toFixed(5) },
    views: [
      { name: '1-overview', label: '全体の俯瞰', pos: round(overviewPos), look: round(bc) },
      { name: '2-edge', label: 'クラスタの縁', pos: round(add(L, mul(out, r90 + 0.12))), look: round(L) },
      { name: '3-inside', label: 'クラスタの内部', pos: round(add(L, mul(out, r50))), look: round(L) },
      // 最も密な点のすぐ脇から、クラスタの中心の向きへ
      { name: '4-deep', label: '内部のさらに深い位置', pos: round(add(C, mul(out, 0.01))), look: round(add(C, mul(norm(sub(L, add(L, mul(out, r50)))), 0.3))) },
    ],
  };
}

// ---------- サーバーとブラウザ ----------

function waitForServer(url, timeoutMs = 30000) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      http.get(url, (res) => { res.resume(); resolve(); }).on('error', () => {
        if (Date.now() - t0 > timeoutMs) reject(new Error(`サーバーが起動しません: ${url}`));
        else setTimeout(tryOnce, 300);
      });
    };
    tryOnce();
  });
}

async function main() {
  const dataDir = path.join(root, 'public', dataPath);
  if (!fs.existsSync(path.join(dataDir, 'manifest.json'))) throw new Error(`データがありません: ${dataDir}`);
  const ds = loadDataset(dataDir);
  const { info, views } = computeViews(ds);
  console.log('データ:', ds.manifest.name, `${ds.count} 点`);
  console.log('密な領域:', JSON.stringify(info));

  if (!args.includes('--no-build')) {
    console.log('ビルド中…');
    execSync('npm run build', { cwd: root, stdio: 'inherit' });
  }
  fs.mkdirSync(outDir, { recursive: true });

  const server = spawn(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', (d) => process.stderr.write(d));
  const base = `http://127.0.0.1:${port}/`;
  let browser;
  const consoleErrors = [];
  const consoleWarnings = [];
  try {
    await waitForServer(base);
    browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(`[error] ${m.text()}`);
      else if (m.type() === 'warning') consoleWarnings.push(m.text());
    });
    page.on('pageerror', (e) => consoleErrors.push(`[pageerror] ${e.message}`));
    page.on('requestfailed', (r) => consoleErrors.push(`[requestfailed] ${r.url()}`));

    const q = new URLSearchParams({ data: dataPath });
    if (sizeParam) q.set('size', sizeParam);
    await page.goto(`${base}?${q}`);
    await page.waitForFunction(() => window.__explorer && (window.__explorer.ready || window.__explorer.error), null, { timeout: 60000 });
    const err = await page.evaluate(() => window.__explorer.error);
    if (err) throw new Error(`アプリの起動に失敗: ${err}`);
    const gl = await page.evaluate(() => {
      const c = document.querySelector('canvas'); const g = c.getContext('webgl2');
      const d = g.getExtension('WEBGL_debug_renderer_info');
      return { renderer: d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER), samples: g.getParameter(g.SAMPLES) };
    });
    console.log('WebGL:', JSON.stringify(gl));

    const results = [];
    for (const v of views) {
      await page.evaluate((view) => window.__explorer.setView(view), { pos: v.pos, look: v.look });
      // ダンピングが落ち着くまで待ってから計測・撮影
      await page.evaluate(() => window.__explorer.measureFrames(20));
      const stats = await page.evaluate(() => window.__explorer.measureFrames(60));
      const file = path.join(outDir, `${v.name}.png`);
      await page.screenshot({ path: file });
      results.push({ ...v, file: path.relative(root, file), frame: stats });
      console.log(`${v.label}: ?pos=${v.pos.join(',')}&look=${v.look.join(',')}`);
      console.log(`  フレーム時間 中央値 ${stats.medianMs.toFixed(1)}ms / 平均 ${stats.meanMs.toFixed(1)}ms / p95 ${stats.p95Ms.toFixed(1)}ms → ${path.relative(root, file)}`);
    }
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ dataset: ds.manifest.name, info, gl, results, consoleErrors, consoleWarnings }, null, 2));
    if (consoleWarnings.length) console.log(`コンソール警告 ${consoleWarnings.length} 件（参考）:\n  ${consoleWarnings.join('\n  ')}`);
    console.log(consoleErrors.length ? `コンソールエラー ${consoleErrors.length} 件:\n${consoleErrors.join('\n')}` : 'コンソールエラー: なし');
    process.exitCode = consoleErrors.length ? 1 : 0;
  } finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
