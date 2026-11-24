/**
 * 検証スクリプト（screenshot.cjs / controls.cjs）の共通部品。
 * データから視点を決める計算、プレビューサーバーの起動、ヘッドレス Chromium の起動オプション。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

// ---------- データから視点を決める ----------

/**
 * データセットを読む。`labels` はラベル（あれば）、なければ粗い階層のクラスタ id（クラスタなしは 65535）を、
 * 「同じ塊に属する点」の目安として入れる（computeViews がクラスタを近似するのに使う）。`text` は単語（あれば）。
 */
function loadDataset(dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const pb = fs.readFileSync(path.join(dir, manifest.positions.file));
  const positions = new Float32Array(pb.buffer.slice(pb.byteOffset, pb.byteOffset + pb.byteLength));
  let labels = null;
  let groupSource = 'none';
  if (manifest.labels) {
    labels = new Uint8Array(fs.readFileSync(path.join(dir, manifest.labels.file)));
    groupSource = 'label';
  } else if (manifest.clusters) {
    const cb = fs.readFileSync(path.join(dir, manifest.clusters.levels[0].pointFile));
    labels = new Uint16Array(cb.buffer.slice(cb.byteOffset, cb.byteOffset + cb.byteLength));
    groupSource = 'cluster';
  } else {
    labels = new Uint8Array(manifest.count);
  }
  const coarse = manifest.clusters
    ? (() => { const cb = fs.readFileSync(path.join(dir, manifest.clusters.levels[0].pointFile)); return new Uint16Array(cb.buffer.slice(cb.byteOffset, cb.byteOffset + cb.byteLength)); })()
    : null;
  const text = manifest.text ? JSON.parse(fs.readFileSync(path.join(dir, manifest.text.file), 'utf8')) : null;
  return { manifest, positions, labels, groupSource, coarse, text, count: manifest.count };
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return mul(a, 1 / l); };

/**
 * 情報パネル（#info）の、いまの実際の矩形（CSS ピクセル。left・top・right・bottom）。点を探す範囲から外すのに使う。
 * パネルは一覧が加わって大きさが変わるので、固定の範囲ではなく、要素の矩形（getBoundingClientRect）を読む。
 * パネルが閉じているときは、選択すると右上の列（データセットの選択欄の下）に開く場所を空けておく（選んだ点がパネルの下に隠れないように）:
 * 同じ大きさの画面で最後に見えていたときの矩形があればそれを、なければ、選択欄の行の下に開くパネルの最大の大きさの予約領域
 * （幅 400・高さ 360。これまでに見た最大は 346×323。画面の高さを超えない）。
 */
const lastInfoRects = new WeakMap();
async function readInfoRect(page) {
  const r = await page.evaluate(() => {
    const el = document.getElementById('info');
    const b = el && !el.hidden ? el.getBoundingClientRect() : null;
    const sw = document.getElementById('dataset-switcher');
    const sb = sw && !sw.hidden ? sw.getBoundingClientRect() : null;
    return {
      vw: window.innerWidth, vh: window.innerHeight, rect: b && b.width > 0 && b.height > 0 ? { left: b.left, top: b.top, right: b.right, bottom: b.bottom } : null,
      below: sb && sb.height > 0 ? sb.bottom + 8 : 12,
    };
  });
  if (r.rect) { lastInfoRects.set(page, { vw: r.vw, vh: r.vh, rect: r.rect }); return r.rect; }
  const last = lastInfoRects.get(page);
  if (last && last.vw === r.vw && last.vh === r.vh) return last.rect;
  return { left: r.vw - 12 - 400, top: r.below, right: r.vw - 12, bottom: Math.min(r.vh - 12, r.below + 360) };
}

/** 画面の上部の UI（左上のタイトルとカメラのモード、右上のデータセットの選択欄と UMAP のパネル）。点を探す範囲から外す。 */
const TOP_UI_IDS = ['title-mode', 'dataset-switcher', 'umap-panel'];

/**
 * `ids` の要素の、いまの実際の矩形（CSS ピクセル。left・top・right・bottom）。表示されているものだけ。
 * ページの中で点を探す関数へ渡し、`inRects(rects, x, y, margin)` と同じ判定で外す。
 */
async function readUiRects(page, ids = TOP_UI_IDS) {
  return page.evaluate((ids) => ids.flatMap((id) => {
    const el = document.getElementById(id);
    if (!el || el.hidden) return [];
    const b = el.getBoundingClientRect();
    return b.width > 0 && b.height > 0 ? [{ id, left: b.left, top: b.top, right: b.right, bottom: b.bottom }] : [];
  }), ids);
}

/** (x, y) が、矩形のどれかを `margin` だけ広げた範囲に入るか。 */
function inRects(rects, x, y, margin = 12) {
  return rects.some((r) => x > r.left - margin && x < r.right + margin && y > r.top - margin && y < r.bottom + margin);
}

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

/** ソフトウェア描画（SwiftShader）で WebGL を動かすための Chromium の起動オプション。 */
const CHROMIUM_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

/** `vite preview` を起動する。返す stop() で止める。 */
function startPreview(root, port) {
  const server = spawn(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', (d) => process.stderr.write(d));
  return { base: `http://127.0.0.1:${port}/`, stop: () => server.kill('SIGTERM') };
}

// ---------- ポインタ操作を時刻つきで送る ----------

/**
 * CDP の `Input.dispatchMouseEvent` で、ポインタ操作を時刻（`timestamp`）つきで送る。`events` は
 * [{ type: 'down' | 'move' | 'up', x, y, t }]（t は最初の操作からのミリ秒）。すべて await せずに順に送り、
 * ブラウザが指定の時刻で届ける（`event.timeStamp`）。ソフトウェア描画ではマウスイベントが 1 つずつ数百ミリ秒かかって届くので、
 * Playwright の `mouse.move(steps)` では速さが出ず、時刻の指定もできない。このやり方なら、ブラウザの入力の経路はそのままで、
 * 離す直前の速さ・クリックの間隔（ダブルクリックの判定）を時刻で決められる。
 */
async function sendPointer(page, events) {
  const cdp = await page.context().newCDPSession(page);
  const base = Date.now() / 1000;
  const sends = events.map(({ type, x, y, t }) => cdp.send('Input.dispatchMouseEvent', {
    type: type === 'down' ? 'mousePressed' : type === 'up' ? 'mouseReleased' : 'mouseMoved',
    x, y,
    button: type === 'move' ? 'none' : 'left',
    buttons: type === 'up' ? 0 : 1,
    clickCount: type === 'move' ? 0 : 1,
    timestamp: base + t / 1000,
  }));
  await Promise.all(sends);
  await cdp.detach();
}

/**
 * 1 回のドラッグを送る。`points` は [{x, y, t}]（t は押した時刻からのミリ秒。先頭は押した位置で t = 0）、
 * `releaseAfterMs` は最後の点から離すまでのミリ秒（ポインタを止めている時間）、
 * `releaseAt` は離す位置（省略すると最後の点。最後の移動と違う位置で離す操作を送るときに指定する）。
 */
async function pointerGesture(page, points, releaseAfterMs = 1, releaseAt = null) {
  const last = points[points.length - 1];
  const rel = releaseAt ?? last;
  await sendPointer(page, [
    { type: 'down', x: points[0].x, y: points[0].y, t: points[0].t },
    ...points.slice(1).map((p) => ({ type: 'move', x: p.x, y: p.y, t: p.t })),
    { type: 'up', x: rel.x, y: rel.y, t: last.t + releaseAfterMs },
  ]);
}

/** 横（dx）・縦（dy）へ `durationMs` かけて一定の速さで払う操作の点列（n + 1 点）。 */
function flickPoints(x0, y0, dx, dy, durationMs = 160, n = 10) {
  const pts = [{ x: x0, y: y0, t: 0 }];
  for (let i = 1; i <= n; i++) pts.push({ x: x0 + (dx * i) / n, y: y0 + (dy * i) / n, t: (durationMs * i) / n });
  return pts;
}

module.exports = { readInfoRect, readUiRects, inRects, TOP_UI_IDS, loadDataset, computeViews, waitForServer, startPreview, CHROMIUM_ARGS, sub, add, mul, len, norm, sendPointer, pointerGesture, flickPoints };
