#!/usr/bin/env node
/**
 * ミニマップ（src/minimap/）の検証。ビルドしてプレビューサーバーを起動し、ヘッドレス Chromium で動かす。
 *
 *   node scripts/verify/minimap.cjs [--no-build] [--port 4322] [--out artifacts/minimap]
 *
 * 確かめること:
 *   - 描画: 地図の領域に点群が描かれ（背景でない画素があり、ラベルの色が含まれる）、全点の投影が領域の内側に収まる
 *   - 向き: 面の基底が、manifest の overview.axes からホームの視点の決め方で求めた右・上・後ろと一致する
 *   - カメラの印: 印の位置がカメラの位置の投影と一致し、面内の各方向と奥行きへ動かすと、印と奥行きの目盛りが対応する向きへ動く。
 *     範囲の外では枠の縁に寄り、外にいることが分かる
 *   - 視線の図形: 視線を面へ投影した向きと一致し、視点を回すと（ドラッグでも）図形も回る
 *   - クリック: 地図のクリックで対応する位置へ移動し、視線の向きと点の選択は変わらない。選択中の点の印が地図と目盛りに出る
 *   - 本体の操作との分離: 地図の上ではホバーが働かず、ドラッグで視点が回らない
 *   - M キー: 消え、もう一度押すと戻る。消えている間は、その領域に本体の描画が見える
 *   - 本体への影響: 地図の領域の外の本体の描画が 1 画素も変わらない。ピッキングの番号の画像が変わらない。
 *     ミニマップを描いたあとの本体の描画が、描く前と同じ（レンダラーの状態が戻っている）
 *   - deviceScaleFactor 2 と、画面の大きさを変えたあとで、領域の位置と大きさが正しい
 *   - 更新の省略: カメラが止まっている間は、ミニマップの SVG・説明の書き換えが 0 回（MutationObserver で数える）。
 *     位置・向きを変えると更新される。点群の描画は止まっている間も毎フレーム行われる
 *   - 手前向き・奥向き: 視線が面に垂直なとき、地図の図形は同じ形だが、目盛りの矢印が上（手前）・下（奥）を向く
 *   - アクセシビリティ: フォーカスできるグループで、説明が実際の操作と一致し、状態の文章が位置・範囲の外を言う。Tab でフォーカスでき、枠が見える
 *   - コンソールエラーがない
 * ソフトウェア描画では 1 フレームが約 200 ミリ秒かかるので、待ちはフレーム数と状態の変化で数える。
 * 失敗があれば終了コード 1 で終わる。スクリーンショットを --out に保存する。
 */
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { loadDataset, computeViews, waitForServer, startPreview, CHROMIUM_ARGS, sub, add, mul, len, norm, waitFlightEnd, expectedFlightDuration } = require('./lib.cjs');

const root = path.resolve(__dirname, '../..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const outDir = path.resolve(root, opt('out', 'artifacts/minimap'));
const port = Number(opt('port', '4322'));
const dataPath = 'data/mnist/';
const width = 1280, height = 800;
const LABEL_COLORS = ['#ff565b', '#f38320', '#fcdd22', '#a5e692', '#1bbf87', '#02eaff', '#3c91fc', '#b67acb', '#fa90c8', '#fafef8'];

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const consoleErrors = [];
async function openPage(browser, base, { viewport = { width, height }, dsf = 1 } = {}) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: dsf });
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`[error] ${m.text()}`); });
  page.on('pageerror', (e) => consoleErrors.push(`[pageerror] ${e.message}`));
  page.on('requestfailed', (r) => consoleErrors.push(`[requestfailed] ${r.url()}`));
  await page.goto(`${base}?data=${dataPath}`);
  await page.waitForFunction(() => window.__explorer && (window.__explorer.ready || window.__explorer.error), null, { timeout: 60000 });
  const err = await page.evaluate(() => window.__explorer.error);
  if (err) throw new Error(`アプリの起動に失敗: ${err}`);
  await frames(page, 3);
  return page;
}

const state = (page) => page.evaluate(() => window.__explorer.getState());
const mm = (page) => page.evaluate(() => window.__explorer.minimap.getState());
const ix = (page) => page.evaluate(() => window.__explorer.interaction.getState());
const frames = (page, n) => page.evaluate((k) => window.__explorer.measureFrames(k), n);
const setView = (page, pos, look) => page.evaluate((v) => window.__explorer.setView(v), { pos, look });
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** 1 フレームずつ進めながら、`fn(page)` が真になるまで最大 `maxFrames` フレーム待つ。 */
async function waitFrames(page, fn, maxFrames = 20) {
  let v;
  for (let k = 0; k <= maxFrames; k++) {
    v = await fn(page);
    if (v && v.ok) return { ...v, frames: k };
    await frames(page, 1);
  }
  return { ...v, frames: maxFrames, ok: false };
}

/** 移動（ミニマップのクリック・ホームへの移動）が終わり（状態と模擬の時間で待つ）、カメラが動かなくなるまで待つ。 */
async function waitStill(page, maxFrames = 40) {
  await waitFlightEnd(page);
  let prev = await state(page);
  for (let k = 0; k < maxFrames; k++) {
    await frames(page, 1);
    const s = await state(page);
    if (!s.homing && len(sub(s.position, prev.position)) < 1e-9 && len(sub(s.direction, prev.direction)) < 1e-9) return s;
    prev = s;
  }
  return prev;
}

// ---------- 期待値（アプリとは独立に計算する）----------

/** src/app/homeView.ts の homeDirection と同じ規則で、中心からホームのカメラへ向かう向き。 */
function homeDirection(axes) {
  if (!axes) return [0, 0, 1];
  const right = norm(axes[0]);
  const k = dot(axes[1], right);
  let up = norm(sub(axes[1], mul(right, k)));
  if (up[1] < 0) up = mul(up, -1);
  let back = norm(cross(right, up));
  const maxPitch = (89 * Math.PI) / 180;
  const el = Math.asin(Math.max(-1, Math.min(1, back[1])));
  if (Math.abs(el) > maxPitch) {
    const h = norm([back[0], 0, back[2]]);
    const e = Math.sign(el) * maxPitch;
    back = [h[0] * Math.cos(e), Math.sin(e), h[2] * Math.cos(e)];
  }
  return back;
}

/** ホームの視点のカメラ（three.js の lookAt、上は +Y）の右・上・後ろ。 */
function expectedBasis(axes) {
  const back = homeDirection(axes);
  const right = norm(cross([0, 1, 0], back));
  const up = cross(back, right);
  return { right, up, back };
}

function expectedLayout(w, h) {
  const size = Math.round(Math.min(200, Math.max(96, Math.min(w, h) * 0.3)));
  return { left: w - 12 - size, top: h - 12 - size, width: size, height: size };
}

/** 状態に含まれる基底と範囲で、ワールド座標を画面上の位置（地図）と目盛りの高さへ。 */
function project(st, p) {
  const { basis: b, extent: e, map, gauge } = st;
  const u = dot(p, b.right), v = dot(p, b.up), w = dot(p, b.back);
  return {
    x: map.left + ((u - e.center[0]) / e.half + 1) * 0.5 * map.width,
    y: map.top + (1 - (v - e.center[1]) / e.half) * 0.5 * map.height,
    depthY: gauge.top + (1 - (w - e.center[2]) / e.half) * 0.5 * gauge.height,
    u, v, w,
  };
}

/** 視線の向き（ワールド）を面へ投影した、画面上の単位ベクトル（下向きが y の正）。 */
function headingOf(st, dir) {
  const x = dot(dir, st.basis.right), y = -dot(dir, st.basis.up);
  const l = Math.hypot(x, y);
  return { x: x / l, y: y / l, length: l };
}

/** SVG に描かれた印と線を読む（画面上の位置）。 */
const readSvg = (page) => page.evaluate(() => {
  const rootEl = document.getElementById('minimap');
  const r = rootEl.getBoundingClientRect();
  const q = (s) => rootEl.querySelector(s);
  const mapG = q('svg > g:nth-of-type(2)'), gaugeG = q('svg > g:nth-of-type(1)');
  const tr = (g) => { const m = /translate\(([-\d.]+),([-\d.]+)\)/.exec(g.getAttribute('transform')); return [Number(m[1]), Number(m[2])]; };
  const [mx, my] = tr(mapG), [gx, gy] = tr(gaugeG);
  const cam = q('.mm-camera'), head = q('.mm-heading'), sel = q('.mm-selected'), depthLine = q('.mm-depth-camera-line'), selLine = q('.mm-depth-selected');
  const n = (el, a) => Number(el.getAttribute(a));
  return {
    hidden: rootEl.hidden, rect: { left: r.left, top: r.top, width: r.width, height: r.height },
    camera: { x: r.left + mx + n(cam, 'cx'), y: r.top + my + n(cam, 'cy'), shown: cam.style.display !== 'none' },
    arrowShown: q('.mm-camera-outside').style.display !== 'none',
    outsideText: q('.mm-outside-text').style.display !== 'none',
    heading: { x1: n(head, 'x1'), y1: n(head, 'y1'), x2: n(head, 'x2'), y2: n(head, 'y2') },
    fanPoints: q('.mm-fan').getAttribute('points').split(' ').length,
    selected: sel.style.display === 'none' ? null : { x: r.left + mx + n(sel, 'cx'), y: r.top + my + n(sel, 'cy') },
    depthY: r.top + gy + n(depthLine, 'y1'),
    selDepthY: selLine.style.display === 'none' ? null : r.top + gy + n(selLine, 'y1'),
  };
});

/**
 * 描画バッファを比べる（ページ内で行い、要約だけ返す）。
 * A = 本体だけ、B = 本体＋ミニマップ、C = B のあとにもう一度本体だけ。
 */
const compareFrames = (page) => page.evaluate((labelColors) => {
  const ex = window.__explorer;
  const st = ex.minimap.getState();
  const A = ex.minimap.readFrame(false);
  const B = ex.minimap.readFrame(true);
  const C = ex.minimap.readFrame(false);
  const { width: W, height: H } = A;
  const k = W / window.innerWidth;
  const m = st.map;
  const x0 = Math.round(m.left * k), y0 = Math.round(m.top * k), x1 = Math.round((m.left + m.width) * k), y1 = Math.round((m.top + m.height) * k);
  const inMap = (x, y) => x >= x0 && x < x1 && y >= y0 && y < y1;
  let outsideDiff = 0, insideDiff = 0, insidePixels = 0, restoreDiff = 0;
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  // 背景の面の色（本体の背景の上に半透明の面）を、領域の中で最も多い色として求める
  const hist = new Map();
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = 4 * (y * W + x);
    const same = A.rgba[o] === B.rgba[o] && A.rgba[o + 1] === B.rgba[o + 1] && A.rgba[o + 2] === B.rgba[o + 2];
    if (A.rgba[o] !== C.rgba[o] || A.rgba[o + 1] !== C.rgba[o + 1] || A.rgba[o + 2] !== C.rgba[o + 2]) restoreDiff++;
    if (inMap(x, y)) {
      insidePixels++;
      if (!same) insideDiff++;
      const key = (B.rgba[o] << 16) | (B.rgba[o + 1] << 8) | B.rgba[o + 2];
      hist.set(key, (hist.get(key) ?? 0) + 1);
    } else if (!same) outsideDiff++;
    if (!same) { bx0 = Math.min(bx0, x); by0 = Math.min(by0, y); bx1 = Math.max(bx1, x); by1 = Math.max(by1, y); }
  }
  let bgKey = 0, bgCount = -1;
  for (const [key, c] of hist) if (c > bgCount) { bgKey = key; bgCount = c; }
  const bg = [(bgKey >> 16) & 255, (bgKey >> 8) & 255, bgKey & 255];
  const cols = labelColors.map((h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]);
  const labelHits = new Array(cols.length).fill(0);
  let nonBg = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const o = 4 * (y * W + x);
    const c = [B.rgba[o], B.rgba[o + 1], B.rgba[o + 2]];
    if (Math.abs(c[0] - bg[0]) + Math.abs(c[1] - bg[1]) + Math.abs(c[2] - bg[2]) > 12) nonBg++;
    cols.forEach((lc, i) => { if (Math.abs(c[0] - lc[0]) <= 6 && Math.abs(c[1] - lc[1]) <= 6 && Math.abs(c[2] - lc[2]) <= 6) labelHits[i]++; });
  }
  return {
    W, H, k, region: [x0, y0, x1, y1], diffBox: [bx0, by0, bx1 + 1, by1 + 1],
    outsideDiff, insideDiff, insidePixels, restoreDiff, bg, nonBg, labelHits,
  };
}, LABEL_COLORS);

/** 番号の画像（ピッキング）を、ミニマップの表示・非表示で比べる。 */
async function compareIdImages(page) {
  return page.evaluate(async () => {
    const ex = window.__explorer;
    const hash = (ids) => { let h = 2166136261; for (let i = 0; i < ids.length; i++) { h ^= ids[i] + 1; h = Math.imul(h, 16777619); } return h >>> 0; };
    await ex.measureFrames(2);
    const a = await ex.picking.readIdImage();
    ex.minimap.setVisible(false);
    await ex.measureFrames(2);
    const b = await ex.picking.readIdImage();
    ex.minimap.setVisible(true);
    await ex.measureFrames(2);
    const c = await ex.picking.readIdImage();
    let diff = 0, nonEmpty = 0;
    for (let i = 0; i < a.ids.length; i++) { if (a.ids[i] !== b.ids[i] || a.ids[i] !== c.ids[i]) diff++; if (a.ids[i] >= 0) nonEmpty++; }
    return { diff, nonEmpty, size: [a.width, a.height], hashes: [hash(a.ids), hash(b.ids), hash(c.ids)] };
  });
}

/** 画面に見えていて、投影した中心で pick するとその点が返る点（地図・HUD・パネルを避ける）。 */
async function findVisiblePoint(page, inRect = null) {
  return page.evaluate(async ({ inRect, w, h }) => {
    const ex = window.__explorer;
    const m = ex.minimap.getState();
    const inMap = (x, y) => x >= m.gauge.left - 8 && y >= m.map.top - 8;
    const ok = inRect
      ? (x, y) => x > inRect.left + 6 && y > inRect.top + 6 && x < inRect.left + inRect.width - 6 && y < inRect.top + inRect.height - 6
      : (x, y) => x > 40 && y > 40 && x < w - 40 && y < h - 40 && !(x > w - 360 && y < 220) && !(x < 640 && y > h - 200) && !inMap(x, y);
    const cands = [];
    for (let i = 0; i < ex.picking.count; i++) {
      const p = ex.picking.project(i);
      if (p.depth <= 0 || p.faded || p.sizePx < 5) continue;
      const x = Math.round(p.clientX), y = Math.round(p.clientY);
      if (!ok(x, y)) continue;
      cands.push({ i, x, y, sizePx: p.sizePx });
    }
    cands.sort((a, b) => b.sizePx - a.sizePx);
    for (const c of cands.slice(0, 60)) {
      const r = await ex.pick(c.x, c.y);
      if (r && r.index === c.i && r.pixelDistance === 0) return c;
    }
    return null;
  }, { inRect, w: width, h: height });
}

const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ---------- 検証本体 ----------

async function testDrawingAndBasis(page, ds) {
  console.log('\n[描画と向き]');
  const st = await mm(page);
  check('既定で表示されている', st.visible && !(await readSvg(page)).hidden);
  const exp = expectedLayout(width, height);
  check('地図の領域が右下 200 ピクセル角', JSON.stringify(st.map) === JSON.stringify(exp), `${JSON.stringify(st.map)} 期待 ${JSON.stringify(exp)}`);
  check('目盛りが地図の左脇にある', st.gauge.left + st.gauge.width < st.map.left && st.gauge.top === st.map.top && st.gauge.height === st.map.height, JSON.stringify(st.gauge));
  check('描く点の数がデータの点数（上限 2 万点以下）', st.pointCount === Math.min(ds.count, 20000), `${st.pointCount}`);

  const eb = expectedBasis(ds.manifest.overview?.axes);
  const err = Math.max(...['right', 'up', 'back'].map((k) => len(sub(st.basis[k], eb[k]))));
  check('面の基底がホームの視点の右・上・後ろ（overview.axes から求めた値）と一致する', err < 1e-6, `差 ${err.toExponential(2)}`);
  const axes = ds.manifest.overview.axes;
  check('第1軸が横、第2軸が縦に並ぶ', dot(axes[0], st.basis.right) > 0.95 && dot(axes[1], st.basis.up) > 0.95,
    `第1軸・横 ${dot(axes[0], st.basis.right).toFixed(4)}、第2軸・縦 ${dot(axes[1], st.basis.up).toFixed(4)}`);

  // ホームの視点のカメラの右・上と一致する（ホームで見える配置と対応する）
  const home = await page.evaluate(() => window.__explorer.homeView());
  const back = norm(sub(home.pos, home.look));
  check('ホームの視点の向きが面の奥行きの向きと一致する', len(sub(back, st.basis.back)) < 1e-6);

  // 全点の投影が領域の内側に収まる
  let outside = 0, minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minD = Infinity, maxD = -Infinity;
  for (let i = 0; i < ds.count; i++) {
    const p = project(st, [ds.positions[3 * i], ds.positions[3 * i + 1], ds.positions[3 * i + 2]]);
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    minD = Math.min(minD, p.depthY); maxD = Math.max(maxD, p.depthY);
    if (p.x < st.map.left || p.x > st.map.left + st.map.width || p.y < st.map.top || p.y > st.map.top + st.map.height) outside++;
  }
  check('全点の投影が地図の内側に収まる', outside === 0,
    `x ${minX.toFixed(1)}〜${maxX.toFixed(1)}、y ${minY.toFixed(1)}〜${maxY.toFixed(1)}（領域 ${st.map.left}〜${st.map.left + st.map.width}、${st.map.top}〜${st.map.top + st.map.height}）`);
  check('全点の奥行きが目盛りの内側に収まる', minD > st.gauge.top && maxD < st.gauge.top + st.gauge.height, `${minD.toFixed(1)}〜${maxD.toFixed(1)}`);
  // アプリの変換との一致（抜き取り）
  const sample = [0, 1234, 5678, ds.count - 1];
  const fromApp = await page.evaluate((list) => list.map((p) => window.__explorer.minimap.worldToMinimap(p)), sample.map((i) => [ds.positions[3 * i], ds.positions[3 * i + 1], ds.positions[3 * i + 2]]));
  const convErr = Math.max(...sample.map((i, k) => { const p = project(st, [ds.positions[3 * i], ds.positions[3 * i + 1], ds.positions[3 * i + 2]]); return Math.max(Math.abs(p.x - fromApp[k].x), Math.abs(p.y - fromApp[k].y), Math.abs(p.depthY - fromApp[k].depthY)); }));
  check('worldToMinimap が独立に求めた投影と一致する', convErr < 1e-6, `差 ${convErr.toExponential(2)}`);
  const round = await page.evaluate(() => {
    const ex = window.__explorer; const p = [0.31, -0.22, 0.17];
    const m = ex.minimap.worldToMinimap(p);
    const back = ex.minimap.minimapToWorld(m.x, m.y, m.plane[2]);
    return Math.hypot(back[0] - p[0], back[1] - p[1], back[2] - p[2]);
  });
  check('minimapToWorld は worldToMinimap の逆', round < 1e-9, `差 ${round.toExponential(2)}`);

  // 画素: 点群が描かれていて、ラベルの色が含まれる
  const f = await compareFrames(page);
  const labelsSeen = f.labelHits.filter((c) => c >= 5).length;
  check('地図の領域に背景でない画素がある（点群が描かれている）', f.nonBg > 1500, `背景でない画素 ${f.nonBg} / ${f.insidePixels}`);
  check('地図の領域にラベルの 10 色がすべて含まれる', labelsSeen === 10, `色ごとの画素数 ${f.labelHits.join(',')}`);
  check('背景の面は本体の背景（#07080c）と区別できる', Math.abs(f.bg[0] - 7) + Math.abs(f.bg[1] - 8) + Math.abs(f.bg[2] - 12) >= 20, `背景の面 rgb(${f.bg.join(',')})`);
  return f;
}

async function testCameraMarker(page, views) {
  console.log('\n[カメラの印と奥行き]');
  const inside = views.find((v) => v.name === '3-inside');
  await setView(page, inside.pos, inside.look);
  await waitStill(page);
  await frames(page, 2);
  const st = await mm(page);
  const s = await state(page);
  const p = project(st, s.position);
  check('印の位置がカメラの位置の投影と一致する', near(st.camera.x, p.x, 1e-6) && near(st.camera.y, p.y, 1e-6) && !st.camera.outside,
    `印 (${st.camera.x.toFixed(2)}, ${st.camera.y.toFixed(2)})、投影 (${p.x.toFixed(2)}, ${p.y.toFixed(2)})`);
  const svg = await readSvg(page);
  check('描かれた印（SVG）が状態の位置にある', near(svg.camera.x, st.camera.x, 0.02) && near(svg.camera.y, st.camera.y, 0.02) && svg.camera.shown,
    `SVG (${svg.camera.x.toFixed(2)}, ${svg.camera.y.toFixed(2)})`);
  check('奥行きの表示がカメラの奥行きの投影と一致する（目盛りの印も）', near(st.depth.y, p.depthY, 1e-6) && near(svg.depthY, st.depth.y, 0.02) && !st.depth.outside,
    `目盛り ${st.depth.y.toFixed(2)}、投影 ${p.depthY.toFixed(2)}、SVG ${svg.depthY.toFixed(2)}`);

  // 面内の各方向と奥行きへ動かす
  const step = 0.12;
  const moves = [
    { name: '右（第1軸の向き）', d: st.basis.right, expect: (a, b) => b.camera.x - a.camera.x > 5 && Math.abs(b.camera.y - a.camera.y) < 0.5 && Math.abs(b.depth.y - a.depth.y) < 0.5 },
    { name: '左', d: mul(st.basis.right, -1), expect: (a, b) => a.camera.x - b.camera.x > 5 && Math.abs(b.camera.y - a.camera.y) < 0.5 },
    { name: '上（第2軸の向き）', d: st.basis.up, expect: (a, b) => a.camera.y - b.camera.y > 5 && Math.abs(b.camera.x - a.camera.x) < 0.5 && Math.abs(b.depth.y - a.depth.y) < 0.5 },
    { name: '下', d: mul(st.basis.up, -1), expect: (a, b) => b.camera.y - a.camera.y > 5 && Math.abs(b.camera.x - a.camera.x) < 0.5 },
    { name: '手前（奥行きの正の向き）', d: st.basis.back, expect: (a, b) => a.depth.y - b.depth.y > 5 && Math.abs(b.camera.x - a.camera.x) < 0.5 && Math.abs(b.camera.y - a.camera.y) < 0.5 },
    { name: '奥', d: mul(st.basis.back, -1), expect: (a, b) => b.depth.y - a.depth.y > 5 && Math.abs(b.camera.x - a.camera.x) < 0.5 },
  ];
  for (const m of moves) {
    const pos = add(s.position, mul(m.d, step));
    await setView(page, pos, add(pos, mul(s.direction, 0.25)));
    await frames(page, 2);
    const b = await mm(page);
    const sv = await readSvg(page);
    const q = project(b, pos);
    const ok = m.expect(st, b) && near(b.camera.x, q.x, 1e-6) && near(b.camera.y, q.y, 1e-6) && near(b.depth.y, q.depthY, 1e-6) &&
      near(sv.camera.x, b.camera.x, 0.02) && near(sv.camera.y, b.camera.y, 0.02) && near(sv.depthY, b.depth.y, 0.02);
    check(`${m.name}へ ${step} 動かすと、印と目盛りが対応する向きへ動く`, ok,
      `印 (${(b.camera.x - st.camera.x).toFixed(2)}, ${(b.camera.y - st.camera.y).toFixed(2)})、目盛り ${(b.depth.y - st.depth.y).toFixed(2)}`);
  }

  // 点群の外の遠方（範囲の外）
  const far = add(mul(st.basis.right, 3.2), add(mul(st.basis.up, 1.4), mul(st.basis.back, 2.6)));
  await setView(page, far, [0, 0, 0]);
  await frames(page, 2);
  const o = await mm(page);
  const sv = await readSvg(page);
  const m = o.map;
  const inFrame = (x, y) => x >= m.left && x <= m.left + m.width && y >= m.top && y <= m.top + m.height;
  const rawDir = Math.atan2(o.camera.rawY - (m.top + m.height / 2), o.camera.rawX - (m.left + m.width / 2));
  const clampedDir = Math.atan2(o.camera.y - (m.top + m.height / 2), o.camera.x - (m.left + m.width / 2));
  const atEdge = Math.min(o.camera.x - m.left, m.left + m.width - o.camera.x, o.camera.y - m.top, m.top + m.height - o.camera.y) < 8;
  check('範囲の外では、印が枠の端に寄り（向きを保つ）、外にいることが分かる', o.camera.outside && inFrame(o.camera.x, o.camera.y) && atEdge &&
    Math.abs(rawDir - clampedDir) < 1e-6 && sv.arrowShown && sv.outsideText && !sv.camera.shown,
    `寄せる前 (${o.camera.rawX.toFixed(1)}, ${o.camera.rawY.toFixed(1)}) → (${o.camera.x.toFixed(1)}, ${o.camera.y.toFixed(1)})、矢印 ${sv.arrowShown}、「範囲外」${sv.outsideText}`);
  check('奥行きが目盛りの範囲の外なら、目盛りの端に寄せて外と分かる', o.depth.outside && o.depth.y >= o.gauge.top && o.depth.y <= o.gauge.top + 4,
    `奥行き ${o.depth.value.toFixed(3)}（目盛り ${o.depth.bottom.toFixed(3)}〜${o.depth.top.toFixed(3)}）、印 ${o.depth.y.toFixed(1)}`);
  await page.screenshot({ path: path.join(outDir, '3-far-outside.png') });
}

async function testHeading(page, views) {
  console.log('\n[視線の向きの図形]');
  const inside = views.find((v) => v.name === '3-inside');
  const st0 = await mm(page);
  const b = st0.basis;
  const dirs = [
    { name: '右', d: b.right }, { name: '上', d: b.up }, { name: '左下', d: norm(add(mul(b.right, -1), mul(b.up, -1))) },
    { name: '斜め奥', d: norm(add(add(b.right, mul(b.up, 0.4)), mul(b.back, -0.8))) },
  ];
  const angles = [];
  for (const t of dirs) {
    await setView(page, inside.pos, add(inside.pos, mul(t.d, 0.25)));
    await frames(page, 2);
    const s = await state(page);
    const m = await mm(page);
    const sv = await readSvg(page);
    const e = headingOf(m, s.direction);
    const lineLen = Math.hypot(sv.heading.x2 - sv.heading.x1, sv.heading.y2 - sv.heading.y1);
    const lx = (sv.heading.x2 - sv.heading.x1) / lineLen, ly = (sv.heading.y2 - sv.heading.y1) / lineLen;
    const ok = near(m.heading.x, e.x, 1e-6) && near(m.heading.y, e.y, 1e-6) && near(m.heading.length, e.length, 1e-6) &&
      near(lx, e.x, 0.02) && near(ly, e.y, 0.02) && sv.fanPoints >= 3;
    angles.push(m.heading.angleDeg);
    check(`視線（${t.name}）の図形が、視線を面へ投影した向きと一致する`, ok,
      `状態 (${m.heading.x.toFixed(3)}, ${m.heading.y.toFixed(3)})、期待 (${e.x.toFixed(3)}, ${e.y.toFixed(3)})、描いた線 (${lx.toFixed(3)}, ${ly.toFixed(3)})、長さの比 ${m.heading.length.toFixed(3)}`);
  }
  check('右・上を向いたときの向きが 0°・90°', near(angles[0], 0, 0.5) && near(angles[1], 90, 0.5), angles.map((a) => a.toFixed(1)).join(', '));

  // ドラッグで視点を回すと、図形も回る。面の横を向いた状態で上へドラッグする（仰角が上がり、図形は反時計回りに回る）。
  // 横へのドラッグは鉛直軸のまわりの回転で、この面（ほぼ鉛直）では向きより長さの比が変わるので、縦のドラッグで調べる
  await setView(page, inside.pos, add(inside.pos, mul(b.right, 0.25)));
  await waitStill(page);
  const before = await mm(page);
  const svBefore = await readSvg(page);
  const sx = 400, sy = 300;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx, sy - 100, { steps: 10 });
  await page.waitForTimeout(250); // ポインタを止めてから離す（離す直前の動きが速いと、回転の慣性が付くので）
  await page.mouse.up();
  await waitStill(page);
  const after = await mm(page);
  const svAfter = await readSvg(page);
  const s = await state(page);
  const e = headingOf(after, s.direction);
  const dAngle = after.heading.angleDeg - before.heading.angleDeg;
  const lineAngle = (v) => Math.atan2(-(v.heading.y2 - v.heading.y1), v.heading.x2 - v.heading.x1) * 180 / Math.PI;
  check('上へドラッグして視点を回すと、図形も回る（上を向くので反時計回り）', dAngle > 5 && near(after.heading.x, e.x, 1e-6) && near(after.heading.y, e.y, 1e-6) &&
    Math.abs((lineAngle(svAfter) - lineAngle(svBefore)) - dAngle) < 1.5,
    `向き ${before.heading.angleDeg.toFixed(1)}° → ${after.heading.angleDeg.toFixed(1)}°、描いた線 ${lineAngle(svBefore).toFixed(1)}° → ${lineAngle(svAfter).toFixed(1)}°`);
}

async function testClickAndSelection(page, views) {
  console.log('\n[クリックで移動・選択中の点]');
  const edge = views.find((v) => v.name === '2-edge');
  await setView(page, edge.pos, edge.look);
  await waitStill(page);
  // 点を選択する（本体のクリック）
  const p = await findVisiblePoint(page);
  check('選択に使う点が見つかる', !!p);
  if (!p) return;
  await page.mouse.click(p.x, p.y);
  const sel = await waitFrames(page, async (pg) => { const s = await ix(pg); return { ok: s.selected === p.i, s }; });
  check('本体のクリックで点を選択できる', sel.ok, `選択 ${sel.s.selected}`);
  await frames(page, 2);
  const ds = global.__ds;
  const pt = [ds.positions[3 * p.i], ds.positions[3 * p.i + 1], ds.positions[3 * p.i + 2]];
  const st = await mm(page);
  const sv = await readSvg(page);
  const q = project(st, pt);
  check('選択中の点の位置が地図と目盛りに出る', st.selected && st.selected.index === p.i && near(st.selected.x, q.x, 1e-6) && near(st.selected.y, q.y, 1e-6) &&
    near(st.selected.depthY, q.depthY, 1e-6) && sv.selected && near(sv.selected.x, q.x, 0.02) && near(sv.selected.y, q.y, 0.02) && near(sv.selDepthY, q.depthY, 0.02),
    `地図 (${q.x.toFixed(1)}, ${q.y.toFixed(1)})、目盛り ${q.depthY.toFixed(1)}`);

  // 地図をクリック
  const before = await state(page);
  const cam = project(st, before.position);
  const target = { x: st.map.left + st.map.width * 0.3, y: st.map.top + st.map.height * 0.7 };
  const e = st.extent;
  const u = e.center[0] + ((2 * (target.x - st.map.left)) / st.map.width - 1) * e.half;
  const v = e.center[1] + (1 - (2 * (target.y - st.map.top)) / st.map.height) * e.half;
  const expected = add(add(mul(st.basis.right, u), mul(st.basis.up, v)), mul(st.basis.back, cam.w));
  await page.mouse.click(target.x, target.y);
  const moving = await waitFrames(page, async (pg) => { const s = await state(pg); return { ok: s.homing || len(sub(s.position, before.position)) > 1e-6, s }; }, 5);
  const mid = await state(page);
  const after = await waitStill(page, 30);
  const ixAfter = await ix(page);
  const m2 = await mm(page);
  const dPos = len(sub(after.position, expected));
  const dDir = len(sub(after.direction, before.direction));
  const midOnLine = (() => { // 途中の位置が始点と終点を結ぶ線の上にある（滑らかに移動する）
    const a = before.position, b = expected, x = mid.position;
    const ab = sub(b, a), t = dot(sub(x, a), ab) / dot(ab, ab);
    return { t, off: len(sub(x, add(a, mul(ab, t)))) };
  })();
  // 所要時間は、基準 0.6 秒を、移動の距離（点群の半径との比）で伸縮した式のとおり
  const R = global.__ds.manifest.bounds.radius;
  const mDist = len(sub(expected, before.position));
  const mWant = expectedFlightDuration(600, mDist, R);
  const mFlight = moving.s && moving.s.flight;
  console.log(`  [実測] 地図のクリック: 距離 ${mDist.toFixed(3)}（点群の半径 ${R.toFixed(3)} の ${(mDist / R).toFixed(2)} 倍）、所要時間 ${mFlight ? mFlight.durationMs.toFixed(0) : '?'}ms（基準 600ms）`);
  check('地図のクリックの移動は、基準 0.6 秒を距離で伸縮した所要時間（0.8〜1.8 倍）', !!mFlight && mFlight.kind === 'home' && Math.abs(mFlight.durationMs - mWant) < 1,
    `${mFlight ? mFlight.durationMs.toFixed(2) : 'なし'}ms、期待 ${mWant.toFixed(2)}ms`);
  check('地図のクリックで、クリックした位置（奥行きはそのまま）へ移動する', moving.ok && dPos < 1e-4 && near(m2.camera.x, target.x, 0.01) && near(m2.camera.y, target.y, 0.01),
    `着いた位置と期待の差 ${dPos.toExponential(2)}、印 (${m2.camera.x.toFixed(2)}, ${m2.camera.y.toFixed(2)})、クリック (${target.x}, ${target.y})`);
  check('移動は滑らか（途中の位置が線の上で、端でない）', midOnLine.t > 0 && midOnLine.t < 1 && midOnLine.off < 1e-4, `途中 t=${midOnLine.t.toFixed(3)}、線からのずれ ${midOnLine.off.toExponential(2)}`);
  check('視線の向きは変わらない', dDir < 1e-6, `差 ${dDir.toExponential(2)}`);
  check('点の選択は変わらない', ixAfter.selected === p.i, `選択 ${ixAfter.selected}`);
  check('奥行きの表示は変わらない', near(m2.depth.value, cam.w, 1e-6), `${cam.w.toFixed(4)} → ${m2.depth.value.toFixed(4)}`);

  // 目盛りのクリックで奥行きだけ変わる
  const g = m2.gauge;
  const gy = g.top + g.height * 0.25;
  const wExp = e.center[2] + (1 - 2 * 0.25) * e.half;
  const b2 = await state(page);
  await page.mouse.click(g.left + g.width / 2, gy);
  await waitFrames(page, async (pg) => ({ ok: (await state(pg)).homing }), 5);
  const a2 = await waitStill(page, 30);
  const m3 = await mm(page);
  check('目盛りのクリックで、面内の位置を保ったまま、その奥行きへ移動する', near(m3.depth.value, wExp, 1e-4) && near(m3.camera.x, m2.camera.x, 0.01) && near(m3.camera.y, m2.camera.y, 0.01) &&
    len(sub(a2.direction, b2.direction)) < 1e-6 && (await ix(page)).selected === p.i,
    `奥行き ${m3.depth.value.toFixed(4)}（期待 ${wExp.toFixed(4)}）`);
  await page.mouse.move(p.x, p.y); // 地図の外へ戻す
}

async function testIsolation(page, views) {
  console.log('\n[本体の操作との分離]');
  const inside = views.find((v) => v.name === '3-inside');
  await setView(page, inside.pos, inside.look);
  await waitStill(page);
  const st = await mm(page);
  // 地図の領域の下に本体の点が見えている位置を探す
  const spot = await page.evaluate(async (m) => {
    const ex = window.__explorer;
    for (let y = m.top + 10; y < m.top + m.height - 10; y += 9) for (let x = m.left + 10; x < m.left + m.width - 10; x += 9) {
      const r = await ex.pick(x, y);
      if (r && r.pixelDistance === 0) return { x, y, index: r.index };
    }
    return null;
  }, st.map);
  check('地図の下に本体の点がある位置が見つかる', !!spot);
  if (spot) {
    // まず本体の点にホバーしてから、地図の上へ動かす
    const p = await findVisiblePoint(page);
    if (p) {
      await page.mouse.move(p.x, p.y);
      await waitFrames(page, async (pg) => ({ ok: (await ix(pg)).hovered === p.i }));
    }
    await page.mouse.move(spot.x, spot.y, { steps: 3 });
    let hovered = [];
    for (let k = 0; k < 6; k++) { await frames(page, 1); hovered.push((await ix(page)).hovered); }
    const top = await page.evaluate(([x, y]) => { const el = document.elementFromPoint(x, y); return el ? (el.closest('#minimap') ? 'minimap' : el.tagName) : null; }, [spot.x, spot.y]);
    check('地図の上では本体のホバーが働かない（下に点があっても）', hovered.every((h) => h === null) && top === 'minimap',
      `下の点 #${spot.index}、ホバー ${JSON.stringify(hovered)}、最前面 ${top}`);
    const label = await page.evaluate(() => document.getElementById('hover-label').hidden);
    check('地図の上ではホバーのラベルが出ない', label);
  }
  // 地図の上のドラッグで視点が回らず、移動もしない
  const before = await state(page);
  const selBefore = (await ix(page)).selected;
  const x0 = st.map.left + 40, y0 = st.map.top + 40;
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x0 + 60, y0 + 30, { steps: 6 });
  await page.mouse.up();
  await frames(page, 4);
  const after = await state(page);
  check('地図の上のドラッグでは、視点が回らず位置も変わらない', len(sub(after.direction, before.direction)) < 1e-9 && len(sub(after.position, before.position)) < 1e-9 && !after.homing);
  check('地図の上のドラッグで選択が変わらない', (await ix(page)).selected === selBefore);
  // 地図の上のホイールで飛行速度が変わらない
  await page.mouse.wheel(0, -300);
  await frames(page, 2);
  check('地図の上のホイールで飛行速度が変わらない', (await state(page)).speed === before.speed, `${before.speed} → ${(await state(page)).speed}`);
}

async function testToggleAndFrames(page) {
  console.log('\n[M キーと本体の描画への影響]');
  const st = await mm(page);
  // 本体の描画: 地図の外は 1 画素も変わらない、描いたあとの本体の描画は描く前と同じ
  const f = await compareFrames(page);
  const [x0, y0, x1, y1] = f.region;
  check('地図の領域の外の本体の描画が、ミニマップの有無で 1 画素も変わらない', f.outsideDiff === 0, `外で違う画素 ${f.outsideDiff}`);
  check('ミニマップの描画は地図の領域だけを変える（違う画素の範囲が領域と一致）', f.diffBox.join(',') === f.region.join(','), `違う範囲 ${f.diffBox.join(',')}、領域 ${f.region.join(',')}`);
  check('ミニマップを描いたあとの本体の描画が、描く前と画素単位で同じ（レンダラーの状態が戻っている）', f.restoreDiff === 0, `違う画素 ${f.restoreDiff}`);
  const ids = await compareIdImages(page);
  check('ピッキングの番号の画像が、ミニマップの有無で変わらない', ids.diff === 0 && ids.nonEmpty > 1000, `違う画素 ${ids.diff}、点のある画素 ${ids.nonEmpty}、${ids.size.join('x')}`);

  // M キー
  const clip = { x: st.map.left, y: st.map.top, width: st.map.width, height: st.map.height };
  const shotOn = await page.screenshot({ clip });
  await page.mouse.move(200, 200);
  await page.keyboard.press('KeyM');
  const off = await waitFrames(page, async (pg) => { const m = await mm(pg); return { ok: !m.visible, m }; }, 3);
  await frames(page, 2);
  const svgOff = await readSvg(page);
  const topOff = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName, [st.map.left + st.map.width / 2, st.map.top + st.map.height / 2]);
  check('M キーで消える（オーバーレイも隠れ、その位置の最前面は本体の canvas）', off.ok && svgOff.hidden && topOff === 'CANVAS', `最前面 ${topOff}`);
  const hud = (await page.evaluate(() => document.getElementById('hud').innerText)).split('\n');
  check('HUD の操作説明に M キーがある', hud[2].includes('M ミニマップ'), JSON.stringify(hud[2]));
  // 消えている間は、その領域に本体の描画が見える: 実際の画面の画素が、本体だけを描いた画素と一致する
  const shotOff = await page.screenshot({ clip });
  const cmp = await page.evaluate(async ({ off, on, region }) => {
    const ex = window.__explorer;
    const A = ex.minimap.readFrame(false);
    const load = (b64) => new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.src = `data:image/png;base64,${b64}`; });
    const read = async (b64) => { const im = await load(b64); const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const g = c.getContext('2d'); g.drawImage(im, 0, 0); return g.getImageData(0, 0, im.width, im.height).data; };
    const offPx = await read(off), onPx = await read(on);
    const [x0, y0, x1, y1] = region;
    let maxDiff = 0, onDiff = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const o = 4 * (y * A.width + x), s = 4 * ((y - y0) * (x1 - x0) + (x - x0));
      for (let c = 0; c < 3; c++) {
        maxDiff = Math.max(maxDiff, Math.abs(A.rgba[o + c] - offPx[s + c]));
        if (Math.abs(onPx[s + c] - offPx[s + c]) > 8) onDiff++;
      }
    }
    return { maxDiff, onDiff };
  }, { off: shotOff.toString('base64'), on: shotOn.toString('base64'), region: [x0, y0, x1, y1] });
  check('消えている間は、その領域に本体の描画が見える（画面の画素が本体だけの描画と一致）', cmp.maxDiff <= 8 && cmp.onDiff > 1000,
    `本体だけとの差の最大 ${cmp.maxDiff}、表示中との違い ${cmp.onDiff}`);
  // 消えている間は、その領域でホバーが働く
  await page.keyboard.press('KeyM');
  const on = await waitFrames(page, async (pg) => { const m = await mm(pg); return { ok: m.visible, m }; }, 3);
  await frames(page, 2);
  const svgOn = await readSvg(page);
  check('もう一度押すと戻る', on.ok && !svgOn.hidden);
  // 入力欄の中の M は切り替えない
  await page.evaluate(() => { const i = document.createElement('input'); i.id = 'mm-test-input'; i.style.position = 'fixed'; i.style.left = '10px'; i.style.top = '10px'; document.body.append(i); i.focus(); });
  await page.keyboard.press('KeyM');
  await frames(page, 2);
  check('入力欄の中の M では切り替えない', (await mm(page)).visible);
  await page.evaluate(() => document.getElementById('mm-test-input').remove());
}


/** 地図の領域の画面の画素（SVG も含む）に、ラベルの色の点がどれだけあるか。点群が毎フレーム描かれていれば多い。 */
async function labelPixelsOnScreen(page, map) {
  const shot = await page.screenshot({ clip: { x: map.left, y: map.top, width: map.width, height: map.height } });
  return page.evaluate(async ({ b64, labelColors }) => {
    const im = await new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = `data:image/png;base64,${b64}`; });
    const c = document.createElement('canvas'); c.width = im.width; c.height = im.height;
    const g = c.getContext('2d'); g.drawImage(im, 0, 0);
    const d = g.getImageData(0, 0, im.width, im.height).data;
    const cols = labelColors.map((h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]);
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (cols.some((lc) => Math.abs(d[i] - lc[0]) <= 6 && Math.abs(d[i + 1] - lc[1]) <= 6 && Math.abs(d[i + 2] - lc[2]) <= 6)) n++;
    return n;
  }, { b64: shot.toString('base64'), labelColors: LABEL_COLORS });
}

async function testIdleUpdates(page, views) {
  console.log('\n[カメラが止まっている間は SVG を更新しない]');
  const inside = views.find((v) => v.name === '3-inside');
  await setView(page, inside.pos, inside.look);
  await waitStill(page);
  await frames(page, 3);
  const st = await mm(page);
  // ミニマップの要素（SVG・説明）の変化を数える。属性の書き換え（同じ値でも 1 回と数える）、子要素・文字の変更
  await page.evaluate(() => {
    const el = document.getElementById('minimap');
    window.__mmMutations = 0;
    window.__mmObserver = new MutationObserver((list) => { window.__mmMutations += list.length; });
    window.__mmObserver.observe(el, { attributes: true, childList: true, characterData: true, subtree: true });
  });
  const mutations = () => page.evaluate(() => { window.__mmObserver.takeRecords().forEach(() => window.__mmMutations++); return window.__mmMutations; });
  const reset = () => page.evaluate(() => { window.__mmObserver.takeRecords(); window.__mmMutations = 0; });
  await reset();
  const N = 25;
  await frames(page, N);
  const idle = await mutations();
  check(`カメラが止まっている ${N} フレームの間、ミニマップの SVG・説明の書き換えが 0 回`, idle === 0, `書き換え ${idle} 回`);
  const lit = await labelPixelsOnScreen(page, st.map);
  check('止まっている間も、地図の点群は毎フレーム描かれている（画面の画素にラベルの色の点がある）', lit > 500, `ラベルの色の画素 ${lit}`);

  // 動かす：位置、向き
  const s = await state(page);
  await reset();
  const pos = add(inside.pos, mul(st.basis.right, 0.02));
  await setView(page, pos, add(pos, mul(s.direction, 0.25)));
  await frames(page, 2);
  const afterMove = await mutations();
  check('カメラを動かす（位置）と、SVG が更新される', afterMove > 0, `書き換え ${afterMove} 回`);
  const movedState = await mm(page);
  const svg = await readSvg(page);
  check('更新された SVG が新しい位置を指している', near(svg.camera.x, movedState.camera.x, 0.02) && near(svg.camera.y, movedState.camera.y, 0.02), `SVG (${svg.camera.x.toFixed(2)}, ${svg.camera.y.toFixed(2)})`);

  await frames(page, 3);
  await reset();
  await frames(page, 10);
  check('動かしたあと止まると、再び書き換えが 0 回', (await mutations()) === 0);

  await reset();
  const turned = add(pos, mul(norm(add(s.direction, mul(st.basis.up, 0.5))), 0.25));
  await setView(page, pos, turned);
  await frames(page, 2);
  check('カメラの向きだけを変えても SVG が更新される', (await mutations()) > 0);

  // 表示の切り替え：消して戻すと、止まったままでも描き直される（前の状態のままではない）
  await frames(page, 3);
  await page.keyboard.press('KeyM');
  await frames(page, 2);
  await page.keyboard.press('KeyM');
  await frames(page, 3);
  const back = await readSvg(page);
  const bs = await mm(page);
  check('M で消して戻したあとも、SVG が現在の状態を指している', !back.hidden && near(back.camera.x, bs.camera.x, 0.02) && near(back.camera.y, bs.camera.y, 0.02));
  await page.evaluate(() => window.__mmObserver.disconnect());
}

/** 目盛りの側の、手前向き・奥向きの印を読む。 */
const readFacing = (page) => page.evaluate(() => {
  const q = (s) => document.querySelector(`#minimap ${s}`);
  const n = (el, a) => Number(el.getAttribute(a));
  const line = q('.mm-facing-line'), head = q('.mm-facing-head'), cam = q('.mm-depth-camera-line');
  const shown = line.style.display !== 'none' && head.style.display !== 'none';
  const pts = head.getAttribute('points').split(' ').map((p) => p.split(',').map(Number));
  return { shown, camY: n(cam, 'y1'), lineY1: n(line, 'y1'), lineY2: n(line, 'y2'), tipY: pts[0] ? pts[0][1] : NaN, fan: q('.mm-fan').getAttribute('points') };
});

async function testFacing(page, views) {
  console.log('\n[手前向きか奥向きかの印（視線が面に垂直なとき）]');
  const inside = views.find((v) => v.name === '3-inside');
  await setView(page, inside.pos, inside.look);
  await waitStill(page);
  const b = (await mm(page)).basis;
  const shape = (fan) => fan.split(' ').map((p) => p.split(',').map(Number)).sort((a, c) => a[0] - c[0] || a[1] - c[1]);
  const out = {};
  for (const t of [{ name: '手前向き', sign: 1, facing: 'near' }, { name: '奥向き', sign: -1, facing: 'far' }]) {
    await setView(page, inside.pos, add(inside.pos, mul(b.back, 0.25 * t.sign)));
    await frames(page, 2);
    const m = await mm(page);
    const f = await readFacing(page);
    out[t.facing] = { m, f };
    const up = t.facing === 'near';
    check(`視線が面に垂直（${t.name}）：状態が ${t.facing}、視線の長さが 0`, m.heading.facing === t.facing && Math.abs(Math.abs(m.heading.depth) - 1) < 1e-6 && m.heading.length < 1e-6,
      `facing ${m.heading.facing}、奥行き成分 ${m.heading.depth.toFixed(4)}、面に沿った長さ ${m.heading.length.toExponential(2)}`);
    check(`視線が面に垂直（${t.name}）：目盛りの印が ${up ? '上（手前）' : '下（奥）'}向きの矢印`, f.shown && (up ? f.tipY < f.camY - 5 : f.tipY > f.camY + 5),
      `矢印の先 ${f.tipY.toFixed(1)}、カメラの目盛り ${f.camY.toFixed(1)}`);
  }
  const sa = shape(out.near.f.fan), sb = shape(out.far.f.fan);
  const same = sa.length === sb.length && sa.every((p, i) => Math.abs(p[0] - sb[i][0]) < 0.05 && Math.abs(p[1] - sb[i][1]) < 0.05);
  check('視線が面に垂直だと、地図の視野の図形は手前向きでも奥向きでも同じ形（矢印がなければ区別できない）', same, `${out.near.f.fan} / ${out.far.f.fan}`);
  // 斜め：矢印の長さが奥行き成分に応じて変わる
  const tilt = (k) => norm(add(mul(b.right, Math.sqrt(1 - k * k)), mul(b.back, -k)));
  const lens = [];
  for (const k of [0.3, 0.7, 1]) {
    await setView(page, inside.pos, add(inside.pos, mul(tilt(k), 0.25)));
    await frames(page, 2);
    const f = await readFacing(page);
    lens.push(f.shown ? Math.abs(f.tipY - f.camY) : 0);
  }
  check('奥向きの成分が大きいほど、矢印が長い', lens[0] > 0 && lens[0] < lens[1] && lens[1] < lens[2], lens.map((v) => v.toFixed(1)).join(' < '));
  // 面に平行な視線では出さない
  await setView(page, inside.pos, add(inside.pos, mul(b.right, 0.25)));
  await frames(page, 2);
  const lv = await readFacing(page);
  const lm = await mm(page);
  check('視線が面に平行なら、矢印を出さない', !lv.shown && lm.heading.facing === 'level');
  // 範囲の外でも、矢印が目盛りの外へはみ出さない
  const far = add(mul(b.right, 3.2), add(mul(b.up, 1.4), mul(b.back, 2.6)));
  await setView(page, far, [0, 0, 0]);
  await frames(page, 2);
  const o = await readFacing(page);
  const om = await mm(page);
  check('範囲の外でも、矢印の先が目盛りの内側に収まる', !o.shown || (o.tipY >= 0 && o.tipY <= om.gauge.height), `先 ${o.tipY.toFixed(1)}（目盛りの高さ ${om.gauge.height}）、facing ${om.heading.facing}`);
  await setView(page, inside.pos, add(inside.pos, mul(b.back, -0.25)));
  await waitStill(page);
  await frames(page, 2);
  await page.screenshot({ path: path.join(outDir, '4-facing-far.png'), clip: { x: om.gauge.left - 20, y: om.gauge.top - 20, width: om.gauge.width + om.map.width + 40, height: om.map.height + 40 } });
  await setView(page, inside.pos, add(inside.pos, mul(b.back, 0.25)));
  await waitStill(page);
  await frames(page, 2);
  await page.screenshot({ path: path.join(outDir, '4-facing-near.png'), clip: { x: om.gauge.left - 20, y: om.gauge.top - 20, width: om.gauge.width + om.map.width + 40, height: om.map.height + 40 } });
}

async function testAccessibility(page, views) {
  console.log('\n[アクセシビリティ：フォーカスと読み上げ]');
  const inside = views.find((v) => v.name === '3-inside');
  const b = (await mm(page)).basis;
  await setView(page, inside.pos, add(inside.pos, mul(b.back, -0.25)));
  await waitStill(page);
  await frames(page, 3);
  const attrs = await page.evaluate(() => {
    const el = document.getElementById('minimap');
    const text = (id) => document.getElementById(id)?.textContent ?? null;
    const desc = (el.getAttribute('aria-describedby') ?? '').split(/\s+/).map(text);
    return {
      role: el.getAttribute('role'), tabindex: el.getAttribute('tabindex'), label: el.getAttribute('aria-label'),
      svgHidden: el.querySelector('svg').getAttribute('aria-hidden'), desc, status: text('minimap-status'),
      live: document.getElementById('minimap-status').getAttribute('aria-live'),
    };
  });
  check('role="img" ではなく、フォーカスできるグループ（tabindex 0）', attrs.role === 'group' && attrs.tabindex === '0' && !!attrs.label, JSON.stringify({ role: attrs.role, tabindex: attrs.tabindex, label: attrs.label }));
  check('中の図（SVG）は読み上げの対象外', attrs.svgHidden === 'true');
  check('説明（aria-describedby）に、実際にできる操作が書かれている（クリックで移動、キーボードでは移動できない）',
    attrs.desc.length === 2 && attrs.desc.every((t) => t && t.length > 0) && attrs.desc[0].includes('クリック') && attrs.desc[0].includes('キーボードでは移動できません'), attrs.desc[0] ?? '');
  check('状態の文章が、現在位置と視線の向きを言う', /^現在位置: 地図の.+あたり、奥行きは.+。視線は.+。$/.test(attrs.status ?? ''), attrs.status ?? '');

  // Tab でフォーカスできる
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  let focused = false, tabs = 0;
  for (; tabs < 40 && !focused; tabs++) {
    await page.keyboard.press('Tab');
    focused = await page.evaluate(() => document.activeElement && document.activeElement.id === 'minimap');
  }
  check('Tab キーでミニマップにフォーカスできる', focused, `Tab ${tabs} 回`);
  if (focused) {
    const f = await page.evaluate(() => {
      const el = document.getElementById('minimap');
      const cs = getComputedStyle(el);
      return { outline: cs.outlineStyle, width: cs.outlineWidth, color: cs.outlineColor, live: document.getElementById('minimap-status').getAttribute('aria-live'), focusVisible: el.matches(':focus-visible') };
    });
    check('キーボードでフォーカスすると、枠（outline）が見える', f.focusVisible && f.outline === 'solid' && parseFloat(f.width) >= 2, `${f.outline} ${f.width} ${f.color}`);
    check('フォーカス中は、状態の変化が aria-live で知らされる', f.live === 'polite', f.live);
    // フォーカス中に位置が変わると、文章が変わる
    const before = (await page.evaluate(() => document.getElementById('minimap-status').textContent));
    const far = add(mul(b.right, 3.2), add(mul(b.up, 1.4), mul(b.back, 2.6)));
    await setView(page, far, [0, 0, 0]);
    await frames(page, 3);
    const after = await page.evaluate(() => document.getElementById('minimap-status').textContent);
    check('範囲の外へ出ると、状態の文章が「範囲の外」になる', after !== before && after.includes('地図の範囲の外') && after.includes('目盛りの範囲の外'), after);
    await setView(page, inside.pos, inside.look);
    await waitStill(page);
    await frames(page, 3);
    const back = await page.evaluate(() => document.getElementById('minimap-status').textContent);
    check('範囲の中へ戻ると、文章も戻る', back.includes('地図の') && !back.includes('範囲の外'), back);
    // M キーはフォーカス中も効く
    await page.keyboard.press('KeyM');
    await frames(page, 2);
    check('フォーカス中も M キーで表示を切り替えられる（消えるとフォーカスも外れる）', !(await mm(page)).visible);
    await page.keyboard.press('KeyM');
    await frames(page, 2);
    check('もう一度 M で戻る', (await mm(page)).visible);
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    const live2 = await page.evaluate(() => document.getElementById('minimap-status').getAttribute('aria-live'));
    check('フォーカスが外れると aria-live は off', live2 === 'off', live2);
  }
  // マウスのクリックでは枠が出ない（フォーカスは奪わない）
  const m = await mm(page);
  await page.mouse.click(m.map.left + 30, m.map.top + 30);
  await waitFrames(page, async (pg) => ({ ok: (await state(pg)).homing }), 5);
  await waitStill(page, 40);
  const noRing = await page.evaluate(() => !document.getElementById('minimap').matches(':focus-visible'));
  check('マウスのクリックでは、フォーカスの枠が出ない', noRing);
}

async function testLayout(browser, base, cfg) {
  console.log(`\n[領域の位置と大きさ: ${cfg.name}]`);
  const page = await openPage(browser, base, { viewport: cfg.viewport, dsf: cfg.dsf });
  try {
    if (cfg.resizeTo) {
      await page.setViewportSize(cfg.resizeTo);
      await waitFrames(page, async (pg) => { const m = await mm(pg); return { ok: m.map.left + m.map.width === cfg.resizeTo.width - 12 }; }, 5);
      await frames(page, 2);
    }
    const vw = (cfg.resizeTo ?? cfg.viewport).width, vh = (cfg.resizeTo ?? cfg.viewport).height;
    const st = await mm(page);
    const exp = expectedLayout(vw, vh);
    const svg = await readSvg(page);
    check(`${cfg.name}: 地図の領域（CSS ピクセル）が正しい`, JSON.stringify(st.map) === JSON.stringify(exp), `${JSON.stringify(st.map)} 期待 ${JSON.stringify(exp)}`);
    check(`${cfg.name}: オーバーレイの位置が地図と目盛りの領域に一致する`, near(svg.rect.left, st.gauge.left, 0.01) && near(svg.rect.top, st.map.top, 0.01) &&
      near(svg.rect.left + svg.rect.width, st.map.left + st.map.width, 0.01) && near(svg.rect.height, st.map.height, 0.01), JSON.stringify(svg.rect));
    const f = await compareFrames(page);
    const k = cfg.dsf;
    const expRegion = [exp.left * k, exp.top * k, (exp.left + exp.width) * k, (exp.top + exp.height) * k];
    check(`${cfg.name}: 描画バッファの上で、点群を描いた範囲が地図の領域（× deviceScaleFactor ${k}）と一致する`,
      f.diffBox.join(',') === expRegion.join(',') && f.outsideDiff === 0 && f.W === vw * k,
      `違う範囲 ${f.diffBox.join(',')}、期待 ${expRegion.join(',')}、描画バッファ ${f.W}x${f.H}`);
    check(`${cfg.name}: ラベルの色の点が描かれている`, f.labelHits.filter((c) => c >= 3).length >= 9, f.labelHits.join(','));
    check(`${cfg.name}: 描いたあとの本体の描画が戻っている`, f.restoreDiff === 0, `${f.restoreDiff}`);
    // 地図の中心をクリックすると、地図の中心の位置へ移動する（座標の対応が大きさの変更後も正しい）
    const before = await state(page);
    const cx = st.map.left + st.map.width / 2, cy = st.map.top + st.map.height / 2;
    await page.mouse.click(cx, cy);
    await waitFrames(page, async (pg) => ({ ok: (await state(pg)).homing }), 5);
    await waitStill(page, 30);
    const m2 = await mm(page);
    check(`${cfg.name}: 地図のクリックで、その位置へ印が来る`, near(m2.camera.x, cx, 0.01) && near(m2.camera.y, cy, 0.01) && near(m2.depth.value, project(st, before.position).w, 1e-6),
      `印 (${m2.camera.x.toFixed(2)}, ${m2.camera.y.toFixed(2)})、クリック (${cx}, ${cy})`);
    await page.screenshot({ path: path.join(outDir, `layout-${cfg.name}.png`) });
  } finally {
    await page.close();
  }
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  if (!args.includes('--no-build')) {
    console.log('ビルド中…');
    execSync('npm run build', { cwd: root, stdio: 'inherit' });
  }
  const ds = loadDataset(path.join(root, 'public', dataPath));
  global.__ds = ds;
  const { views } = computeViews(ds);
  const { base, stop } = startPreview(root, port);
  let browser;
  try {
    await waitForServer(base);
    browser = await chromium.launch({ args: CHROMIUM_ARGS });
    const page = await openPage(browser, base);
    await waitStill(page);
    await page.screenshot({ path: path.join(outDir, '1-home.png') });
    await testDrawingAndBasis(page, ds);
    await testCameraMarker(page, views);
    await testHeading(page, views);
    await testClickAndSelection(page, views);
    await testIsolation(page, views);
    await testToggleAndFrames(page);
    await testIdleUpdates(page, views);
    await testFacing(page, views);
    await testAccessibility(page, views);
    // クラスタの内部の画像
    const inside = views.find((v) => v.name === '3-inside');
    await setView(page, inside.pos, inside.look);
    await waitStill(page);
    await page.screenshot({ path: path.join(outDir, '2-inside.png') });
    await page.close();

    await testLayout(browser, base, { name: 'dpr2', dsf: 2, viewport: { width, height } });
    await testLayout(browser, base, { name: 'resized', dsf: 1, viewport: { width, height }, resizeTo: { width: 700, height: 460 } });
    await testLayout(browser, base, { name: 'dpr2-resized', dsf: 2, viewport: { width, height }, resizeTo: { width: 960, height: 640 } });
  } finally {
    if (browser) await browser.close();
    stop();
  }
  check('コンソールエラーがない', consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' | '));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} / ${results.length} 件が成功。画像は ${path.relative(root, outDir)}/`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
