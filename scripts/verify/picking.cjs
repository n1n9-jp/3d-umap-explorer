#!/usr/bin/env node
/**
 * GPU ピッキング（src/picking/）をヘッドレス Chromium で検証する。
 *
 *   node scripts/verify/picking.cjs [--data data/mnist/] [--no-build] [--samples 240] [--out artifacts/picking]
 *
 * 解像度の条件（deviceScaleFactor 1・2、ウィンドウの大きさの変更後）ごとに、俯瞰・クラスタ内部・点のすぐ脇の
 * 3つの視点で次を確かめる。
 *   - 小領域と全画面の一致：pick の結果が、全画面に描いた番号の画像と一致する（真下・吸着・null）
 *   - 見えている形との一致：通常の描画で背景でない画素と、番号が 0 でない画素が、輪郭（両方の画像の境界）の2画素を除いて一致する
 *   - 点の同一性：選ばれた点を画面へ投影すると、カーソルがそのビルボードの範囲内にある
 *   - 近接フェード：完全に消えている点は、番号の画像にも pick の結果にも現れない
 *   - 隙間：手前の点のビルボードの内側で、数字の線の隙間から見えている背後の点が選ばれる
 *   - 吸着：点のない位置では半径内の最も近い点へ吸着し、なければ null
 *   - 描画への影響：pick を繰り返したあとの通常の描画が、前と画素単位で一致する
 * 失敗があれば終了コード 1 で終わる。番号の画像は色分けして --out に保存する。
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
const outDir = path.resolve(root, opt('out', 'artifacts/picking'));
const samples = Number(opt('samples', '240'));
const port = Number(opt('port', '4318'));

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
const round = (v) => v.map((x) => Number(x.toFixed(5)));

function computeViews({ positions, labels, count }) {
  const P = (i) => [positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]];
  // 最も密な点（半径 0.04 以内の近傍数が最大）
  const r = 0.04, key = (x, y, z) => `${x},${y},${z}`, ci = (v) => Math.floor(v / r);
  const grid = new Map();
  for (let i = 0; i < count; i++) {
    const k = key(ci(positions[3 * i]), ci(positions[3 * i + 1]), ci(positions[3 * i + 2]));
    let a = grid.get(k); if (!a) grid.set(k, (a = [])); a.push(i);
  }
  let best = 0, bestN = -1;
  for (let i = 0; i < count; i++) {
    const [x, y, z] = P(i); let n = 0;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      for (const j of grid.get(key(ci(x) + dx, ci(y) + dy, ci(z) + dz)) ?? []) if (len(sub(P(j), [x, y, z])) < r) n++;
    }
    if (n > bestN) { bestN = n; best = i; }
  }
  const C = P(best), label = labels[best];
  const members = [];
  for (let i = 0; i < count; i++) if (labels[i] === label && len(sub(P(i), C)) < 0.4) members.push(i);
  let L = [0, 0, 0];
  for (const i of members) L = add(L, P(i));
  L = mul(L, 1 / members.length);
  const radii = members.map((i) => len(sub(P(i), L))).sort((a, b) => a - b);
  const r50 = radii[Math.floor(radii.length * 0.5)];
  const out = len(L) < 1e-3 ? [0, 0, 1] : norm(L);

  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], positions[3 * i + k]); mx[k] = Math.max(mx[k], positions[3 * i + k]); }
  const bc = mul(add(mn, mx), 0.5);
  let br = 0;
  for (let i = 0; i < count; i++) br = Math.max(br, len(sub(P(i), bc)));
  const toCenter = norm(sub(L, C));
  return [
    { name: 'overview', label: '俯瞰', pos: round(add(bc, mul(norm([1.9, 1.2, 2.0]), (br / Math.sin(Math.PI / 6)) * 0.95))), look: round(bc) },
    { name: 'inside', label: 'クラスタ内部', pos: round(add(L, mul(out, r50))), look: round(L) },
    // 最も密な点から 0.003（近接フェードで完全に消える距離 0.006 より近い）の位置から、クラスタの中心の向きへ
    { name: 'near', label: '点のすぐ脇', pos: round(add(C, mul(norm(add(mul(toCenter, -1), [0.3, 0.2, 0.1])), 0.003))), look: round(add(C, mul(toCenter, 0.3))), nearIndex: best },
  ];
}

// ---------- ページ内で行う検証 ----------

/* eslint-disable no-undef */
async function pageChecks({ samples, seed, saveImages }) {
  const ex = window.__explorer, dbg = ex.picking;
  await ex.measureFrames(10); // 視点の変更とダンピングを落ち着かせる
  let rs = seed >>> 0;
  const rnd = () => { rs = (rs + 0x6d2b79f5) >>> 0; let t = rs; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const canvas = document.querySelector('canvas');
  const rect = canvas.getBoundingClientRect();
  const failures = [];
  const fail = (m) => { if (failures.length < 30) failures.push(m); };

  const projBefore = dbg.project(0);
  const frameBefore = dbg.readFrame();
  const img = await dbg.readIdImage();
  const { width: W, height: H, ids } = img;
  const sx = W / rect.width, sy = H / rect.height, scale = (sx + sy) / 2;
  const radiusCss = 7, R = radiusCss * scale;
  if (frameBefore.width !== W || frameBefore.height !== H) fail(`画像の大きさが違う frame ${frameBefore.width}x${frameBefore.height} ids ${W}x${H}`);

  // 点の投影（全点）
  const proj = [];
  for (let i = 0; i < dbg.count; i++) proj.push(dbg.project(i));
  const fadedSet = new Set();
  proj.forEach((p, i) => { if (p.faded) fadedSet.add(i); });

  // ---- 番号の画像の統計 ----
  let nonzero = 0;
  const present = new Set();
  for (let k = 0; k < ids.length; k++) if (ids[k] >= 0) { nonzero++; present.add(ids[k]); }
  const fadedInImage = [...fadedSet].filter((i) => present.has(i));
  if (fadedInImage.length) fail(`近接フェードで消えた点が番号の画像にある: ${fadedInImage.slice(0, 5)}`);

  // ---- 全画面の画像から期待する pick の結果 ----
  const expected = (cx, cy) => {
    const px = Math.floor((cx - rect.left) * sx), py = Math.floor((cy - rect.top) * sy);
    const at = ids[py * W + px];
    if (at >= 0) return { px, py, under: at, dist: 0, set: new Set([at]) };
    const r = Math.floor(R);
    let bestD2 = Infinity, set = new Set();
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const x = px + dx, y = py + dy;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const d2 = dx * dx + dy * dy;
      if (d2 > R * R || d2 > bestD2) continue;
      const id = ids[y * W + x];
      if (id < 0) continue;
      if (d2 < bestD2) { bestD2 = d2; set = new Set(); }
      set.add(id);
    }
    return { px, py, under: -1, dist: Number.isFinite(bestD2) ? Math.sqrt(bestD2) : null, set };
  };

  // 位置：半分は画面全体から一様に、半分は点のある画素から
  const nzList = [];
  for (let k = 0; k < ids.length; k += 7) if (ids[k] >= 0) nzList.push(k);
  const positions = [];
  for (let k = 0; k < samples; k++) {
    if (k % 2 === 0 || nzList.length === 0) positions.push([rect.left + rnd() * rect.width, rect.top + rnd() * rect.height]);
    else { const q = nzList[Math.floor(rnd() * nzList.length)]; positions.push([rect.left + ((q % W) + rnd()) / sx, rect.top + (Math.floor(q / W) + rnd()) / sy]); }
  }
  // 近接フェードで消えた点の、画面上の中心の周り
  const fadedProbes = [];
  for (const i of fadedSet) {
    const p = proj[i];
    if (p.depth <= 0) continue;
    for (let k = 0; k < 8; k++) {
      const x = p.clientX + (rnd() - 0.5) * Math.min(p.sizePx, 400), y = p.clientY + (rnd() - 0.5) * Math.min(p.sizePx, 400);
      if (x >= rect.left && y >= rect.top && x < rect.right && y < rect.bottom) fadedProbes.push([x, y]);
    }
  }

  // 隙間：手前の点 A のビルボードの内側で、A より奥の点 B が見えている画素
  const gapProbes = [];
  const bigPoints = proj.map((p, i) => [p, i]).filter(([p]) => !p.faded && p.depth > 0 && p.sizePx * scale >= 24 &&
    p.clientX > rect.left && p.clientY > rect.top && p.clientX < rect.right && p.clientY < rect.bottom);
  for (const [a, ai] of bigPoints) {
    const half = 0.4 * a.sizePx;
    let found = 0;
    for (let t = 0; t < 200 && found < 3; t++) {
      const cx = a.clientX + (rnd() * 2 - 1) * half, cy = a.clientY + (rnd() * 2 - 1) * half;
      if (cx < rect.left || cy < rect.top || cx >= rect.right || cy >= rect.bottom) continue;
      const px = Math.floor((cx - rect.left) * sx), py = Math.floor((cy - rect.top) * sy);
      const b = ids[py * W + px];
      if (b < 0 || b === ai || proj[b].depth <= a.depth) continue;
      gapProbes.push({ x: cx, y: cy, front: ai, behind: b });
      found++;
    }
    if (gapProbes.length >= 60) break;
  }

  // ---- pick を実行（20件ずつ重ねて呼ぶ：重なった呼び出しも正しい結果を返すことを確かめる）----
  const runPicks = async (list) => {
    const out = [];
    for (let k = 0; k < list.length; k += 20) {
      out.push(...await Promise.all(list.slice(k, k + 20).map(([x, y]) => ex.pick(x, y))));
    }
    return out;
  };
  const results = await runPicks(positions);
  const stat = { under: 0, snapped: 0, nullCase: 0, mismatch: 0, identityFail: 0 };
  results.forEach((r, k) => {
    const [cx, cy] = positions[k];
    const e = expected(cx, cy);
    if (e.under >= 0) {
      stat.under++;
      if (!r || r.index !== e.under || r.pixelDistance !== 0) { stat.mismatch++; fail(`真下の点が違う (${cx.toFixed(1)},${cy.toFixed(1)}) 期待 ${e.under} 結果 ${JSON.stringify(r)}`); }
    } else if (e.dist === null) {
      stat.nullCase++;
      if (r !== null) { stat.mismatch++; fail(`null のはずが ${JSON.stringify(r)} (${cx.toFixed(1)},${cy.toFixed(1)})`); }
    } else {
      stat.snapped++;
      if (!r || !e.set.has(r.index) || Math.abs(r.pixelDistance * scale - e.dist) > 1e-6) { stat.mismatch++; fail(`吸着先が違う (${cx.toFixed(1)},${cy.toFixed(1)}) 期待 ${[...e.set]} 距離 ${e.dist} 結果 ${JSON.stringify(r)}`); }
    }
    if (r) {
      const p = dbg.project(r.index);
      const tol = p.sizePx / 2 + r.pixelDistance + 1 / scale;
      if (Math.abs(p.clientX - cx) > tol || Math.abs(p.clientY - cy) > tol) { stat.identityFail++; fail(`点の同一性：点 ${r.index} の中心 (${p.clientX.toFixed(1)},${p.clientY.toFixed(1)}) 大きさ ${p.sizePx.toFixed(1)} カーソル (${cx.toFixed(1)},${cy.toFixed(1)})`); }
    }
  });

  const fadedResults = await runPicks(fadedProbes);
  const fadedPicked = fadedResults.filter((r) => r && fadedSet.has(r.index)).length;
  if (fadedPicked) fail(`近接フェードで消えた点が ${fadedPicked} 回選ばれた`);

  const gapResults = await runPicks(gapProbes.map((g) => [g.x, g.y]));
  let gapOk = 0, gapVisible = 0;
  gapResults.forEach((r, k) => {
    const g = gapProbes[k];
    if (r && r.index === g.behind && r.pixelDistance === 0) gapOk++;
    else fail(`隙間：(${g.x.toFixed(1)},${g.y.toFixed(1)}) 手前 ${g.front} の奥の ${g.behind} が期待、結果 ${JSON.stringify(r)}`);
    // 通常の描画でもその画素は背景でない（背後の点が見えている）
    const px = Math.floor((g.x - rect.left) * sx), py = Math.floor((g.y - rect.top) * sy), o = 4 * (py * W + px);
    if (Math.max(Math.abs(frameBefore.rgba[o] - 7), Math.abs(frameBefore.rgba[o + 1] - 8), Math.abs(frameBefore.rgba[o + 2] - 12)) > 12) gapVisible++;
  });

  // ---- 見えている形との一致 ----
  const BG = [7, 8, 12], T = 12;
  const vis = new Uint8Array(W * H), nz = new Uint8Array(W * H);
  for (let k = 0; k < W * H; k++) {
    const o = 4 * k;
    vis[k] = Math.max(Math.abs(frameBefore.rgba[o] - BG[0]), Math.abs(frameBefore.rgba[o + 1] - BG[1]), Math.abs(frameBefore.rgba[o + 2] - BG[2])) > T ? 1 : 0;
    nz[k] = ids[k] >= 0 ? 1 : 0;
  }
  // 輪郭：番号の画像または通常の描画で、点のある画素とない画素が切り替わる位置から2画素以内（チェビシェフ距離）。
  // 通常の描画の側も含めるのは、幅1画素未満の線が MSAA で淡く見えても、画素の中心では覆われない（番号は 0）ため
  const edge = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const k = y * W + x;
    const dx = x + 1 < W && (nz[k] !== nz[k + 1] || vis[k] !== vis[k + 1]);
    const dy = y + 1 < H && (nz[k] !== nz[k + W] || vis[k] !== vis[k + W]);
    if (dx || dy) { edge[k] = 1; if (dx) edge[k + 1] = 1; if (dy) edge[k + W] = 1; }
  }
  const dil = (src, horiz) => {
    const dst = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (!src[y * W + x]) continue;
      for (let d = -2; d <= 2; d++) {
        const xx = horiz ? x + d : x, yy = horiz ? y : y + d;
        if (xx >= 0 && yy >= 0 && xx < W && yy < H) dst[yy * W + xx] = 1;
      }
    }
    return dst;
  };
  const near = dil(dil(edge, true), false);
  let visOnly = 0, idOnly = 0, agree = 0, excluded = 0;
  const diffSamples = [];
  const diffMask = new Uint8Array(W * H);
  for (let k = 0; k < W * H; k++) {
    if (vis[k] === nz[k]) { agree++; continue; }
    if (near[k]) { excluded++; continue; }
    diffMask[k] = 1;
    if (vis[k]) visOnly++; else idOnly++;
    if (diffSamples.length < 8) diffSamples.push(`(${k % W},${Math.floor(k / W)}) rgb ${Array.from(frameBefore.rgba.subarray(4 * k, 4 * k + 3))} id ${ids[k]}`);
  }
  const shapeMismatch = visOnly + idOnly;
  if (shapeMismatch) fail(`見えている形と番号の画像が輪郭の外で ${shapeMismatch} 画素食い違う（描画のみ ${visOnly}、番号のみ ${idOnly}）例: ${diffSamples.join(' / ')}`);

  // ---- 所要時間（1件ずつ）----
  // total: 結果が返るまで（描画ループのフレームの完了待ちを含む）、sync: pick() の同期部分（描画と読み出しの発行）
  const times = [], syncTimes = [];
  for (let k = 0; k < 40; k++) {
    const x = rect.left + rnd() * rect.width, y = rect.top + rnd() * rect.height;
    const t0 = performance.now(); const pr = ex.pick(x, y); const t1 = performance.now(); await pr;
    times.push(performance.now() - t0); syncTimes.push(t1 - t0);
  }
  times.sort((a, b) => a - b); syncTimes.sort((a, b) => a - b);

  // ---- 描画への影響 ----
  const frameAfter = dbg.readFrame();
  let frameDiff = 0;
  for (let k = 0; k < frameAfter.rgba.length; k += 4) {
    if (frameAfter.rgba[k] !== frameBefore.rgba[k] || frameAfter.rgba[k + 1] !== frameBefore.rgba[k + 1] || frameAfter.rgba[k + 2] !== frameBefore.rgba[k + 2]) frameDiff++;
  }
  const projAfter = dbg.project(0);
  if (frameDiff) fail(`pick のあとの通常の描画が ${frameDiff} 画素変わった`);
  if (JSON.stringify(projAfter) !== JSON.stringify(projBefore)) fail('pick の前後でカメラの投影が変わった');

  // ---- 画像の保存 ----
  const images = {};
  if (saveImages) {
    const toPng = (fill) => {
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const g = c.getContext('2d'); const d = g.createImageData(W, H);
      for (let k = 0; k < W * H; k++) { const [r, gg, b] = fill(k); d.data[4 * k] = r; d.data[4 * k + 1] = gg; d.data[4 * k + 2] = b; d.data[4 * k + 3] = 255; }
      g.putImageData(d, 0, 0); return c.toDataURL('image/png');
    };
    const hue = (id) => { let h = Math.imul(id + 1, 2654435761) >>> 0; return [64 + (h & 191), 64 + ((h >> 8) & 191), 64 + ((h >> 16) & 191)]; };
    images.ids = toPng((k) => (ids[k] >= 0 ? hue(ids[k]) : [0, 0, 0]));
    images.frame = toPng((k) => [frameBefore.rgba[4 * k], frameBefore.rgba[4 * k + 1], frameBefore.rgba[4 * k + 2]]);
    // 一致：灰、描画のみ：赤、番号のみ：青、輪郭で除外した食い違い：暗い黄
    images.diff = toPng((k) => (diffMask[k] ? (vis[k] ? [255, 40, 40] : [40, 120, 255]) : vis[k] !== nz[k] ? [110, 100, 20] : nz[k] ? [90, 90, 90] : [0, 0, 0]));
  }

  return {
    buffer: `${W}x${H}`, css: `${rect.width}x${rect.height}`, scale,
    idPixels: nonzero, distinctIds: present.size,
    picks: { total: results.length, ...stat },
    faded: { points: fadedSet.size, inFront: [...fadedSet].filter((i) => proj[i].depth > 0).length, probes: fadedProbes.length, picked: fadedPicked, inImage: fadedInImage.length },
    gap: { probes: gapProbes.length, ok: gapOk, visibleInFrame: gapVisible },
    shape: { agree, excludedAtEdge: excluded, visOnly, idOnly, pixels: W * H },
    frameDiff,
    pickMs: { median: times[times.length >> 1], p95: times[Math.floor(times.length * 0.95)], max: times[times.length - 1],
      syncMedian: syncTimes[syncTimes.length >> 1], syncMax: syncTimes[syncTimes.length - 1] },
    frameMs: await ex.measureFrames(20).then((f) => f.medianMs),
    failures, images,
  };
}
/* eslint-enable no-undef */

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
  const views = computeViews(ds);
  console.log('データ:', ds.manifest.name, `${ds.count} 点`);

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
  let failed = 0;
  const report = [];
  try {
    await waitForServer(base);
    browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
    const only = opt('only', null);
    const allConfigs = [
      { name: 'dpr1', dsf: 1, viewport: { width: 1280, height: 800 } },
      { name: 'dpr2', dsf: 2, viewport: { width: 1280, height: 800 } },
      { name: 'dpr1-resized', dsf: 1, viewport: { width: 1280, height: 800 }, resizeTo: { width: 960, height: 640 } },
    ];
    const configs = only ? allConfigs.filter((c) => c.name === only) : allConfigs;
    let seed = 1;
    for (const cfg of configs) {
      const page = await browser.newPage({ viewport: cfg.viewport, deviceScaleFactor: cfg.dsf });
      page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`[${cfg.name}] [error] ${m.text()}`); });
      page.on('pageerror', (e) => consoleErrors.push(`[${cfg.name}] [pageerror] ${e.message}`));
      page.on('requestfailed', (r) => consoleErrors.push(`[${cfg.name}] [requestfailed] ${r.url()}`));
      await page.goto(`${base}?${new URLSearchParams({ data: dataPath })}`);
      await page.waitForFunction(() => window.__explorer && (window.__explorer.ready || window.__explorer.error), null, { timeout: 60000 });
      const err = await page.evaluate(() => window.__explorer.error);
      if (err) throw new Error(`アプリの起動に失敗: ${err}`);
      if (cfg.resizeTo) {
        // 一度ピッキングしてから大きさを変える（レンダーターゲットの作り直しも通す）
        await page.evaluate(() => window.__explorer.pick(100, 100));
        await page.setViewportSize(cfg.resizeTo);
        await page.evaluate(() => window.__explorer.measureFrames(5));
      }
      for (const v of views) {
        await page.evaluate((view) => window.__explorer.setView(view), { pos: v.pos, look: v.look });
        const res = await page.evaluate(pageChecks, { samples, seed: seed++, saveImages: true });
        for (const [kind, url] of Object.entries(res.images)) {
          fs.writeFileSync(path.join(outDir, `${cfg.name}-${v.name}-${kind}.png`), Buffer.from(url.split(',')[1], 'base64'));
        }
        delete res.images;
        const ok = res.failures.length === 0;
        if (!ok) failed++;
        report.push({ config: cfg.name, view: v.name, ...res });
        const p = res.picks;
        console.log(`[${ok ? 'OK' : 'NG'}] ${cfg.name} / ${v.label}  バッファ ${res.buffer}（CSS ${res.css}）`);
        console.log(`  小領域と全画面：${p.total} 件中 一致 ${p.total - p.mismatch}（真下 ${p.under}・吸着 ${p.snapped}・null ${p.nullCase}）／点の同一性の不合格 ${p.identityFail}`);
        console.log(`  見えている形：一致 ${res.shape.agree}・輪郭で除外 ${res.shape.excludedAtEdge}・輪郭の外の食い違い ${res.shape.visOnly + res.shape.idOnly}（全 ${res.shape.pixels} 画素、番号のある画素 ${res.idPixels}、点 ${res.distinctIds} 個）`);
        console.log(`  近接フェード：消えた点 ${res.faded.points}（前方 ${res.faded.inFront}）、その周りの pick ${res.faded.probes} 件で選ばれた回数 ${res.faded.picked}、番号の画像に現れた数 ${res.faded.inImage}`);
        console.log(`  隙間：${res.gap.probes} 件中 背後の点を選んだ ${res.gap.ok}（通常の描画で背景でない ${res.gap.visibleInFrame}）`);
        console.log(`  描画への影響：変わった画素 ${res.frameDiff}`);
        console.log(`  pick 1回の所要時間（参考）：中央値 ${res.pickMs.median.toFixed(2)}ms / p95 ${res.pickMs.p95.toFixed(2)}ms / 最大 ${res.pickMs.max.toFixed(2)}ms（同期部分 中央値 ${res.pickMs.syncMedian.toFixed(2)}ms / 最大 ${res.pickMs.syncMax.toFixed(2)}ms、描画ループの1フレーム 中央値 ${res.frameMs.toFixed(1)}ms）`);
        for (const f of res.failures) console.log(`  ✗ ${f}`);
        if (v.name === 'near' && res.faded.inFront === 0 && res.faded.points === 0) { failed++; console.log('  ✗ 近接フェードの検証対象の点がない'); }
        if (v.name === 'inside' && res.gap.probes < 20) { failed++; console.log(`  ✗ 隙間の検証件数が少ない（${res.gap.probes}）`); }
      }
      await page.close();
    }
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ views, report, consoleErrors }, null, 2));
    console.log(consoleErrors.length ? `コンソールエラー ${consoleErrors.length} 件:\n${consoleErrors.join('\n')}` : 'コンソールエラー: なし');
    console.log(failed || consoleErrors.length ? `結果：失敗 ${failed} 件` : '結果：すべて合格');
    process.exitCode = failed || consoleErrors.length ? 1 : 0;
  } finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
