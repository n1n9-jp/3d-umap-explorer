#!/usr/bin/env node
/**
 * 選択中の点の「元のデータで近い点」（src/neighbors/）の検証。ビルドしてプレビューサーバーを起動し、ヘッドレス Chromium で動かす。
 *
 *   node scripts/verify/neighbors.cjs [--no-build] [--port 4330] [--out artifacts/neighbors]
 *
 * 確かめること:
 *   - 起動しただけでは kNN グラフ（knn-indices・knn-distances）を要求しない。点を選択すると要求し、読み込み中は一覧に「読み込み中」が出る
 *   - 一覧の番号と順序が、kNN グラフのファイルをこのスクリプトで直接読んで求めたものと一致する
 *   - 「地図でも近くにある」の判定（印）と要約の数が、座標から総当たりで求めた 3 次元の近傍と一致する
 *   - word2vec の「january」の近傍は月の名前で、ほぼすべてが地図でも近い。「king」の近傍に kings と queen があり、地図でも近いものが少ない
 *   - 地図の上に近傍の輪と線が描かれる（線の端点が、選択中の点と近傍を投影した位置。描画にも出る）。N キーで消え、もう一度押すと戻る
 *   - 画面の外・カメラの後ろの近傍に、画面の端の印が出る（このスクリプトで投影して求めた、画面の外の近傍と一致する）
 *   - 一覧の項目にカーソルを重ねると、その近傍が強調される。項目のクリックでその点が選択され、手前へ飛ぶ。戻る操作で前の選択へ戻る
 *   - キーボード（Tab・矢印キー・Enter）で一覧を操作でき、見出し・リスト・項目の名前が読み上げに出る。要約が読み上げの領域に入る
 *   - 近傍の表示の有無で、ピッキングの番号の画像が変わらない
 *   - ブラウザで UMAP を計算し直したあと（近傍数 5）、元の空間での近傍の一覧は同じで、「地図でも近い」数が新しい座標から求めたものと一致する。
 *     計算の途中の表示の間も、線の端点が描いている座標と合う
 *   - kNN グラフの取得口は 1 つ: 点を選択してから UMAP を計算し直しても、逆に計算してから選択しても、kNN グラフのファイル
 *     （番号と距離）への要求はそれぞれ 1 回だけ（新しいページで数える）。どちらが先でも、もう一方は取得済みのグラフを使う
 *   - データセットを切り替えると、前のデータの近傍の表示が残らず、kNN グラフを捨てる（新しいデータでも選択するまで要求しない）
 *   - MNIST でも近傍の画像の一覧が出て、画像がアトラスのセルと一致する
 *   - コンソールエラーがない
 * ソフトウェア描画では 1 フレームが約 200 ミリ秒かかるので、待ちはフレーム数と状態の変化で数える。失敗があれば終了コード 1 で終わる。
 */
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { loadDataset, waitForServer, startPreview, CHROMIUM_ARGS, sub, len } = require('./lib.cjs');

const root = path.resolve(__dirname, '../..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const outDir = path.resolve(root, opt('out', 'artifacts/neighbors'));
const port = Number(opt('port', '4330'));
const width = 1280, height = 800;
const N = 10;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// ---------- データをファイルから直接読む ----------

function readKnn(dir) {
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const ib = fs.readFileSync(path.join(dir, m.knn.indices.file));
  const indices = m.knn.indices.dtype === 'uint16' ? new Uint16Array(ib.buffer.slice(ib.byteOffset, ib.byteOffset + ib.byteLength))
    : new Uint32Array(ib.buffer.slice(ib.byteOffset, ib.byteOffset + ib.byteLength));
  return { k: m.knn.k, indices, files: [m.knn.indices.file, m.knn.distances.file] };
}
const knnRow = (knn, i, n) => Array.from(knn.indices.subarray(i * knn.k, i * knn.k + n));

/** 座標から総当たりで、点 q の 3 次元での近傍 n 個（自分自身を除く。二乗距離は倍精度、同距離は番号の小さい順） */
function bruteMapNeighbors(positions, q, n) {
  const count = positions.length / 3;
  const x = positions[3 * q], y = positions[3 * q + 1], z = positions[3 * q + 2];
  const all = [];
  for (let j = 0; j < count; j++) {
    if (j === q) continue;
    const dx = positions[3 * j] - x, dy = positions[3 * j + 1] - y, dz = positions[3 * j + 2] - z;
    all.push([dx * dx + dy * dy + dz * dz, j]);
  }
  all.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return all.slice(0, n).map((e) => e[1]);
}

// ---------- ページの操作 ----------

const consoleErrors = [];
const requests = [];
async function openPage(browser, base, dataParam) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`[error] ${m.text()}`); });
  page.on('pageerror', (e) => consoleErrors.push(`[pageerror] ${e.message}`));
  page.on('requestfailed', (r) => consoleErrors.push(`[requestfailed] ${r.url()}`));
  page.on('request', (r) => requests.push(r.url()));
  await page.goto(`${base}?data=${dataParam}`);
  await page.waitForFunction(() => window.__explorer && (window.__explorer.ready || window.__explorer.error), null, { timeout: 60000 });
  const err = await page.evaluate(() => window.__explorer.error);
  if (err) throw new Error(`アプリの起動に失敗: ${err}`);
  return page;
}

const frames = (page, n) => page.evaluate((k) => window.__explorer.measureFrames(k), n);
const nb = (page) => page.evaluate(() => window.__explorer.neighbors.getState());
const ix = (page) => page.evaluate(() => window.__explorer.interaction.getState());
const camState = (page) => page.evaluate(() => window.__explorer.getState());
const project = (page, i) => page.evaluate((k) => window.__explorer.picking.project(k), i);
const knnRequests = (files) => requests.filter((u) => files.some((f) => u.includes(f)));

async function waitFor(page, fn, maxFrames = 40, arg = null) {
  let v;
  for (let k = 0; k <= maxFrames; k++) {
    v = await page.evaluate(fn, arg);
    if (v) return v;
    await frames(page, 1);
  }
  return null;
}

/** カメラが動かなくなるまで待つ。 */
async function waitStill(page, maxFrames = 60) {
  let prev = await camState(page);
  for (let k = 0; k < maxFrames; k++) {
    await frames(page, 1);
    const s = await camState(page);
    if (len(sub(s.position, prev.position)) < 1e-9 && len(sub(s.direction, prev.direction)) < 1e-9) return s;
    prev = s;
  }
  return prev;
}

const pointAt = (page, i) => page.evaluate((k) => { const a = window.__explorer.pointCloud.mesh.geometry.getAttribute('instancePosition'); return [a.getX(k), a.getY(k), a.getZ(k)]; }, i);

/**
 * 点 i を画面の中央に、止まる距離から見る視点に置いて、その点をクリックして選択する（見えなければ向きを変えて試す）。
 * クリックで選べたら true。
 */
async function clickPoint(page, i) {
  const P = await pointAt(page, i);
  const d = (await page.evaluate((k) => window.__explorer.interaction.stopDistance(k), i)).distance;
  const dirs = [[0.3, 0.2, 1], [-0.3, 0.2, -1], [1, 0.2, 0.3], [-1, 0.2, -0.3], [0.2, 1, 0.3], [0.2, -1, -0.3]];
  for (const dir of dirs) {
    const l = Math.hypot(...dir);
    const pos = P.map((v, k) => v + (dir[k] / l) * d * 1.6);
    await page.evaluate((v) => window.__explorer.setView(v), { pos, look: P });
    await frames(page, 2);
    const p = await project(page, i);
    const x = Math.round(p.clientX), y = Math.round(p.clientY);
    const r = await page.evaluate(([a, b]) => window.__explorer.pick(a, b), [x, y]);
    if (r && r.index === i) {
      await page.mouse.click(x, y);
      const ok = await waitFor(page, (k) => window.__explorer.interaction.getState().selected === k, 10, i);
      if (ok) return true;
    }
  }
  return false;
}

/** 描画した画面（上の行から）。 */
async function readFrame(page) {
  return page.evaluate(() => { const f = window.__explorer.picking.readFrame(); return { width: f.width, height: f.height, rgba: Array.from(f.rgba) }; });
}

/** 近傍の水色（#4fd8ff）に近い画素か */
const isCyan = (r, g, b) => b > 150 && g > 110 && r < 0.75 * b && b - r > 60;

/** 2 つの画面の、(x, y) の周り（半径 rad）の水色の画素の数の差（a - b）。 */
function cyanDiff(fa, fb, x, y, rad) {
  let ca = 0, cb = 0;
  for (let yy = Math.max(0, Math.round(y - rad)); yy <= Math.min(fa.height - 1, Math.round(y + rad)); yy++) {
    for (let xx = Math.max(0, Math.round(x - rad)); xx <= Math.min(fa.width - 1, Math.round(x + rad)); xx++) {
      const o = 4 * (yy * fa.width + xx);
      if (isCyan(fa.rgba[o], fa.rgba[o + 1], fa.rgba[o + 2])) ca++;
      if (isCyan(fb.rgba[o], fb.rgba[o + 1], fb.rgba[o + 2])) cb++;
    }
  }
  return ca - cb;
}

/**
 * 2 つの画面の、(x, y) の周り（半径 rad）で、a のほうが水色の向きに明るくなった量（青の増分の合計と、赤の増分の合計）。
 * 薄い線（半透明）は、背景の上で水色の画素にまではならないので、差で見る。
 */
function cyanGain(fa, fb, x, y, rad) {
  let db = 0, dr = 0;
  for (let yy = Math.max(0, Math.round(y - rad)); yy <= Math.min(fa.height - 1, Math.round(y + rad)); yy++) {
    for (let xx = Math.max(0, Math.round(x - rad)); xx <= Math.min(fa.width - 1, Math.round(x + rad)); xx++) {
      const o = 4 * (yy * fa.width + xx);
      db += fa.rgba[o + 2] - fb.rgba[o + 2];
      dr += fa.rgba[o] - fb.rgba[o];
    }
  }
  return { db, dr };
}

async function idHash(page) {
  return page.evaluate(async () => {
    const img = await window.__explorer.picking.readIdImage();
    let h = 0; for (let i = 0; i < img.ids.length; i++) h = (h * 31 + img.ids[i] + 1) >>> 0;
    return h;
  });
}

// ---------- 検証 ----------

/** 選択中の点 q について、一覧・判定・要約を、ファイルと座標から独立に求めたものと比べる。 */
async function checkLists(page, title, q, knn, positions) {
  const st = await nb(page);
  const want = knnRow(knn, q, N);
  check(`${title}: 一覧の番号と順序が kNN グラフのファイルの行と一致する`, JSON.stringify(st.list.indices) === JSON.stringify(want) && JSON.stringify(st.original) === JSON.stringify(want),
    `一覧 ${st.list.indices.join(',')} / ファイル ${want.join(',')}`);
  const map = bruteMapNeighbors(positions, q, N);
  const set = new Set(map);
  const inMap = want.map((j) => set.has(j));
  const matches = inMap.filter(Boolean).length;
  check(`${title}: 3 次元での近傍が、座標から総当たりで求めたものと一致する`, JSON.stringify(st.map) === JSON.stringify(map), `アプリ ${st.map.join(',')} / 総当たり ${map.join(',')}`);
  check(`${title}: 「地図でも近い」の判定と印が、総当たりの結果と一致する`,
    JSON.stringify(st.inMap) === JSON.stringify(inMap) && JSON.stringify(st.list.marks) === JSON.stringify(inMap.map((b) => (b ? '●' : '○'))),
    st.list.marks.join(''));
  check(`${title}: 要約の数が一致する（${matches} 点）`, st.matches === matches && st.list.summary.includes(`地図でも近くにあるのは${matches}点`) && st.list.summary.includes(`近い${N}点のうち`), st.list.summary + st.list.hint);
  return { st, matches, inMap, map };
}

async function testWord2vec(page, base, w2v, knn) {
  console.log('\n[word2vec: 読み込みの遅延]');
  await frames(page, 4);
  check('起動しただけでは kNN グラフを要求しない', knnRequests(knn.files).length === 0 && (await nb(page)).graph === 'idle', knnRequests(knn.files).join(', '));
  const st0 = await nb(page);
  check('kNN グラフのあるデータセットでは使える。地図の上の表示は既定で有効', st0.available && st0.enabled && !st0.overlayVisible);
  const hud = await page.evaluate(() => document.getElementById('hud').textContent);
  check('HUD の操作説明に N キーがある', hud.includes('N 元のデータで近い点'));

  const idxOf = (w) => w2v.text.indexOf(w);
  const jan = idxOf('january'), king = idxOf('king');

  // 読み込み中の表示: 一覧の要約の文の移り変わりを記録する
  await page.evaluate(() => {
    window.__nbTexts = [];
    const el = document.getElementById('info-neighbors-summary');
    new MutationObserver(() => window.__nbTexts.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true });
  });
  const clicked = await clickPoint(page, jan);
  check('「january」をクリックで選択できる', clicked);
  if (!clicked) await page.evaluate((k) => window.__explorer.interaction.select(k), jan);
  const ready = await waitFor(page, () => window.__explorer.neighbors.getState().list.state === 'ready', 60);
  check('点を選択すると kNN グラフを要求し、一覧が出る', ready && knnRequests(knn.files).length >= 2 && (await nb(page)).graph === 'ready' && (await nb(page)).graphLoads === 1,
    `要求 ${knnRequests(knn.files).length}`);
  const texts = await page.evaluate(() => window.__nbTexts);
  check('読み込みの間、情報パネルに「読み込み中」が出る', texts.length >= 2 && texts[0].includes('読み込み中') && texts[texts.length - 1].includes('地図でも近くにあるのは'), texts.join(' → '));

  console.log('\n[word2vec: january]');
  const positions = w2v.positions;
  const j = await checkLists(page, 'january', jan, knn, positions);
  const words = j.st.original.map((i) => w2v.text[i]);
  check('january の近傍は月の名前', words.every((w) => MONTHS.includes(w)), words.join(', '));
  check('january の近傍は、ほぼすべて（8 点以上）が地図でも近い', j.matches >= 8, `${j.matches} 点`);
  check('january の要約は「よく表しています」', j.st.list.hint.includes('よく表しています'), j.st.list.hint);
  const live = await page.evaluate(() => document.getElementById('info-neighbors-live').textContent);
  check('要約が読み上げの領域（#info-neighbors-live）に入る', live === j.st.summary, live);
  await page.screenshot({ path: path.join(outDir, '1-january.png') });

  console.log('\n[word2vec: king]');
  // 一覧のない状態から、king をクリックで選ぶ（jan からの移り変わりで履歴に積まれる）
  const kc = await clickPoint(page, king);
  if (!kc) await page.evaluate((k) => window.__explorer.interaction.select(k), king);
  await waitFor(page, (k) => { const s = window.__explorer.neighbors.getState(); return s.selected === k && s.list.state === 'ready'; }, 20, king);
  const kg = await checkLists(page, 'king', king, knn, positions);
  const kwords = kg.st.original.map((i) => w2v.text[i]);
  check('king の近傍に kings と queen がある', kwords.includes('kings') && kwords.includes('queen'), kwords.join(', '));
  check('king の近傍で地図でも近いものは少ない（3 点以下）', kg.matches <= 3, `${kg.matches} 点`);
  check('kNN グラフは 1 度だけ読み込む', (await nb(page)).graphLoads === 1 && knnRequests(knn.files).length === 2, `${knnRequests(knn.files).length} 回`);

  // 線と輪: 少し引いた視点で、全体が見えるように
  const P = await pointAt(page, king);
  await page.evaluate((v) => window.__explorer.setView(v), { pos: [P[0] + 0.35, P[1] + 0.25, P[2] + 0.7], look: P });
  await frames(page, 3);
  await page.screenshot({ path: path.join(outDir, '2-king.png') });
  await testOverlay(page, 'king', king);
  await testEdges(page, king);
  await testListInteraction(page, king, w2v, knn);
  await testUmap(page, king, knn);
}

/** 地図の上の輪と線、N キー、ピッキング。 */
async function testOverlay(page, title, q) {
  console.log(`\n[${title}: 地図の上の表示]`);
  const st = await nb(page);
  check('地図の上の表示が出ている', st.overlayVisible && st.lines.length > 0, `線 ${st.lines.length} 本`);
  const ps = await project(page, q);
  let maxErr = 0;
  for (const l of st.lines) {
    const pj = await project(page, l.index);
    maxErr = Math.max(maxErr, Math.hypot(l.from[0] - ps.clientX, l.from[1] - ps.clientY), Math.hypot(l.to[0] - pj.clientX, l.to[1] - pj.clientY));
  }
  check('線の端点が、選択中の点と近傍の点を投影した位置にある（0.5 ピクセル以内）', maxErr < 0.5, `最大の差 ${maxErr.toFixed(3)} px`);

  const on = await readFrame(page);
  const hOn = await idHash(page);
  await page.keyboard.press('n');
  await frames(page, 2);
  const off = await nb(page);
  const offFrame = await readFrame(page);
  const hOff = await idHash(page);
  const edgesShown = await page.evaluate(() => [...document.querySelectorAll('#neighbor-edges .nb-edge')].filter((e) => !e.hidden).length);
  check('N キーで地図の上の表示が消える（輪・線・画面の端の印）', !off.enabled && !off.overlayVisible && off.lines.length === 0 && edgesShown === 0);
  check('N キーで消しても、一覧は出たまま', off.list.state === 'ready' && off.list.indices.length === N);
  check('近傍の表示の有無で、ピッキングの番号の画像が変わらない', hOn === hOff, `${hOn} / ${hOff}`);

  // 描画に出ているか: 画面の中の近傍の位置と、長い線の中ほどで、水色の画素が増える
  const inside = (x, y) => x > 20 && y > 60 && x < width - 20 && y < height - 20 && !(x > 900 && y < 340);
  let ringsSeen = 0, ringsTried = 0;
  for (const l of st.lines) {
    if (!inside(l.to[0], l.to[1])) continue;
    ringsTried++;
    if (cyanDiff(on, offFrame, l.to[0], l.to[1], 11) > 4) ringsSeen++;
  }
  let linesSeen = 0, linesTried = 0;
  for (const l of st.lines) {
    const L = Math.hypot(l.to[0] - l.from[0], l.to[1] - l.from[1]);
    if (L < 80) continue;
    const mx = (l.from[0] + l.to[0]) / 2, my = (l.from[1] + l.to[1]) / 2;
    if (!inside(mx, my)) continue;
    linesTried++;
    const g = cyanGain(on, offFrame, mx, my, 3);
    if (g.db > 40 && g.db > 1.5 * Math.max(0, g.dr)) linesSeen++;
  }
  check('画面の中の近傍の位置に、水色の輪が描かれる', ringsTried > 0 && ringsSeen === ringsTried, `${ringsSeen}/${ringsTried}`);
  check('長い線の中ほどに、線が描かれる（薄い線も含めてすべて）', linesTried > 0 && linesSeen === linesTried, `${linesSeen}/${linesTried}`);

  await page.keyboard.press('n');
  await frames(page, 2);
  const back = await nb(page);
  check('もう一度 N キーで戻る', back.enabled && back.overlayVisible && back.lines.length === st.lines.length);
}

/** 画面の外・カメラの後ろの近傍の、画面の端の印。 */
async function testEdges(page, q) {
  console.log('\n[画面の端の印]');
  const st = await nb(page);
  const P = await pointAt(page, q);
  // 最も遠い近傍の反対側を向き、選択中の点のすぐ後ろに立つ（その近傍はカメラの後ろ）
  let far = st.original[0], fd = 0;
  for (const j of st.original) { const Q = await pointAt(page, j); const d = len(sub(Q, P)); if (d > fd) { fd = d; far = j; } }
  const Q = await pointAt(page, far);
  const dir = sub(P, Q).map((v) => v / fd);
  const pos = P.map((v, k) => v - dir[k] * 0.02);
  await page.evaluate((v) => window.__explorer.setView(v), { pos, look: P.map((v, k) => v + dir[k]) });
  await frames(page, 3);
  const s = await nb(page);
  // このスクリプトで投影して、画面の外（またはカメラの後ろ）の近傍を求める
  const outside = [];
  for (const j of st.original) {
    const p = await project(page, j);
    if (p.depth <= 0 || p.clientX < 0 || p.clientX > width || p.clientY < 0 || p.clientY > height) outside.push(j);
  }
  const marked = s.edgeMarkers.map((e) => e.index).sort((a, b) => a - b);
  check('画面の外・カメラの後ろの近傍に、画面の端の印が出る（独立に投影したものと一致する）',
    JSON.stringify(marked) === JSON.stringify([...outside].sort((a, b) => a - b)) && outside.length > 0, `印 ${marked.join(',')} / 外 ${outside.join(',')}`);
  const farMark = s.edgeMarkers.find((e) => e.index === far);
  check('カメラの後ろの近傍の印は「後ろ」になり、画面の端の近くにある', farMark && farMark.behind
    && (farMark.x <= 19 || farMark.x >= width - 19 || farMark.y <= 51 || farMark.y >= height - 19), JSON.stringify(farMark));
  const dom = await page.evaluate(() => [...document.querySelectorAll('#neighbor-edges .nb-edge')].filter((e) => !e.hidden).map((e) => {
    const r = e.getBoundingClientRect(); return { index: Number(e.dataset.index), behind: e.classList.contains('is-behind'), x: r.x, y: r.y };
  }));
  check('印の要素が、その近傍の数だけ画面の中に出る', dom.length === marked.length && dom.every((d) => d.x >= 0 && d.y >= 0 && d.x <= width && d.y <= height), JSON.stringify(dom.slice(0, 3)));
  check('印は操作を受けない（pointer-events: none）', await page.evaluate(() => getComputedStyle(document.getElementById('neighbor-edges')).pointerEvents === 'none'));
  await page.screenshot({ path: path.join(outDir, '3-edges.png') });
}

/** 一覧の項目のホバー・クリック・戻る・キーボード・読み上げ。 */
async function testListInteraction(page, q, w2v, knn) {
  console.log('\n[一覧の操作]');
  // 全体が見える視点に戻す
  const P = await pointAt(page, q);
  await page.evaluate((v) => window.__explorer.setView(v), { pos: [P[0] + 0.35, P[1] + 0.25, P[2] + 0.7], look: P });
  await frames(page, 2);
  const st = await nb(page);
  const before = await readFrame(page);
  const btn = page.locator('#info-neighbors-list button.nb-item').nth(3);
  await btn.hover();
  await frames(page, 2);
  const hv = await nb(page);
  const after = await readFrame(page);
  const l3 = st.lines.find((l) => l.rank === 3);
  let changed = 0;
  if (l3) {
    for (let t = 0.2; t <= 0.8; t += 0.1) changed += Math.abs(cyanDiff(after, before, l3.from[0] + (l3.to[0] - l3.from[0]) * t, l3.from[1] + (l3.to[1] - l3.from[1]) * t, 3));
    changed += Math.abs(cyanDiff(after, before, l3.to[0], l3.to[1], 16));
  }
  check('一覧の項目にカーソルを重ねると、その近傍を地図の上で強調する', hv.list.focused === 3 && (changed > 0 || !l3), `focused ${hv.list.focused}、画素の差 ${changed}`);

  // クリックで選択して飛ぶ
  const target = st.original[1];
  const histBefore = (await nb(page)).history.length;
  await page.locator('#info-neighbors-list button.nb-item').nth(1).click();
  await waitFor(page, (k) => window.__explorer.interaction.getState().selected === k, 10, target);
  const cs = await waitStill(page, 80);
  const T = await pointAt(page, target);
  const stop = (await page.evaluate((k) => window.__explorer.interaction.stopDistance(k), target)).distance;
  const d = len(sub(cs.position, T));
  const sel = (await ix(page)).selected;
  check('項目のクリックで、その点が選択され、その点の手前へ飛ぶ', sel === target && Math.abs(d - stop) < 1e-3, `選択 ${sel}（${w2v.text[target]}）、距離 ${d.toFixed(4)}・止まる距離 ${stop.toFixed(4)}`);
  const pt = await project(page, target);
  check('飛んだ先で、その点が画面の中央に見える', Math.hypot(pt.clientX - width / 2, pt.clientY - height / 2) < 2, `${pt.clientX.toFixed(1)}, ${pt.clientY.toFixed(1)}`);
  const ns = await waitFor(page, (k) => { const s = window.__explorer.neighbors.getState(); return s.selected === k && s.list.state === 'ready' ? s : null; }, 10, target);
  check('飛んだ先の点の一覧に変わる', ns && JSON.stringify(ns.original) === JSON.stringify(knnRow(knn, target, N)) && ns.history.length === histBefore + 1 && ns.history[ns.history.length - 1] === q,
    ns ? `履歴 ${ns.history.join(',')}` : '');
  const backVisible = await page.evaluate(() => !document.getElementById('info-back').hidden);
  check('戻る操作（← 前の点）が出る', backVisible);
  await page.screenshot({ path: path.join(outDir, '4-after-pick.png') });

  // 戻る
  await page.locator('#info-back').click();
  const backed = await waitFor(page, (k) => window.__explorer.interaction.getState().selected === k, 10, q);
  await waitStill(page, 80);
  const cs2 = await camState(page);
  const stopQ = (await page.evaluate((k) => window.__explorer.interaction.stopDistance(k), q)).distance;
  const nb2 = await waitFor(page, (k) => { const s = window.__explorer.neighbors.getState(); return s.selected === k && s.list.state === 'ready' ? s : null; }, 10, q);
  check('戻る操作で、前の選択へ戻り、その点の手前へ飛ぶ', backed && Math.abs(len(sub(cs2.position, P)) - stopQ) < 1e-3 && nb2 && nb2.history.length === histBefore,
    nb2 ? `履歴 ${nb2.history.join(',')}` : '');

  // キーボード: 閉じるボタンから Tab で一覧へ、矢印キーで移り、Enter で選ぶ
  console.log('\n[キーボードと読み上げ]');
  await page.evaluate(() => document.getElementById('info-close').focus());
  let reached = null;
  for (let k = 0; k < 4 && reached === null; k++) {
    await page.keyboard.press('Tab');
    reached = await page.evaluate(() => { const a = document.activeElement; return a && a.classList.contains('nb-item') ? Number(a.dataset.rank) : null; });
  }
  check('Tab キーで一覧の最初の項目へ移る', reached === 0, `${reached}`);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  const r2 = await page.evaluate(() => Number(document.activeElement.dataset.rank));
  const camBefore = await camState(page);
  await frames(page, 2);
  const camAfter = await camState(page);
  check('矢印キーで項目の間を移り、カメラは動かない', r2 === 2 && len(sub(camAfter.position, camBefore.position)) < 1e-9, `rank ${r2}`);
  const tgt2 = (await nb(page)).original[2];
  await page.keyboard.press('Enter');
  const kbSel = await waitFor(page, (k) => window.__explorer.interaction.getState().selected === k, 10, tgt2);
  check('Enter キーで、その項目の点を選択する', !!kbSel);
  await waitStill(page, 80);
  await waitFor(page, () => window.__explorer.neighbors.getState().list.state === 'ready', 10);
  const focusAfter = await page.evaluate(() => { const a = document.activeElement; return a && a.classList.contains('nb-item') ? Number(a.dataset.rank) : null; });
  check('選び直したあと、フォーカスは新しい一覧の先頭へ移る（キーボードでたどり続けられる）', focusAfter === 0, `${focusAfter}`);
  const snap = await page.locator('#info-neighbors').ariaSnapshot();
  const first = (await nb(page)).original[0];
  const firstName = w2v.text[first];
  check('読み上げ: 見出し・リスト・項目の名前（順位・単語・地図でも近いか）が出る',
    snap.includes('heading "元のデータで近い点"') && snap.includes('list "元のデータで近い順"') && new RegExp(`button "1 番目に近い: ${firstName}、地図(でも近い|では離れている)"`).test(snap),
    snap.replace(/\n/g, ' / ').slice(0, 300));
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  // king へ戻しておく
  await page.locator('#info-back').click();
  await waitFor(page, (k) => window.__explorer.interaction.getState().selected === k, 10, q);
  await waitStill(page, 80);
}

/** ブラウザで UMAP を計算し直したあと。 */
async function testUmap(page, q, knn) {
  console.log('\n[ブラウザで計算した埋め込み]');
  const before = await nb(page);
  // 計算の途中の表示を有効にして、途中で線の端点が描いている座標と合うかを見る
  await page.evaluate(() => window.__explorer.umap.setPreview(true));
  const done = page.evaluate(() => window.__explorer.umap.compute({ nNeighbors: 5, minDist: 0.1, seed: 42 }));
  let maxErr = -1, samples = 0;
  for (let k = 0; k < 400 && samples < 3; k++) {
    await frames(page, 1);
    const ph = await page.evaluate(() => { const s = window.__explorer.umap.getState(); return s.loaded ? s.phase : 'idle'; });
    if (ph !== 'running' && ph !== 'morphing') continue;
    const s = await nb(page);
    if (!s.overlayVisible) continue;
    const r = await page.evaluate(async () => {
      const ex = window.__explorer;
      const s = ex.neighbors.getState();
      let e = 0;
      const ps = ex.picking.project(s.selected);
      for (const l of s.lines) {
        const pj = ex.picking.project(l.index);
        e = Math.max(e, Math.hypot(l.from[0] - ps.clientX, l.from[1] - ps.clientY), Math.hypot(l.to[0] - pj.clientX, l.to[1] - pj.clientY));
      }
      return e;
    });
    maxErr = Math.max(maxErr, r);
    samples++;
  }
  const outcome = await done;
  await page.evaluate(() => window.__explorer.umap.setPreview(false));
  check('計算の途中の表示と点の移動の間も、線の端点が描いている座標と合う', samples > 0 && maxErr < 0.5, `${samples} 回、最大の差 ${maxErr.toFixed(3)} px`);
  check('近傍数 5 で計算し直せる', outcome && outcome.ok !== false && (await page.evaluate(() => window.__explorer.umap.getState().current.kind)) === 'computed', JSON.stringify(outcome).slice(0, 120));
  const ready = await waitFor(page, (k) => { const s = window.__explorer.neighbors.getState(); return s && s.selected === k && s.list.state === 'ready' ? s : null; }, 20, q);
  const positions = new Float32Array(await page.evaluate(() => Array.from(window.__explorer.umap.positions())));
  check('計算し直したあとも選択が続き、元の空間での近傍の一覧は同じ', ready && JSON.stringify(ready.original) === JSON.stringify(before.original), ready ? ready.original.join(',') : '');
  const r = await checkLists(page, '近傍数 5 の埋め込み', q, knn, positions);
  check('kNN グラフは読み込み直さない（同じデータセット）', r.st.graphLoads === 1);
  console.log(`  地図でも近い数: 事前計算 ${before.matches} → 近傍数 5 ${r.matches}`);
  await page.screenshot({ path: path.join(outDir, '5-king-nn5.png') });
  const rv = await page.evaluate(() => window.__explorer.umap.revert());
  const back = await waitFor(page, (k) => { const s = window.__explorer.neighbors.getState(); return s && s.selected === k && s.list.state === 'ready' ? s : null; }, 20, q);
  check('事前計算に戻すと、地図でも近い数も戻る', rv && back && back.matches === before.matches && JSON.stringify(back.map) === JSON.stringify(before.map), back ? `${back.matches}` : '');
}

/**
 * kNN グラフの取得口が 1 つであること。新しいページを開き、「選択 → UMAP の計算」と「UMAP の計算 → 選択」のそれぞれで、
 * kNN グラフのファイル（番号と距離）への要求の回数を数える。
 */
async function testSharedFetch(browser, base, w2v, knn) {
  const jan = w2v.text.indexOf('january');
  for (const order of ['select-first', 'compute-first']) {
    const label = order === 'select-first' ? '点を選択 → UMAP を計算し直し' : 'UMAP を計算し直し → 点を選択';
    console.log(`\n[kNN グラフの取得口: ${label}]`);
    const page = await openPage(browser, base, 'word2vec-10k');
    const own = [];
    page.on('request', (r) => { if (knn.files.some((f) => r.url().includes(f))) own.push(r.url()); });
    await frames(page, 4);
    check(`${label}: 起動しただけでは kNN グラフを要求しない`, own.length === 0);
    const select = async () => {
      await page.evaluate((k) => window.__explorer.interaction.select(k), jan);
      return waitFor(page, (k) => { const s = window.__explorer.neighbors.getState(); return s.selected === k && s.list.state === 'ready' ? s : null; }, 60, jan);
    };
    const compute = async () => {
      const outcome = await page.evaluate(() => window.__explorer.umap.compute({ nNeighbors: 5, minDist: 0.1, seed: 42 }));
      return outcome && outcome.ok !== false && (await page.evaluate(() => window.__explorer.umap.getState().current.kind)) === 'computed';
    };
    let ready, computed, mid;
    if (order === 'select-first') {
      ready = await select();
      mid = await nb(page);
      computed = await compute();
    } else {
      computed = await compute();
      mid = await nb(page);
      ready = await select();
    }
    check(`${label}: 選択で一覧が出て、UMAP を計算し直せる`, !!ready && computed);
    const perFile = knn.files.map((f) => own.filter((u) => u.includes(f)).length);
    check(`${label}: kNN グラフのファイル（番号と距離）への要求はそれぞれ 1 回だけ`, perFile.every((n) => n === 1), `${knn.files.join(', ')} → ${perFile.join(', ')}`);
    const st = await nb(page);
    const um = await page.evaluate(() => window.__explorer.umap.getState());
    check(`${label}: 近傍の側は 1 回の取得を共有している（取得 1 回・取得済み）`, st.graph === 'ready' && st.graphLoads === 1 && um.graphLoaded === true, `graph=${st.graph} loads=${st.graphLoads} umap.graphLoaded=${um.graphLoaded}`);
    if (order === 'compute-first') check(`${label}: 計算の時点で取得口は取得済みになり、選択で取得し直さない`, mid.graph === 'ready' && mid.graphLoads === 1, `graph=${mid.graph}`);
    await page.close();
  }
}

async function testSwitch(page, mnist, mknn) {
  console.log('\n[データセットの切り替え]');
  const reqBefore = knnRequests(mknn.files).length;
  const r = await page.evaluate(() => window.__explorer.dataset.switchTo('mnist'));
  await frames(page, 3);
  const st = await nb(page);
  const dom = await page.evaluate(() => ({
    edges: document.querySelectorAll('#neighbor-edges .nb-edge').length,
    shownEdges: [...document.querySelectorAll('#neighbor-edges .nb-edge')].filter((e) => !e.hidden).length,
    items: document.querySelectorAll('#info-neighbors-list li').length,
    sectionHidden: document.getElementById('info-neighbors').hidden,
    infoHidden: document.getElementById('info').hidden,
    live: document.getElementById('info-neighbors-live').textContent,
    back: document.getElementById('info-back').hidden,
  }));
  check('切り替えると、前のデータの近傍の表示が残らない（一覧・画面の端の印・読み上げ・戻る）',
    r.ok && st.selected === null && !st.overlayVisible && dom.items === 0 && dom.sectionHidden && dom.infoHidden && dom.shownEdges === 0 && dom.live === '' && dom.back, JSON.stringify(dom));
  check('画面の端の印の要素は、新しい表示の分だけ（増えない）', dom.edges === N, `${dom.edges}`);
  check('kNN グラフを捨て、新しいデータでは選択するまで要求しない', st.graph === 'idle' && st.graphLoads === 0 && st.history.length === 0 && knnRequests(mknn.files).length === reqBefore);
  // WebGL の資源: 往復しても増えない
  const m0 = await page.evaluate(() => window.__explorer.memory());
  for (const d of ['word2vec-10k', 'mnist']) { await page.evaluate((x) => window.__explorer.dataset.switchTo(x), d); await frames(page, 2); }
  const m1 = await page.evaluate(() => window.__explorer.memory());
  check('データセットを往復しても WebGL の資源が増えない', m1.geometries <= m0.geometries && m1.textures <= m0.textures && m1.programs <= m0.programs, `${JSON.stringify(m0)} → ${JSON.stringify(m1)}`);
}

async function testMnist(page, mnist, mknn) {
  console.log('\n[MNIST]');
  // 中ほどの点を選ぶ
  const q = 1234;
  const ok = await clickPoint(page, q);
  check('MNIST の点をクリックで選択できる', ok);
  if (!ok) await page.evaluate((k) => window.__explorer.interaction.select(k), q);
  const st = await waitFor(page, () => { const s = window.__explorer.neighbors.getState(); return s.list.state === 'ready' ? s : null; }, 60);
  check('MNIST でも選択で kNN グラフを要求する', st && knnRequests(mknn.files).length >= 2);
  await checkLists(page, 'MNIST', q, mknn, mnist.positions);
  const sprite = mnist.manifest.sprite;
  const cmp = await page.evaluate(async ({ file, cell, columns }) => {
    const img = new Image();
    img.src = `data/mnist/${file}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = cell[0]; c.height = cell[1];
    const g = c.getContext('2d', { willReadFrequently: true });
    const out = [];
    for (const b of document.querySelectorAll('#info-neighbors-list button.nb-item')) {
      const i = Number(b.dataset.index);
      const th = b.querySelector('canvas');
      g.clearRect(0, 0, c.width, c.height);
      g.drawImage(img, (i % columns) * cell[0], Math.floor(i / columns) * cell[1], cell[0], cell[1], 0, 0, cell[0], cell[1]);
      const want = g.getImageData(0, 0, c.width, c.height).data;
      const got = th.getContext('2d').getImageData(0, 0, th.width, th.height).data;
      let diff = 0;
      for (let k = 0; k < want.length; k++) diff = Math.max(diff, Math.abs(want[k] - got[k]));
      const r = th.getBoundingClientRect();
      out.push({ i, diff, w: th.width, h: th.height, cssW: r.width, border: getComputedStyle(b).borderBottomColor });
    }
    return out;
  }, { file: sprite.file, cell: sprite.cellSize, columns: sprite.columns });
  check('近傍の画像の一覧が 10 個出て、それぞれがアトラスのセルと一致する', cmp.length === N && cmp.every((x) => x.diff === 0 && x.w === sprite.cellSize[0]), JSON.stringify(cmp.map((x) => x.diff)));
  const colors = await page.evaluate((ids) => ids.map((i) => window.__explorer.dataset.pointColor(i)), cmp.map((x) => x.i));
  const hex = (rgb) => { const m = rgb.match(/\d+/g).map(Number); return `#${m.slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join('')}`; };
  check('画像の下の縁にラベルの色を添える', cmp.every((x, k) => hex(x.border) === colors[k]), cmp.map((x) => hex(x.border)).join(','));
  const P = await pointAt(page, q);
  await page.evaluate((v) => window.__explorer.setView(v), { pos: [P[0] + 0.08, P[1] + 0.05, P[2] + 0.16], look: P });
  await frames(page, 3);
  await testOverlay(page, 'MNIST', q);
  await page.screenshot({ path: path.join(outDir, '6-mnist.png') });
  const rect = await page.evaluate(() => { const r = document.getElementById('info').getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(Math.round); });
  console.log(`  情報パネルの矩形 ${rect.join(', ')}`);
}

async function main() {
  const w2vDir = path.join(root, 'public', 'data', 'word2vec-10k');
  const mnistDir = path.join(root, 'public', 'data', 'mnist');
  const w2v = loadDataset(w2vDir);
  const mnist = loadDataset(mnistDir);
  const wknn = readKnn(w2vDir), mknn = readKnn(mnistDir);

  if (!args.includes('--no-build')) {
    console.log('ビルド中…');
    execSync('npm run build', { cwd: root, stdio: 'inherit' });
  }
  fs.mkdirSync(outDir, { recursive: true });
  const { base, stop } = startPreview(root, port);
  let browser;
  try {
    await waitForServer(base);
    browser = await chromium.launch({ args: CHROMIUM_ARGS });
    const page = await openPage(browser, base, 'word2vec-10k');
    await testWord2vec(page, base, w2v, wknn);
    await testSwitch(page, mnist, mknn);
    await testSharedFetch(browser, base, w2v, wknn);
    await testMnist(page, mnist, mknn);
    await page.close();
    check('コンソールエラーがない', consoleErrors.length === 0, consoleErrors.join(' | '));
  } finally {
    if (browser) await browser.close();
    stop();
  }
  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 件が成功`);
  if (failed.length) console.log(`失敗:\n  ${failed.map((x) => x.name).join('\n  ')}`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exit(1); });
