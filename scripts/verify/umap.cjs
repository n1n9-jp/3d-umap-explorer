#!/usr/bin/env node
/**
 * ブラウザ内の UMAP の再計算（src/compute/、U キーのパネル）の検証。
 * ビルドしてプレビューサーバーを起動し、ヘッドレス Chromium へ実際のマウス・キーの入力を送る。
 *
 *   node scripts/verify/umap.cjs [--no-build] [--port 4340] [--out artifacts/umap]
 *
 * 確かめること（失敗があれば終了コード 1）:
 *   - この機能を開くまで、計算の部分のチャンク・Worker のチャンク・kNN グラフが読み込まれない。主のチャンクの大きさが、変更の前から大きく増えていない
 *   - パネル: U キーで開閉、初期値が事前計算の値、入力欄の中では移動・モード切り替え・U のキーが働かない、Esc で閉じる
 *   - MNIST を事前計算と同じパラメータ（近傍数 15、min_dist 0.1、種 42）で計算すると完走し、3 次元の 10 近傍の同ラベル率が 0.9215 ± 0.03
 *   - 計算中も描画ループが止まらず（フレームの間隔が大きく悪化しない）、キー操作でカメラを動かせる
 *   - 計算後の座標が絶対値の最大 1 に正規化され、位置合わせで点の平均の移動量が、位置合わせなしより小さい
 *   - 範囲・密度・主成分軸が作り直され、ホームの視点で全点が画面に収まり、ミニマップ・速度の自動調整・ピッキング・ホバーと選択が働く。
 *     ラベルごとの目印が、各ラベルの点のまとまりの位置に出る。計算の前に選択していた点が、計算後も選択されている
 *   - 同じパラメータと種で 2 回計算した座標がビット単位で一致し、種を変えると変わる
 *   - 「計算の途中を表示する」で、計算中に点群の座標が更新される
 *   - 「中断」で短い時間で止まり、表示は計算前のまま。続けて次の計算ができる
 *   - 保持した結果へすぐ戻れる。「事前計算に戻す」で、座標とクラスタが配信しているものと一致する
 *   - URL の nn・md・seed 付きで開くと、同じ結果が表示される
 *   - データセットを切り替えると、計算中の Worker が止まり、保持していた結果が破棄される
 *   - word2vec で計算でき、点の色が引き継がれ、目印が無効になり、ホバーと選択で単語が出る
 *   - 空間の構造（範囲・密度・主成分軸・ラベルごとのまとまり）の計算は、別の Worker（structureWorker）で行い、その間も描画が続く
 *   - 点の移動中（構造の計算中）にデータセットを切り替えても、`compute()`・`revert()` の Promise が「中断」で解決し、次の計算ができる
 *   - Worker を意図的に失敗させる（`window.__explorer.faults.worker`）と、「切り替えによる中断」ではなくエラーとして報告し、パネルに原因が出て、次の計算ができる
 *   - 進捗の読み上げは、開始と 25%・50%・75% の節目と、完了・中断・エラーの文だけ（画面の表示は細かく更新する）
 *   - 計算の途中の座標を表示している間は、目印を隠し、ミニマップのそばに「計算中」を出す。終わると元に戻る
 *   - コンソールエラーがない
 * MNIST で近傍数 5・50、min_dist 0.0・0.8 の全体が見える視点のスクリーンショットを --out に保存する。
 * 計算とソフトウェア描画のため時間がかかる（10 分前後）。待つところは、時間ではなく状態の変化を待つ。
 */
const { execSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { loadDataset, waitForServer, startPreview, CHROMIUM_ARGS, sub, len, readInfoRect } = require('./lib.cjs');

const root = path.resolve(__dirname, '../..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const outDir = path.resolve(root, opt('out', 'artifacts/umap'));
const port = Number(opt('port', '4340'));
const width = 1280, height = 800;

/**
 * 主のチャンクの大きさの上限（バイト）。UMAP の計算の本体（WebAssembly を含む Worker、約 1.3MB）が主のチャンクへ
 * 混ざっていないことを確かめるための予算。ほかの機能の追加でも変わる「変更前の大きさ」との差ではなく、絶対値で見る
 * （機能を足すたびに基準値を直す必要がないように）。
 */
const MAIN_CHUNK_BUDGET = 900 * 1024;
/** 事前計算（umap-learn）の 3 次元の 10 近傍の同ラベル率（scripts/spike/umap-bench/README.md） */
const PRECOMPUTED_SAME_LABEL_10 = 0.9215;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const mnist = loadDataset(path.join(root, 'public/data/mnist'));
const w2v = loadDataset(path.join(root, 'public/data/word2vec-10k'));

// ---------- 計算の補助（Node 側。アプリのコードとは独立に計算する） ----------

/** 3 次元の各点の k 近傍（自分を除く）。格子で探す。 */
function knn3(positions, k) {
  const n = positions.length / 3;
  const cell = 0.04;
  const grid = new Map();
  const key = (x, y, z) => `${x},${y},${z}`;
  const ci = (v) => Math.floor(v / cell);
  for (let i = 0; i < n; i++) {
    const kk = key(ci(positions[3 * i]), ci(positions[3 * i + 1]), ci(positions[3 * i + 2]));
    let a = grid.get(kk); if (!a) grid.set(kk, (a = [])); a.push(i);
  }
  const out = new Int32Array(n * k);
  for (let i = 0; i < n; i++) {
    const x = positions[3 * i], y = positions[3 * i + 1], z = positions[3 * i + 2];
    let found = [];
    for (let r = 1; r < 60; r++) {
      found = [];
      const cx = ci(x), cy = ci(y), cz = ci(z);
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
        const a = grid.get(key(cx + dx, cy + dy, cz + dz)); if (!a) continue;
        for (const j of a) if (j !== i) found.push([(positions[3 * j] - x) ** 2 + (positions[3 * j + 1] - y) ** 2 + (positions[3 * j + 2] - z) ** 2, j]);
      }
      // 半径 r セルの立方体の内接球（r * cell）の内側に k 個あれば確定
      const inside = found.filter((f) => f[0] <= (r * cell) ** 2);
      if (inside.length >= k) { found = inside; break; }
    }
    found.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (let j = 0; j < k; j++) out[i * k + j] = found[j][1];
  }
  return out;
}

function sameLabelRate(positions, labels, k = 10) {
  const nb = knn3(positions, k);
  const n = labels.length;
  let s = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < k; j++) if (labels[nb[i * k + j]] === labels[i]) s++;
  return s / (n * k);
}

const maxAbs = (p) => { let m = 0; for (const v of p) m = Math.max(m, Math.abs(v)); return m; };
function bboxCenter(p) {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], p[i + a]); mx[a] = Math.max(mx[a], p[i + a]); }
  return [0, 1, 2].map((a) => (mn[a] + mx[a]) / 2);
}
function normalize(p) {
  const c = bboxCenter(p);
  let m = 0;
  for (let i = 0; i < p.length; i += 3) for (let a = 0; a < 3; a++) m = Math.max(m, Math.abs(p[i + a] - c[a]));
  const out = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) for (let a = 0; a < 3; a++) out[i + a] = (p[i + a] - c[a]) / m;
  return out;
}
function meanDisp(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i += 3) s += Math.hypot(a[i] - b[i], a[i + 1] - b[i + 1], a[i + 2] - b[i + 2]);
  return s / (a.length / 3);
}
const sha = (f32) => crypto.createHash('sha256').update(Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength)).digest('hex');
const sameBits = (a, b) => a.length === b.length && Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.byteLength), Buffer.from(b.buffer, b.byteOffset, b.byteLength)) === 0;

/** 8 近傍の平均距離の中央値（総当たり。全点から 600 点を間引いて） */
function knnMedianSample(p) {
  const n = p.length / 3;
  const means = [];
  for (let i = 0; i < n; i += Math.floor(n / 600)) {
    const d = [];
    for (let j = 0; j < n; j++) if (j !== i) d.push(Math.hypot(p[3 * i] - p[3 * j], p[3 * i + 1] - p[3 * j + 1], p[3 * i + 2] - p[3 * j + 2]));
    d.sort((a, b) => a - b);
    means.push(d.slice(0, 8).reduce((s, v) => s + v, 0) / 8);
  }
  means.sort((a, b) => a - b);
  return means[Math.floor(means.length / 2)];
}

// ---------- ページの操作 ----------

const consoleErrors = [];
const requests = [];
const workerUrls = [];

async function openPage(browser, base, query) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`[error] ${m.text()} ${m.location()?.url ?? ''}`); });
  page.on('pageerror', (e) => consoleErrors.push(`[pageerror] ${e.message}`));
  page.on('requestfailed', (r) => consoleErrors.push(`[requestfailed] ${r.url()}`));
  page.on('request', (r) => requests.push({ page, url: r.url() }));
  // Worker の中のエラーも数える
  page.on('worker', (w) => {
    workerUrls.push({ page, url: w.url() });
    w.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`[worker error] ${m.text()}`); });
  });
  await page.goto(`${base}?${query}`);
  await page.waitForFunction(() => window.__explorer && (window.__explorer.ready || window.__explorer.error), null, { timeout: 120000 });
  return page;
}

const frames = (page, n) => page.evaluate((k) => window.__explorer.measureFrames(k), n);
const camState = (page) => page.evaluate(() => window.__explorer.getState());
const ixState = (page) => page.evaluate(() => window.__explorer.interaction.getState());
const umapState = (page) => page.evaluate(() => window.__explorer.umap.getState());
const getF32 = async (page, fn) => new Float32Array(await page.evaluate((f) => Array.from(window.__explorer.umap[f]()), fn));
const getRaw = async (page, key) => {
  const a = await page.evaluate((k) => { const r = window.__explorer.umap.raw(k); return r ? Array.from(r) : null; }, key);
  return a ? new Float32Array(a) : null;
};
const urlKey = (p) => `nn=${p.nNeighbors}&md=${p.minDist.toFixed(2)}&seed=${p.seed}`;

/** 条件が成り立つまで待つ（ページの状態を 250 ms ごとに読む） */
async function waitUntil(page, fn, arg, timeoutMs = 180000) {
  const t0 = Date.now();
  for (;;) {
    const v = await page.evaluate(fn, arg);
    if (v) return { value: v, ms: Date.now() - t0 };
    if (Date.now() - t0 > timeoutMs) return { value: null, ms: Date.now() - t0 };
    await page.waitForTimeout(250);
  }
}

/** 計算が終わって表示を切り替え終えるまで待つ（phase が idle に戻り、lastOutcome が決まる） */
async function waitIdle(page, timeoutMs = 240000) {
  return waitUntil(page, () => { const s = window.__explorer.umap.getState(); return s.loaded && s.phase === 'idle' && s.lastOutcome !== null ? s : null; }, null, timeoutMs);
}

/** パネルの入力欄にパラメータを入れて「計算」をクリックし、終わるまで待つ。 */
async function computeViaPanel(page, p, { wait = true } = {}) {
  await page.fill('#umap-nn', String(p.nNeighbors));
  await page.fill('#umap-md', String(p.minDist));
  await page.fill('#umap-seed', String(p.seed));
  await page.click('#umap-run');
  await waitUntil(page, () => window.__explorer.umap.getState().phase !== 'idle', null, 10000);
  if (!wait) return null;
  return waitIdle(page);
}

/** 画面に見えていて、投影した中心で pick するとその点が返る点を探す（大きく見えるものから）。 */
async function findVisiblePoint(page, { minPx = 4 } = {}) {
  const info = await readInfoRect(page); // 情報パネルは実際の矩形で避ける
  return page.evaluate(async ({ minPx, w, h, info }) => {
    const ex = window.__explorer;
    const inInfo = (x, y) => info && x > info.left - 12 && x < info.right + 12 && y > info.top - 12 && y < info.bottom + 12;
    const ok = (x, y) => x > 340 && y > 60 && x < w - 40 && y < h - 40 && !inInfo(x, y) && !(x < 900 && y > h - 220) && !(x > w - 260 && y > h - 240);
    const cands = [];
    for (let i = 0; i < ex.picking.count; i++) {
      const p = ex.picking.project(i);
      if (p.depth <= 0 || p.faded || p.sizePx < minPx) continue;
      const x = Math.round(p.clientX), y = Math.round(p.clientY);
      if (!ok(x, y)) continue;
      cands.push({ i, x, y, sizePx: p.sizePx });
    }
    cands.sort((a, b) => b.sizePx - a.sizePx);
    const canvas = document.querySelector('#app canvas');
    for (const c of cands.slice(0, 300)) {
      if (document.elementFromPoint(c.x, c.y) !== canvas) continue;
      const r = await ex.pick(c.x, c.y);
      if (r && r.index === c.i && r.pixelDistance === 0) return c;
    }
    return null;
  }, { minPx, w: width, h: height, info });
}

/** `center` の少し外側（原点から見て外向きに `dist`）から `center` を見る視点へ移り、止まるまで待つ */
async function viewNear(page, center, dist) {
  const l = len(center);
  const out = l < 1e-3 ? [0, 0, 1] : center.map((v) => v / l);
  const pos = center.map((v, k) => v + out[k] * dist);
  await page.evaluate((v) => window.__explorer.setView(v), { pos, look: center });
  await frames(page, 3);
}

/** カメラが止まるまで待つ */
async function waitStill(page, maxFrames = 80) {
  let prev = await camState(page);
  for (let k = 0; k < maxFrames; k++) {
    await frames(page, 1);
    const s = await camState(page);
    if (!s.homing && len(sub(s.position, prev.position)) < 1e-9 && len(sub(s.direction, prev.direction)) < 1e-9) return s;
    prev = s;
  }
  return prev;
}

/** ホバーして選択し、ホバーのラベルと情報パネルの文字列を返す */
async function hoverAndSelect(page, c) {
  await page.mouse.move(c.x - 30, c.y - 30);
  await frames(page, 2);
  await page.mouse.move(c.x, c.y, { steps: 3 });
  const hov = await waitUntil(page, (i) => window.__explorer.interaction.getState().hovered === i, c.i, 15000);
  const hoverText = await page.evaluate(() => document.getElementById('hover-label').textContent);
  await page.mouse.click(c.x, c.y);
  const sel = await waitUntil(page, (i) => window.__explorer.interaction.getState().selected === i, c.i, 15000);
  const info = await page.evaluate(() => ({ label: document.getElementById('info-label').textContent, hidden: document.getElementById('info').hidden }));
  return { hovered: !!hov.value, selected: !!sel.value, hoverText, info };
}

// ---------- 検証本体 ----------

async function testLazyAndPanel(page) {
  console.log('\n[読み込みの遅延・パネル]');
  const size = fs.readdirSync(path.join(root, 'dist/assets')).filter((f) => /^index-.*\.js$/.test(f)).map((f) => fs.statSync(path.join(root, 'dist/assets', f)).size)[0];
  check('主のチャンクに、UMAP の計算の本体が混ざっていない（大きさが予算以下）', size <= MAIN_CHUNK_BUDGET,
    `${size} バイト（予算 ${MAIN_CHUNK_BUDGET}）`);
  const workerFiles = fs.readdirSync(path.join(root, 'dist/assets')).filter((f) => /^umapWorker-.*\.js$/.test(f));
  check('Worker が別のチャンクになっている', workerFiles.length === 1, workerFiles.join(', '));

  await frames(page, 5);
  const lazyUrls = () => requests.filter((r) => r.page === page && /umapFeature|umapWorker|knn-/.test(r.url)).map((r) => r.url.replace(/^.*\//, ''));
  const st0 = await umapState(page);
  check('起動しただけでは、計算の部分・Worker のチャンク・kNN グラフを読み込まない', lazyUrls().length === 0 && st0.loaded === false, JSON.stringify(lazyUrls()));
  const status0 = await page.evaluate(() => document.getElementById('embedding-status').textContent);
  check('選択欄の横に、表示中が事前計算の埋め込みであることが出る', status0 === '埋め込み: 事前計算（近傍数 15・min_dist 0.10・種 42）', status0);

  // U キーで開く（パネルにフォーカスが移る）
  await page.keyboard.press('KeyU');
  await waitUntil(page, () => { const s = window.__explorer.umap.getState(); return s.loaded && s.open; }, null, 30000);
  const panel = await page.evaluate(() => ({
    nn: document.getElementById('umap-nn').value, md: document.getElementById('umap-md').value, seed: document.getElementById('umap-seed').value,
    focusInPanel: document.getElementById('umap-panel').contains(document.activeElement),
    current: document.getElementById('umap-current').textContent,
    expanded: document.getElementById('umap-open').getAttribute('aria-expanded'),
  }));
  check('U キーでパネルが開き、フォーカスがパネルへ移る', panel.focusInPanel && panel.expanded === 'true', JSON.stringify(panel));
  check('初期値が事前計算の値（近傍数 15・min_dist 0.10・種 42）', panel.nn === '15' && panel.md === '0.10' && panel.seed === '42', `${panel.nn} / ${panel.md} / ${panel.seed}`);
  check('パネルに表示中の埋め込み（事前計算と、そのパラメータ）が出る', /事前計算（umap-learn 0\.6\.0・近傍数 15・min_dist 0\.10・種 42）/.test(panel.current), panel.current);
  const afterOpen = lazyUrls();
  check('パネルを開いても、計算するまで Worker と kNN グラフは読み込まない', afterOpen.every((u) => /umapFeature/.test(u)) && afterOpen.length >= 1, JSON.stringify(afterOpen));

  // 入力欄の中では、移動・モード切り替え・U のキーが働かない
  const before = await camState(page);
  await page.focus('#umap-nn');
  await page.keyboard.down('KeyW');
  await frames(page, 4);
  await page.keyboard.up('KeyW');
  await page.keyboard.press('KeyO');
  await page.keyboard.press('KeyU');
  await page.keyboard.press('KeyH');
  await frames(page, 3);
  const after = await camState(page);
  const stillOpen = (await umapState(page)).open;
  check('入力欄にフォーカスがある間は、W・O・U・H のキーが働かない', len(sub(after.position, before.position)) < 1e-9 && after.mode === before.mode && stillOpen && !after.homing,
    `移動 ${len(sub(after.position, before.position)).toExponential(2)}、モード ${after.mode}、パネル ${stillOpen ? '開' : '閉'}`);
  await page.fill('#umap-nn', '15');
  // Esc で閉じ、開くボタンへフォーカスが戻る。もう一度 U で開く
  await page.keyboard.press('Escape');
  const closed = await page.evaluate(() => ({ open: window.__explorer.umap.getState().open, focus: document.activeElement && document.activeElement.id }));
  check('パネルの中で Esc を押すと閉じ、フォーカスが開くボタンへ戻る', !closed.open && closed.focus === 'umap-open', JSON.stringify(closed));
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press('KeyU');
  await waitUntil(page, () => window.__explorer.umap.getState().open, null, 5000);
  // Tab でパネルの中を移れる（入力欄 → … → 計算のボタン）
  const order = [];
  await page.focus('#umap-nn');
  for (let k = 0; k < 5; k++) { await page.keyboard.press('Tab'); order.push(await page.evaluate(() => document.activeElement.id)); }
  // 「事前計算に戻す」は、事前計算を表示している間は無効なので飛ばされる
  check('Tab でパネルの入力欄とボタンを順に移れる', order.join(',') === 'umap-md,umap-seed,umap-preview,umap-run,umap-close', order.join(','));
  await page.evaluate(() => document.activeElement.blur());
}

async function testFirstCompute(page, ctx) {
  console.log('\n[MNIST: 事前計算と同じパラメータで計算]');
  // 計算の前に、点を 1 つ選択しておく（クラスタの近くから）
  const c0 = mnist.manifest.clusters.levels[0].clusters[0];
  await viewNear(page, c0.center, c0.radius + 0.12);
  const c = await findVisiblePoint(page);
  const pre = c ? await hoverAndSelect(page, c) : null;
  check('（準備）計算の前に点を選択する', pre && pre.selected, c ? `#${c.i}` : '見える点がない');
  ctx.selectedBefore = c ? c.i : null;

  // フレームの間隔を、ページの中で rAF ごとに、計算の状態と一緒に記録する（計算していないときと、計算中を比べる）
  await page.evaluate(() => {
    const rec = (window.__rafRec = []);
    const loop = (t) => {
      const s = window.__explorer.umap.getState();
      rec.push({ t, phase: s.loaded ? s.phase : 'idle' });
      if (!window.__rafStop) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  await frames(page, 30);
  const camBefore = await camState(page);
  // 読み上げの領域（進捗の読み上げは、開始・節目・文の変化だけ）の変化を記録する
  await page.evaluate(() => {
    const live = document.querySelector('#umap-panel .sr-only[role="status"]');
    window.__spoken = [];
    if (live) new MutationObserver(() => window.__spoken.push(live.textContent)).observe(live, { childList: true, characterData: true, subtree: true });
  });
  const p = { nNeighbors: 15, minDist: 0.1, seed: 42 };
  const t0 = Date.now();
  await computeViaPanel(page, p, { wait: false });
  // 計算中に、キー操作でカメラが動くこと（「計算」のボタンにフォーカスがあるまま）
  await waitUntil(page, () => window.__explorer.umap.getState().epoch >= 5, null, 60000);
  await page.keyboard.down('KeyW');
  await frames(page, 4);
  await page.keyboard.up('KeyW');
  const camAfter = await camState(page);
  const s2 = await umapState(page);
  const progressText = await page.evaluate(() => document.getElementById('umap-progress-text').textContent);
  const cancelShown = await page.isVisible('#umap-cancel');
  check('計算中は、進捗（エポック数と割合）と「中断」のボタンが出る', /エポック \d+ \/ 200（\d+%）/.test(progressText) && cancelShown, progressText);
  check('計算中に W キーでカメラが前へ進む', len(sub(camAfter.position, camBefore.position)) > 1e-3 && s2.phase === 'running',
    `移動 ${len(sub(camAfter.position, camBefore.position)).toFixed(4)}、エポック ${s2.epoch}`);

  const done = await waitIdle(page);
  const st = done.value;
  const spoken = await page.evaluate(() => window.__spoken);
  const attrs = await page.evaluate(() => {
    const t = document.getElementById('umap-progress-text'), m = document.getElementById('umap-message');
    return { progressLive: t.getAttribute('aria-live'), progressRole: t.getAttribute('role'), messageLive: m.getAttribute('aria-live'), messageRole: m.getAttribute('role') };
  });
  check('進捗の読み上げは、開始と 25%・50%・75% の節目と、完了の文だけ（5 エポックごとには読み上げない）',
    spoken.length >= 4 && spoken.length <= 8 && spoken[0].includes('計算を始めました') && ['25%', '50%', '75%'].every((m) => spoken.some((t) => t.includes(m)))
      && spoken.some((t) => /計算しました/.test(t)) && !spoken.some((t) => /エポック/.test(t)),
    JSON.stringify(spoken));
  check('進捗の表示の要素は、読み上げの対象にしない（画面の表示は細かく更新したまま）', attrs.progressLive === 'off' && attrs.progressRole === null && attrs.messageLive === 'off' && attrs.messageRole === null, JSON.stringify(attrs));
  const rec = await page.evaluate(() => { window.__rafStop = true; return window.__rafRec; });
  const stats = (phase) => {
    const d = [];
    for (let k = 1; k < rec.length; k++) if (rec[k].phase === phase && rec[k - 1].phase === phase) d.push(rec[k].t - rec[k - 1].t);
    d.sort((x, y) => x - y);
    const q = (f) => d[Math.min(d.length - 1, Math.floor(f * d.length))];
    return { n: d.length, median: q(0.5), p95: q(0.95), max: d[d.length - 1] };
  };
  const idle = stats('idle'), busy = stats('running');
  check('計算中も描画ループが止まらない（フレームの間隔の中央値・p95 が、計算していないときの 1.5 倍以内、最大 1 秒未満）',
    busy.n >= 10 && idle.n >= 10 && busy.median <= idle.median * 1.5 && busy.p95 <= idle.p95 * 1.5 && busy.max < 1000,
    `計算中 ${busy.n} フレーム 中央値 ${busy.median?.toFixed(0)} / p95 ${busy.p95?.toFixed(0)} / 最大 ${busy.max?.toFixed(0)} ms、計算していないとき ${idle.n} フレーム 中央値 ${idle.median?.toFixed(0)} / p95 ${idle.p95?.toFixed(0)} / 最大 ${idle.max?.toFixed(0)} ms`);
  check('完走して、ブラウザで計算した埋め込みを表示する', st && st.lastOutcome === 'done' && st.current.kind === 'computed' && st.current.key === urlKey(p),
    st ? `${((Date.now() - t0) / 1000).toFixed(1)} 秒（準備 ${(st.lastRun.initMs / 1000).toFixed(2)} 秒・最適化 ${(st.lastRun.optimizeMs / 1000).toFixed(2)} 秒）` : 'タイムアウト');
  ctx.firstRun = st?.lastRun;
  const structureWorkers = workerUrls.filter((w) => w.page === page && /structureWorker/.test(w.url));
  check('空間の構造の計算は、別の Worker（structureWorker）で行う', structureWorkers.length >= 1, structureWorkers.map((w) => w.url.replace(/^.*\//, '')).join(', '));
  const P = await getF32(page, 'positions');
  ctx.P15 = P;
  // 修正の前後で、同じ座標から同じ構造が得られるかを比べるための記録（座標と、アプリが表示に使っている構造）
  fs.writeFileSync(path.join(outDir, 'p15.f32'), Buffer.from(P.buffer, P.byteOffset, P.byteLength));
  fs.writeFileSync(path.join(outDir, 'structure15.json'), JSON.stringify({
    structure: await page.evaluate(() => window.__explorer.umap.structure()),
    clusters: await page.evaluate(() => window.__explorer.umap.clusters()),
  }, null, 2));
  const rate = sameLabelRate(P, mnist.labels);
  check(`3 次元の 10 近傍の同ラベル率が、事前計算（${PRECOMPUTED_SAME_LABEL_10}）から 0.03 以内`, Math.abs(rate - PRECOMPUTED_SAME_LABEL_10) <= 0.03, rate.toFixed(4));
  const c3 = bboxCenter(P);
  check('計算後の座標が、バウンディングボックスの中心を原点に、絶対値の最大 1 に正規化されている', Math.abs(maxAbs(P) - 1) < 1e-6 && Math.max(...c3.map(Math.abs)) < 1e-6,
    `最大の絶対値 ${maxAbs(P)}、中心 ${c3.map((v) => v.toExponential(1))}`);
  // 位置合わせ: 事前計算の座標から新しい座標への平均の移動量（位置合わせあり < なし）
  const raw = await getRaw(page, st.current.key);
  ctx.raw15 = raw;
  const dAligned = meanDisp(P, mnist.positions), dRaw = meanDisp(normalize(raw), mnist.positions);
  check('位置合わせで、点の平均の移動量が、位置合わせをしない場合より小さい', dAligned < dRaw && st.lastAlignment.aligned < st.lastAlignment.unaligned,
    `位置合わせあり ${dAligned.toFixed(3)}、なし ${dRaw.toFixed(3)}（アプリの記録 ${st.lastAlignment.aligned.toFixed(3)} / ${st.lastAlignment.unaligned.toFixed(3)}、反転 ${st.lastAlignment.reflection}）`);
  const shown = await getF32(page, 'shownPositions');
  check('点群に描いている座標が、新しい座標と一致する（動かし終えている）', sameBits(shown, P));
  const url = await page.evaluate(() => window.location.search);
  check('URL に nn・md・seed が入る', /[?&]nn=15(&|$)/.test(url) && /[?&]md=0\.1(&|$)/.test(url) && /[?&]seed=42(&|$)/.test(url), url);
  ctx.url15 = url;
  const status = await page.evaluate(() => ({ chip: document.getElementById('embedding-status').textContent, panel: document.getElementById('umap-current').textContent }));
  check('選択欄の横とパネルに、ブラウザで計算した埋め込みとそのパラメータが出る',
    status.chip === '埋め込み: ブラウザで計算（近傍数 15・min_dist 0.10・種 42）' && status.panel.includes('ブラウザで計算（近傍数 15・min_dist 0.10・種 42・200 エポック）'), JSON.stringify(status));

  await testRebuiltStructure(page, ctx, P);
}

/** 計算後に作り直した部分（範囲・密度・主成分軸・ホーム・ミニマップ・自動調整・ピッキング・ホバーと選択・目印・選択の引き継ぎ） */
async function testRebuiltStructure(page, ctx, P) {
  console.log('\n[MNIST: 作り直した空間の構造と操作]');
  const ix = await ixState(page);
  check('計算の前に選択していた点が、計算後も選択されている', ctx.selectedBefore !== null && ix.selected === ctx.selectedBefore, `前 #${ctx.selectedBefore}、後 #${ix.selected}`);
  const info = await page.evaluate(() => ({ hidden: document.getElementById('info').hidden, index: document.getElementById('info-index').textContent }));
  check('情報パネルに、選択中の点が出たまま', !info.hidden && info.index === `#${ctx.selectedBefore}`, JSON.stringify(info));

  const s = await page.evaluate(() => window.__explorer.umap.structure());
  const m = mnist.manifest;
  // bounds: 中心はバウンディングボックスの中心、全点が球に含まれ、最も遠い点が縁にある
  let far = 0;
  for (let i = 0; i < P.length; i += 3) far = Math.max(far, Math.hypot(P[i] - s.bounds.center[0], P[i + 1] - s.bounds.center[1], P[i + 2] - s.bounds.center[2]));
  check('範囲（bounds）が新しい座標から作り直されている', s.bounds.radius >= far && s.bounds.radius - far < 2e-6 && s.bounds.radius !== m.bounds.radius,
    `半径 ${s.bounds.radius}（最も遠い点 ${far.toFixed(6)}、事前計算 ${m.bounds.radius}）`);
  const med = knnMedianSample(P);
  check('密度（density）が新しい座標から作り直されている（8 近傍の平均距離の中央値が、間引いた点での検算と 15% 以内）',
    Math.abs(s.density.knnDistP50 - med) / med < 0.15 && s.density.knnDistP50 !== m.density.knnDistP50 && s.density.knnDistP05 < s.density.knnDistP50 && s.density.knnDistP50 < s.density.knnDistP95,
    `knnDistP50 ${s.density.knnDistP50}（検算 ${med.toFixed(6)}、事前計算 ${m.density.knnDistP50}）`);
  const ax = s.overview.axes;
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const variance = (a) => { let v = 0; for (let i = 0; i < P.length; i += 3) v += dot([P[i], P[i + 1], P[i + 2]], a) ** 2; return v; };
  const orth = Math.max(Math.abs(dot(ax[0], ax[1])), Math.abs(dot(ax[0], ax[2])), Math.abs(dot(ax[1], ax[2])));
  check('主成分軸（overview）が新しい座標から作り直されている（直交、分散が第 1 > 第 2 > 第 3）', orth < 1e-5 && variance(ax[0]) > variance(ax[1]) && variance(ax[1]) > variance(ax[2]) && JSON.stringify(ax) !== JSON.stringify(m.overview.axes),
    `第 1 軸 ${JSON.stringify(ax[0])}`);

  // ホームの視点で全点が画面に収まる
  await page.keyboard.press('KeyH');
  await waitStill(page);
  const home = await page.evaluate(({ w, h }) => {
    const ex = window.__explorer;
    let out = 0, behind = 0;
    for (let i = 0; i < ex.picking.count; i++) {
      const p = ex.picking.project(i);
      if (p.depth <= 0) behind++;
      else if (p.clientX < 0 || p.clientY < 0 || p.clientX > w || p.clientY > h) out++;
    }
    return { out, behind, state: ex.getState(), home: ex.homeView() };
  }, { w: width, h: height });
  check('H キーでホームの視点へ移り、全点が画面に収まる', home.out === 0 && home.behind === 0 && len(sub(home.state.position, home.home.pos)) < 1e-4,
    `画面の外 ${home.out}、後ろ ${home.behind}`);

  // ミニマップ: 新しい主成分軸を基底に、全点を描く
  const mm = await page.evaluate(() => window.__explorer.minimap.getState());
  check('ミニマップが新しい座標で作り直されている（点数、基底が新しい主成分軸）', mm.visible && mm.pointCount === 10000 && JSON.stringify(mm.basis).length > 0,
    `点 ${mm.pointCount}、範囲 ${JSON.stringify(mm.extent).slice(0, 80)}`);

  // 目印: ラベルごとに 1 つ、各ラベルの点のまとまり（点の重心）の近くに出る
  const clusters = await page.evaluate(() => window.__explorer.umap.clusters());
  const labels = await page.evaluate(() => window.__explorer.labels.getState());
  let worst = 0, inRadius = 0;
  for (const c of clusters) {
    const lab = m.labels.names.indexOf(c.name);
    const cen = [0, 0, 0]; let n = 0;
    for (let i = 0; i < 10000; i++) if (mnist.labels[i] === lab) { cen[0] += P[3 * i]; cen[1] += P[3 * i + 1]; cen[2] += P[3 * i + 2]; n++; }
    const centroid = cen.map((v) => v / n);
    const d = len(sub(c.center, centroid));
    worst = Math.max(worst, d / c.radius);
    if (d < c.radius) inRadius++;
    if (c.size !== n) worst = Infinity;
  }
  const visibleLabels = labels.labels.filter((l) => l.visible);
  check('MNIST では、ラベルごとの目印（10 個）が、各ラベルの点のまとまりの位置に出る（代表点が重心から半径以内、点数がラベルの点数）',
    labels.available && clusters.length === 10 && inRadius === 10 && visibleLabels.length >= 8,
    `重心からの距離 / 半径 の最大 ${worst.toFixed(2)}、全体の視点で出ている目印 ${visibleLabels.length} 個（${visibleLabels.map((l) => l.name).join(' ')}）`);
  // 目印の画面上の位置が、代表点（medoid）の投影と一致する
  const offsets = await page.evaluate((cs) => {
    const st = window.__explorer.labels.getState();
    return st.labels.filter((l) => l.visible).map((l) => {
      const c = cs.find((x) => x.id === l.id);
      const p = window.__explorer.picking.project(c.medoid);
      return Math.hypot(p.clientX - l.x, p.clientY - l.y);
    });
  }, clusters);
  check('出ている目印の画面上の位置が、代表点の投影と一致する', offsets.length >= 8 && Math.max(...offsets) < 1.5, `最大のずれ ${Math.max(...offsets).toFixed(2)} px`);

  // ピッキング・ホバー・選択（作り直したまとまりの近くから）
  await viewNear(page, clusters[0].center, clusters[0].radius + 0.12);
  const c = await findVisiblePoint(page);
  const hs = c ? await hoverAndSelect(page, c) : null;
  const label = c ? m.labels.names[mnist.labels[c.i]] : null;
  check('作り直した表示で、ピッキング・ホバー・選択が働く（情報パネルにラベル）', hs && hs.hovered && hs.selected && !hs.info.hidden && hs.info.label === label && hs.hoverText === label,
    c ? `#${c.i}（${label}）ホバー ${hs.hoverText}、パネル ${hs.info.label}` : '見える点がない');

  // 速度の自動調整: 密なまとまりの中では遅く、点群の外では速い
  const big = clusters.slice().sort((a, b) => b.size - a.size)[0];
  await page.evaluate((v) => window.__explorer.setView(v), { pos: big.center, look: [big.center[0] + 0.1, big.center[1], big.center[2]] });
  await frames(page, 12);
  const inside = await camState(page);
  await page.evaluate(() => window.__explorer.setView({ pos: [0, 0, 3], look: [0, 0, 0] }));
  await frames(page, 25);
  const outside = await camState(page);
  check('速度の自動調整が新しい密度で働く（まとまりの中で遅く、外で速い）', inside.autoSpeed.available && inside.autoSpeed.scale < 0.5 && outside.autoSpeed.scale > 1.5,
    `中 ${inside.autoSpeed.scale.toFixed(3)}、外 ${outside.autoSpeed.scale.toFixed(3)}`);
  await page.keyboard.press('KeyH');
  await waitStill(page);
}

async function testPreviewAndDeterminism(page, ctx) {
  console.log('\n[計算の途中の表示・再現性]');
  // 「計算の途中を表示する」を有効にして、近傍数 30 で計算する
  await page.check('#umap-preview');
  const P0 = await getF32(page, 'positions');
  await computeViaPanel(page, { nNeighbors: 30, minDist: 0.1, seed: 42 }, { wait: false });
  const a = await waitUntil(page, () => window.__explorer.umap.getState().previewUpdates >= 2, null, 60000);
  const shownA = await getF32(page, 'shownPositions');
  const b = await waitUntil(page, (n) => { const s = window.__explorer.umap.getState(); return s.previewUpdates >= n + 2 || s.phase !== 'running'; }, (await umapState(page)).previewUpdates, 60000);
  void b;
  const shownB = await getF32(page, 'shownPositions');
  const st = await umapState(page);
  check('「計算の途中を表示する」で、計算中に点群の座標が更新される', a.value && !sameBits(shownA, P0) && !sameBits(shownA, shownB),
    `途中の座標の反映 ${st.previewUpdates} 回（計算中: ${st.phase}、エポック ${st.epoch}）`);
  // 途中の座標を表示している間は、目印を隠し、ミニマップのそばに「計算中」を出す（目印とミニマップは計算前の座標のまま）
  const during = await page.evaluate(() => {
    const b = document.getElementById('minimap-computing');
    const m = window.__explorer.minimap.getState().map;
    let badge = null;
    if (b) {
      const r = b.getBoundingClientRect();
      badge = { text: b.textContent, hidden: b.hidden, inMap: r.left >= m.left - 1 && r.top >= m.top - 1 && r.right <= m.left + m.width + 1 && r.bottom <= m.top + m.height + 1 };
    }
    return { labelsEnabled: window.__explorer.labels.getState().enabled, containerHidden: document.getElementById('cluster-labels').hidden, badge };
  });
  check('途中の座標を表示している間は、目印を一時的に隠し、ミニマップの上に「計算中」を出す',
    !during.labelsEnabled && during.containerHidden && during.badge && during.badge.text === '計算中' && !during.badge.hidden && during.badge.inMap, JSON.stringify(during));
  const d30 = await waitIdle(page);
  const after30 = await page.evaluate(() => ({ labelsEnabled: window.__explorer.labels.getState().enabled, containerHidden: document.getElementById('cluster-labels').hidden, badge: document.getElementById('minimap-computing') !== null }));
  check('計算が終わると、目印が元に戻り、「計算中」が消える', after30.labelsEnabled && !after30.containerHidden && !after30.badge, JSON.stringify(after30));
  check('近傍数 30 で計算でき、途中の表示のあとに新しい座標へ切り替わる', d30.value && d30.value.lastOutcome === 'done' && d30.value.current.key === 'nn=30&md=0.10&seed=42', `${(d30.ms / 1000).toFixed(1)} 秒`);
  await page.uncheck('#umap-preview');

  // 同じパラメータと種で、計算し直す（保持している結果を使わない）
  const p = { nNeighbors: 15, minDist: 0.1, seed: 42 };
  const r = await page.evaluate((q) => window.__explorer.umap.compute(q, { force: true }), p);
  const raw2 = await getRaw(page, urlKey(p));
  check('同じパラメータと種で 2 回計算した座標が、ビット単位で一致する', r.ok && !r.cached && raw2 && sameBits(raw2, ctx.raw15), `SHA-256 ${sha(ctx.raw15).slice(0, 16)}… / ${raw2 ? sha(raw2).slice(0, 16) : '-'}…`);
  const r7 = await page.evaluate(() => window.__explorer.umap.compute({ nNeighbors: 15, minDist: 0.1, seed: 7 }));
  const raw7 = await getRaw(page, 'nn=15&md=0.10&seed=7');
  check('種を変えると、座標が変わる', r7.ok && raw7 && !sameBits(raw7, ctx.raw15) && meanDisp(normalize(raw7), normalize(ctx.raw15)) > 0.05,
    raw7 ? `種 7 と 42 の正規化した座標の平均の差 ${meanDisp(normalize(raw7), normalize(ctx.raw15)).toFixed(3)}` : '');
}

async function testCancel(page) {
  console.log('\n[中断]');
  const before = await getF32(page, 'positions');
  const stBefore = await umapState(page);
  await page.check('#umap-preview');
  await computeViaPanel(page, { nNeighbors: 20, minDist: 0.2, seed: 1 }, { wait: false });
  await waitUntil(page, () => { const s = window.__explorer.umap.getState(); return s.epoch >= 30 && s.previewUpdates >= 1; }, null, 60000);
  const cancelVisible = await page.isVisible('#umap-cancel');
  const t0 = Date.now();
  await page.click('#umap-cancel');
  const stopped = await waitUntil(page, () => { const s = window.__explorer.umap.getState(); return s.phase === 'idle' ? s : null; }, null, 20000);
  const ms = Date.now() - t0;
  const after = await getF32(page, 'positions');
  const shown = await getF32(page, 'shownPositions');
  const lc = stopped.value?.lastCancel;
  check('計算中に「中断」のボタンが出て、押すと短い時間（1 秒以内）で止まる', cancelVisible && stopped.value && stopped.value.lastOutcome === 'cancelled' && lc && lc.ms < 1000 && lc.epoch < 200,
    `指示から停止まで ${lc ? lc.ms.toFixed(0) : '-'} ms（ページの中で測定。止まったエポック ${lc?.epoch}）、クリックから状態の確認まで ${ms} ms`);
  check('中断のあと、表示は計算前のまま（データの座標と、点群に描いている座標）', sameBits(after, before) && sameBits(shown, before) && stopped.value.current.key === stBefore.current.key,
    `表示中 ${stopped.value?.current.key ?? stopped.value?.current.kind}`);
  const afterCancel = await page.evaluate(() => ({ labelsEnabled: window.__explorer.labels.getState().enabled, badge: document.getElementById('minimap-computing') !== null }));
  check('中断すると、目印が元に戻り、「計算中」が消える', afterCancel.labelsEnabled && !afterCancel.badge, JSON.stringify(afterCancel));
  check('中断した計算の結果は保持しない', !stopped.value.cache.includes('nn=20&md=0.20&seed=1'), JSON.stringify(stopped.value.cache));
  await page.uncheck('#umap-preview');
}

async function testScreenshotsAndCache(page, ctx) {
  console.log('\n[パラメータによる違い（スクリーンショット）・保持した結果]');
  const shots = [
    { name: 'mnist-nn05', p: { nNeighbors: 5, minDist: 0.1, seed: 42 } },
    { name: 'mnist-nn50', p: { nNeighbors: 50, minDist: 0.1, seed: 42 } },
    { name: 'mnist-md000', p: { nNeighbors: 15, minDist: 0, seed: 42 } },
    { name: 'mnist-md080', p: { nNeighbors: 15, minDist: 0.8, seed: 42 } },
  ];
  const stats = [];
  let first = true;
  for (const s of shots) {
    const r = await computeViaPanel(page, s.p);
    if (first) {
      check('中断のあと、続けて次の計算ができる', r.value && r.value.lastOutcome === 'done' && r.value.current.key === urlKey(s.p), `${(r.ms / 1000).toFixed(1)} 秒`);
      first = false;
    }
    await page.keyboard.press('KeyH');
    await waitStill(page);
    await frames(page, 3);
    const file = path.join(outDir, `${s.name}.png`);
    await page.screenshot({ path: file });
    const st = await page.evaluate(() => window.__explorer.umap.structure());
    const P = await getF32(page, 'positions');
    stats.push({ name: s.name, ms: r.ms, run: r.value.lastRun, knnDistP50: st.density.knnDistP50, sameLabel10: sameLabelRate(P, mnist.labels) });
    console.log(`  ${s.name}: ${path.relative(root, file)}（計算 ${(r.value.lastRun.totalMs / 1000).toFixed(1)} 秒、knnDistP50 ${st.density.knnDistP50}）`);
  }
  ctx.shotStats = stats;
  const by = Object.fromEntries(stats.map((s) => [s.name, s]));
  check('min_dist 0.0 は 0.8 より点が密に詰まる（8 近傍の平均距離の中央値が小さい）', by['mnist-md000'].knnDistP50 < by['mnist-md080'].knnDistP50 * 0.7,
    `0.0: ${by['mnist-md000'].knnDistP50}、0.8: ${by['mnist-md080'].knnDistP50}`);

  // 保持した結果へすぐ戻れる（近傍数 15・種 42。計算し直さない）
  const t0 = Date.now();
  await page.fill('#umap-nn', '15'); await page.fill('#umap-md', '0.1'); await page.fill('#umap-seed', '42');
  await page.click('#umap-run');
  const r = await waitIdle(page, 30000);
  const ms = Date.now() - t0;
  const P = await getF32(page, 'positions');
  const st = await umapState(page);
  check('保持している結果へは、計算し直さずに戻れる（同じ座標の形）', r.value && r.value.current.key === 'nn=15&md=0.10&seed=42' && st.lastRun.key !== 'nn=15&md=0.10&seed=42' && ms < 15000,
    `${ms} ms、保持 ${st.cache.length} 件（${st.cache.join(' ')}）`);
  // 位置合わせは表示中の座標に対して行うので、向きは変わりうる。形（点どうしの距離）は同じ
  const pd = (Q, i, j) => Math.hypot(Q[3 * i] - Q[3 * j], Q[3 * i + 1] - Q[3 * j + 1], Q[3 * i + 2] - Q[3 * j + 2]);
  // 正規化（絶対値の最大を 1）は回転に依らないわけではないので、全体の大きさは変わりうる。大きさの比をそろえて比べる
  const pairs = [];
  for (let k = 0; k < 300; k++) { const i = (k * 37) % 10000, j = (k * 7919 + 11) % 10000; if (i !== j) pairs.push([pd(P, i, j), pd(ctx.P15, i, j)]); }
  const scale = pairs.reduce((s, q) => s + q[0], 0) / pairs.reduce((s, q) => s + q[1], 0);
  const maxRel = Math.max(...pairs.map((q) => Math.abs(q[0] - scale * q[1]) / Math.max(q[0], 1e-3)));
  check('戻った結果は、最初の計算と同じ形（点どうしの距離が、全体の大きさの比を除いて一致）', maxRel < 1e-4, `大きさの比 ${scale.toFixed(4)}、相対誤差の最大 ${maxRel.toExponential(2)}`);
  const list = await page.evaluate(() => [...document.querySelectorAll('#umap-cache-list button')].map((b) => ({ text: b.textContent, current: b.getAttribute('aria-current') })));
  check('パネルに保持している結果の一覧が出て、表示中のものが分かる（上限 8 件）', list.length >= 6 && list.length <= 8 && list.filter((l) => l.current === 'true').length === 1,
    list.map((l) => `${l.text}${l.current ? '★' : ''}`).join(' / '));
}

async function testRevert(page) {
  console.log('\n[事前計算に戻す]');
  await page.click('#umap-revert');
  const r = await waitUntil(page, () => { const s = window.__explorer.umap.getState(); return s.phase === 'idle' && s.current.kind === 'precomputed' ? s : null; }, null, 30000);
  const P = await getF32(page, 'positions');
  const shown = await getF32(page, 'shownPositions');
  const clusters = await page.evaluate(() => window.__explorer.umap.clusters());
  const want = mnist.manifest.clusters.levels[0].clusters.map((c) => ({ id: c.id, name: c.name, center: c.center, radius: c.radius, size: c.size, medoid: c.medoid }));
  check('「事前計算に戻す」で、座標が配信しているものと一致する', r.value && sameBits(P, mnist.positions) && sameBits(shown, mnist.positions));
  check('「事前計算に戻す」で、クラスタが配信しているもの（HDBSCAN）と一致する', JSON.stringify(clusters) === JSON.stringify(want), `${clusters.length} 個`);
  const url = await page.evaluate(() => window.location.search);
  const chip = await page.evaluate(() => document.getElementById('embedding-status').textContent);
  check('URL から nn・md・seed が外れ、表示が事前計算に戻る', !/nn=|md=|seed=/.test(url) && chip.startsWith('埋め込み: 事前計算'), `${url} / ${chip}`);
}

async function testUrl(browser, base, ctx) {
  console.log('\n[URL の nn・md・seed]');
  const page = await openPage(browser, base, ctx.url15.replace(/^\?/, ''));
  const r = await waitUntil(page, () => { const s = window.__explorer.umap.getState(); return s.loaded && s.phase === 'idle' && s.current.kind === 'computed' ? s : null; }, null, 240000);
  const P = r.value ? await getF32(page, 'positions') : null;
  check('URL のパラメータ付きで開くと、読み込みのあとに同じ計算をして、同じ結果が表示される', r.value && P && sameBits(P, ctx.P15),
    r.value ? `${(r.ms / 1000).toFixed(1)} 秒、${ctx.url15}` : 'タイムアウト');
  const open = await page.evaluate(() => window.__explorer.umap.getState().open);
  check('URL から計算するときは、パネルを開いて進捗を見せる', open);
  await page.close();
}

async function testSwitchDuringCompute(page) {
  console.log('\n[計算中のデータセットの切り替え]');
  // 保持している結果を 1 つ作ってから、次の計算の途中で切り替える
  await page.evaluate(() => window.__explorer.umap.compute({ nNeighbors: 15, minDist: 0.1, seed: 42 }));
  const st0 = await umapState(page);
  await computeViaPanel(page, { nNeighbors: 25, minDist: 0.3, seed: 5 }, { wait: false });
  await waitUntil(page, () => window.__explorer.umap.getState().epoch >= 10, null, 60000);
  const workersBefore = page.workers().length;
  const gen = (await page.evaluate(() => window.__explorer.dataset.getState())).generation;
  await page.selectOption('#dataset-select', 'word2vec-10k');
  await page.waitForFunction((g) => { const s = window.__explorer.dataset.getState(); return !s.loading && s.generation > g; }, gen, { timeout: 120000 });
  await frames(page, 3);
  const st = await umapState(page);
  let workersAfter = page.workers().length;
  for (let k = 0; k < 20 && workersAfter > 0; k++) { await page.waitForTimeout(250); workersAfter = page.workers().length; }
  const url = await page.evaluate(() => window.location.search);
  check('データセットを切り替えると、計算中の Worker が止まる', st.phase === 'idle' && !st.workerStarted && workersBefore >= 1 && workersAfter === 0,
    `Worker の数 ${workersBefore} → ${workersAfter}、状態 ${st.phase}`);
  check('データセットを切り替えると、保持していた結果が破棄される', st0.cache.length >= 1 && st.cache.length === 0 && st.current.kind === 'precomputed' && !st.graphLoaded,
    `保持 ${st0.cache.length} → ${st.cache.length}`);
  check('切り替え後の URL に nn・md・seed がなく、パネルの初期値が新しいデータセットの値', !/nn=/.test(url) && /data=word2vec-10k/.test(url), url);
}

async function testWord2vec(page) {
  console.log('\n[word2vec]');
  const colorsBefore = await page.evaluate(() => Array.from({ length: 10000 }, (_, i) => window.__explorer.dataset.pointColor(i)));
  const r = await computeViaPanel(page, { nNeighbors: 15, minDist: 0.1, seed: 42 });
  check('word2vec で計算できる', r.value && r.value.lastOutcome === 'done' && r.value.current.kind === 'computed', `${(r.ms / 1000).toFixed(1)} 秒`);
  const colors = await page.evaluate(() => Array.from({ length: 10000 }, (_, i) => window.__explorer.dataset.pointColor(i)));
  const diff = colors.filter((c, i) => c !== colorsBefore[i]).length;
  check('点の色が、事前計算のクラスタの色のまま引き継がれる', diff === 0, `色の違う点 ${diff}`);
  const labels = await page.evaluate(() => window.__explorer.labels.getState());
  const hud = await page.evaluate(() => document.getElementById('hud').innerText);
  const locHidden = await page.evaluate(() => document.getElementById('cluster-location').hidden);
  check('目印と現在地の表示が無効になる（HUD に L も出ない）', !labels.available && labels.labels.length === 0 && locHidden && !hud.includes('L 目印'), `available ${labels.available}`);
  const P = await getF32(page, 'positions');
  check('word2vec でも座標が正規化されている', Math.abs(maxAbs(P) - 1) < 1e-6);
  await viewNear(page, [P[0], P[1], P[2]], 0.15);
  const c = await findVisiblePoint(page, { minPx: 3 });
  const hs = c ? await hoverAndSelect(page, c) : null;
  const word = c ? w2v.text[c.i] : null;
  check('ホバーと選択で単語が出る', hs && hs.hovered && hs.selected && hs.hoverText === word && hs.info.label === word, c ? `#${c.i} ${word}` : '見える点がない');
  await testWordsKeyWhilePaused(page, P);
  await page.keyboard.press('KeyH');
  await waitStill(page);
  await page.screenshot({ path: path.join(outDir, 'word2vec-nn15.png') });
}

/** requestAnimationFrame を遅くして、点の移動（1 フレームの進みは上限があるので、約 10 フレーム）を長引かせる */
const slowFrames = (page, ms) => page.evaluate((delay) => {
  if (!window.__origRaf) window.__origRaf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => window.__origRaf((t) => setTimeout(() => cb(performance.now()), delay));
}, ms);
const normalFrames = (page) => page.evaluate(() => { if (window.__origRaf) window.requestAnimationFrame = window.__origRaf; });

async function testSwitchDuringMorph(page) {
  console.log('\n[点の移動中のデータセットの切り替え]');
  // 表示中は word2vec（直前の検証で計算した結果を保持している）。事前計算へ戻したあと、保持している結果を表示する（compute）。
  // そのあと切り替えた先で計算して、事前計算へ戻す（revert）
  const p = { nNeighbors: 15, minDist: 0.1, seed: 42 };
  const back = await page.evaluate(() => window.__explorer.umap.revert());
  check('（準備）事前計算へ戻す', back.ok);

  for (const kind of ['compute', 'revert']) {
    // 表示を切り替えている途中（点の移動中）に、別のデータセットへ切り替える。
    // 切り替えの読み込みの間に点の移動が終わらないよう、フレームを遅くしておく
    if (kind === 'revert') {
      const r = await page.evaluate((q) => window.__explorer.umap.compute(q), p); // 切り替えた先（MNIST）で計算して表示する
      check('（準備）計算した埋め込みを表示する', r.ok, JSON.stringify(r));
    }
    await slowFrames(page, 400);
    const workersBefore = workerUrls.length;
    const out = await page.evaluate(async ({ kind, p }) => {
      const ex = window.__explorer;
      const waiting = kind === 'compute' ? ex.umap.compute(p) : ex.umap.revert();
      const sw = ex.dataset.switchTo(kind === 'compute' ? 'mnist' : 'word2vec-10k');
      const res = await Promise.race([waiting, new Promise((r) => setTimeout(() => r('timeout'), 60000))]);
      const swRes = await sw;
      return { res, swRes, phase: ex.umap.getState().phase };
    }, { kind, p });
    await normalFrames(page);
    void workersBefore;
    check(`点の移動中にデータセットを切り替えても、${kind === 'compute' ? 'compute()' : 'revert()'} の Promise が「中断」で解決する`,
      out.res !== 'timeout' && out.res.ok === false && out.res.cancelled === true && out.swRes.ok && out.phase === 'idle', JSON.stringify(out));
    await frames(page, 2);
  }
}

async function testWorkerError(page) {
  console.log('\n[Worker のエラー]');
  // 表示中は word2vec。計算の Worker を、読み込みに失敗する Worker にする
  await page.evaluate(() => { window.__explorer.faults.worker = 1; });
  const errsBefore = consoleErrors.length;
  const p = { nNeighbors: 15, minDist: 0.1, seed: 43 };
  const r = await page.evaluate((q) => window.__explorer.umap.compute(q), p);
  const st = await umapState(page);
  const ui = await page.evaluate(() => ({ message: document.getElementById('umap-message').textContent, error: document.getElementById('umap-message').classList.contains('error'), hidden: document.getElementById('umap-message').hidden }));
  check('Worker が失敗すると、「切り替えによる中断」ではなくエラーとして報告する', r.ok === false && !r.cancelled && /Worker/.test(r.error ?? '') && !/切り替わりました/.test(r.error ?? '') && st.lastOutcome === 'error', JSON.stringify(r));
  check('パネルに、原因が分かる文（Worker を読み込めない・SIMD に対応していないブラウザでは使えない）がエラーの色で出る',
    ui.error && !ui.hidden && /計算に失敗しました/.test(ui.message) && /Worker/.test(ui.message) && /SIMD/.test(ui.message), ui.message);
  check('エラーのあとは待機に戻り（Worker は止まっている）、パネルの「計算」が押せる', st.phase === 'idle' && !st.workerStarted && st.error !== null && await page.evaluate(() => !document.getElementById('umap-run').disabled), `phase ${st.phase}`);
  void errsBefore;
  // 次の計算ができる（Worker を作り直す）
  const r2 = await page.evaluate((q) => window.__explorer.umap.compute(q), p);
  const st2 = await umapState(page);
  check('そのあと、次の計算ができる（Worker を作り直し、結果を表示する）', r2.ok && st2.lastOutcome === 'done' && st2.current.kind === 'computed' && st2.workerStarted && st2.error === null, JSON.stringify(r2));
}

/**
 * 点が動いている間（計算の途中の表示）は単語の文字を止める。その間の K キーは、止め終わったあとの状態として覚えるだけで、
 * 文字を計算前の位置に出さない。
 */
async function testWordsKeyWhilePaused(page, P) {
  console.log('\n[点が動いている間の K キー]');
  await viewNear(page, [P[0], P[1], P[2]], 0.05);
  await frames(page, 4);
  const ws0 = await page.evaluate(() => window.__explorer.words.getState());
  await page.check('#umap-preview');
  await computeViaPanel(page, { nNeighbors: 15, minDist: 0.1, seed: 7 }, { wait: false });
  await waitUntil(page, () => window.__explorer.words.paused(), null, 120000);
  const words = () => page.evaluate(() => {
    const ws = window.__explorer.words.getState();
    return { paused: window.__explorer.words.paused(), enabled: ws.enabled, shown: ws.shown.length, glyphs: ws.drawnGlyphs };
  });
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  const seq = [];
  for (let k = 0; k < 3; k++) {
    await page.keyboard.press('KeyK');
    await frames(page, 2);
    seq.push(await words(page));
  }
  const stillPaused = seq.filter((x) => x.paused);
  check('点が動いている間に K キーを押しても、単語の文字が出ない（計算前の位置に出さない）', stillPaused.length >= 2 && stillPaused.every((x) => !x.enabled && x.shown === 0 && x.glyphs === 0),
    `計算前 ${ws0.shown.length} 語。押したあと ${JSON.stringify(seq)}`);
  const r = await waitIdle(page);
  await frames(page, 4);
  const after = await words(page);
  check('点が動き終わると、その間の K キーの操作（3 回で表示→非表示）が反映される', r.value && r.value.lastOutcome === 'done' && !after.paused && !after.enabled && after.glyphs === 0, JSON.stringify(after));
  await page.keyboard.press('KeyK');
  await frames(page, 4);
  const on = await words(page);
  check('動き終わったあとに K キーで、文字の表示が戻る', on.enabled && !on.paused, JSON.stringify(on));
  await page.uncheck('#umap-preview');
}

async function main() {
  if (!args.includes('--no-build')) {
    console.log('ビルド中…');
    execSync('npm run build', { cwd: root, stdio: 'inherit' });
  }
  fs.mkdirSync(outDir, { recursive: true });
  const { base, stop } = startPreview(root, port);
  let browser;
  const ctx = {};
  try {
    await waitForServer(base);
    browser = await chromium.launch({ args: CHROMIUM_ARGS });
    const page = await openPage(browser, base, 'data=mnist');
    await testLazyAndPanel(page);
    await testFirstCompute(page, ctx);
    await testPreviewAndDeterminism(page, ctx);
    await testCancel(page);
    await testScreenshotsAndCache(page, ctx);
    await testRevert(page);
    await testUrl(browser, base, ctx);
    await testSwitchDuringCompute(page);
    await testWord2vec(page);
    await testSwitchDuringMorph(page);
    await testWorkerError(page);
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ firstRun: ctx.firstRun, shots: ctx.shotStats, results, consoleErrors }, null, 2));
  } finally {
    if (browser) await browser.close();
    stop();
  }
  check('コンソールエラーがない', consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' | '));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} / ${results.length} 項目が成功`);
  if (failed.length) {
    console.log('失敗:');
    for (const f of failed) console.log(`  - ${f.name}`);
  }
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exit(1); });
