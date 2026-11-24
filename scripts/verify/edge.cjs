#!/usr/bin/env node
/**
 * クラスタの縁や少し外から見たときの、丸い点・単語の文字・目印の両立の検証。word2vec と MNIST の 5 つの視点
 * （ホーム・クラスタの少し外・縁・内部・内部の密な場所）で、次の値を測ってスクリーンショットを撮る。
 *
 *   node scripts/verify/edge.cjs [--no-build] [--port 4350] [--out artifacts/edge] [--report-only]
 *
 * 測る値:
 *   - 丸い点の画面上の直径（CSS ピクセル）。番号の画像に見えている点ごとに、点群のシェーダと同じ式（独立に書いたもの）で求めた直径の最大値と、
 *     番号の画像での実際の縦の広がりの最大値
 *   - 表示中の単語の数、文字の高さ（1 em）の最小値、12px 以上の単語の数
 *   - 画面に出ている目印の数、現在地の表示
 * 確かめること（--report-only では値を出すだけ）:
 *   - word2vec の縁と少し外の視点で、丸い点の直径の最大値が、表示中の単語の文字の高さの最小値以下（DOT_TO_TEXT_MAX 倍以下）
 *   - word2vec の内部の視点で、近い点ほど大きい（直径の最大値が最小サイズの 2 倍以上）
 *   - 縁の視点で、画面に出る目印の数が NEAR_LABEL_LIMIT 以下。現在地の表示が出ている
 *   - クラスタの内部・内部の密な場所の視点でも、画面に出る目印の数が NEAR_LABEL_LIMIT 以下（内部も外と同じ規則で数を控える）
 *   - ホームの視点で、目印の数が変更前（HOME_LABELS_BEFORE）と同じ
 *   - word2vec の縁の視点で、単語が出ている（12px 以上の単語が 15 語以上）
 *   - 縁の視点の小さな点（直径が最小サイズに近い点）でも、点の中心から 4 CSS ピクセルずらした位置のホバーで、その点が選ばれる（吸着）
 *   - word2vec の少し外・縁・内部で、単語の矩形の近くに中心がある丸い点の直径が NEAR_WORD_DOT_MAX 以下（文字の周りの点を小さくする）
 *   - 表示中の目印の矩形と単語の矩形が重ならない
 *   - 目印の数の上限が切り替わる境目で、カメラを小さく往復させても、目印の表示が切り替わり続けない
 *   - コンソールエラーがない
 */
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { loadDataset, computeViews, waitForServer, startPreview, CHROMIUM_ARGS, sub, add, mul, len, norm, waitCameraIdle } = require('./lib.cjs');

const root = path.resolve(__dirname, '../..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const outDir = path.resolve(root, opt('out', 'artifacts/edge'));
const port = Number(opt('port', '4350'));
const reportOnly = args.includes('--report-only');
const width = 1280, height = 800;

/** 丸い点の直径の最大値の、単語の文字の高さ（1 em）の最小値に対する上限 */
const DOT_TO_TEXT_MAX = 1.0;
/** クラスタの縁の視点で、画面に出してよい目印の数の上限（src/labels/budget.ts の NEAR_LABEL_COUNT と同じ） */
const NEAR_LABEL_LIMIT = 3;
/** 変更前（63fa2d5）のホームの視点での目印の数（1280×800） */
const HOME_LABELS_BEFORE = { 'word2vec-10k': 10, mnist: 10 };
/** 単語の矩形の近くの丸い点（src/text/clearance.ts の DOT_CLEARANCE_MARGIN_PX・DOT_CLEARANCE_SCALE と同じ値）。直径の上限は 10 × 0.4 */
const CLEAR_MARGIN_PX = 4;
const NEAR_WORD_DOT_MAX = 4;
/** 吸着の確認で、点の中心からずらす距離（CSS ピクセル。吸着の半径 7 より小さい） */
const SNAP_OFFSET_PX = 4;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const consoleErrors = [];

const state = (page) => page.evaluate(() => window.__explorer.getState());
const frames = (page, n) => page.evaluate((k) => window.__explorer.measureFrames(k), n);
const setView = (page, v) => page.evaluate((x) => window.__explorer.setView(x), { pos: v.pos, look: v.look });

async function waitStill(page, maxFrames = 80) {
  await waitCameraIdle(page); // 自動移動・ホームへの移動・向き直し・切り替えの残った動きが終わるまで（模擬の時間で）
  let prev = await state(page);
  for (let k = 0; k < maxFrames; k++) {
    await frames(page, 1);
    const s = await state(page);
    if (!s.homing && len(sub(s.position, prev.position)) < 1e-9 && len(sub(s.direction, prev.direction)) < 1e-9) return s;
    prev = s;
  }
  return prev;
}

/** カメラが止まり、単語と目印の表示が 3 フレーム続けて変わらなくなるまで待つ。 */
async function waitSettled(page, maxFrames = 60) {
  await waitStill(page);
  let prev = null, same = 0;
  for (let k = 0; k < maxFrames; k++) {
    await frames(page, 1);
    const key = await page.evaluate(() => {
      const ex = window.__explorer;
      const w = ex.words.getState();
      const l = ex.labels.getState();
      const words = w ? `${w.shown.map((s) => s.index).sort((a, b) => a - b).join(',')}|${w.fading}` : '';
      return `${words}#${l.labels.filter((s) => s.visible).map((s) => s.id).join(',')}`;
    });
    same = key === prev ? same + 1 : 0;
    prev = key;
    if (same >= 3) return;
  }
}

/* eslint-disable no-undef */
/** ページの中で、見えている丸い点の直径・単語・目印を測る。 */
async function measure([SNAP, CLEAR_MARGIN]) {
  const ex = window.__explorer, dbg = ex.picking;
  const img = await dbg.readIdImage();
  const { width: W, height: H, ids } = img;
  const scale = dbg.bufferScale();
  const cloud = ex.pointCloud;
  const p = cloud.params;
  const dotScales = cloud.dotScales;
  const ws = ex.words.getState();
  const wordSet = new Set(ws ? ws.shown.map((w) => w.index) : []);
  // 番号の画像での縦の広がり（実際に描かれた形。手前の点に隠れると短くなる）
  const extent = new Map();
  for (let x = 0; x < W; x++) {
    let run = -1, start = 0;
    for (let y = 0; y <= H; y++) {
      const id = y < H ? ids[y * W + x] : -1;
      if (id !== run) {
        if (run >= 0 && !wordSet.has(run)) extent.set(run, Math.max(extent.get(run) ?? 0, y - start));
        run = id; start = y;
      }
    }
  }
  let maxDiameter = 0, maxMeasured = 0, minDiameter = Infinity, maxNearWords = 0, nearWords = 0;
  const rects = ws ? ws.shown.map((w) => w.rect) : [];
  let smallest = null;
  for (const [id, ext] of extent) {
    const q = dbg.project(id);
    // 点群のシェーダ（DOTS_ONLY）と同じ式: 半径 = min(比 × 1 辺, 上限) × 倍率
    const radius = Math.min(p.dotRadius[0] * q.sizePx, p.dotRadius[1]) * (dotScales ? dotScales[id] : 1);
    const d = 2 * radius;
    maxDiameter = Math.max(maxDiameter, d);
    minDiameter = Math.min(minDiameter, d);
    maxMeasured = Math.max(maxMeasured, ext / scale);
    // 単語の矩形の近く（矩形を CLEAR_MARGIN 広げた範囲）に中心がある点
    if (rects.some((r) => Math.abs(q.clientX - r.x) <= r.width / 2 + CLEAR_MARGIN && Math.abs(q.clientY - r.y) <= r.height / 2 + CLEAR_MARGIN)) {
      nearWords++;
      maxNearWords = Math.max(maxNearWords, d);
    }
    // 吸着の確認に使う、小さく、隣の点から離れた点（上下左右 SNAP + 3 ピクセルに別の点がない）
    if (!smallest || d < smallest.d) {
      const cx = Math.round(q.clientX * scale), cy = Math.round(q.clientY * scale);
      const r = Math.ceil((SNAP + 3) * scale);
      let alone = cx - r >= 0 && cy - r >= 0 && cx + r < W && cy + r < H;
      for (let yy = cy - r; alone && yy <= cy + r; yy++) for (let xx = cx - r; xx <= cx + r; xx++) {
        const v = ids[yy * W + xx];
        if (v >= 0 && v !== id) { alone = false; break; }
      }
      if (alone) smallest = { id, d, x: q.clientX, y: q.clientY };
    }
  }
  const ls = ex.labels.getState();
  const visibleLabels = ls.labels.filter((l) => l.visible);
  const labelRects = [...document.querySelectorAll('.cluster-label:not(.is-hidden)')].map((el) => el.getBoundingClientRect());
  let overlaps = 0;
  if (ws) for (const w of ws.shown) {
    const r = w.rect;
    for (const b of labelRects) {
      if (Math.abs(r.x - (b.left + b.width / 2)) < (r.width + b.width) / 2 && Math.abs(r.y - (b.top + b.height / 2)) < (r.height + b.height) / 2) overlaps++;
    }
  }
  const textPx = ws ? ws.shown.map((w) => w.textPx) : [];
  return {
    dots: { visible: extent.size, nearWords, maxNearWords, maxDiameter, minDiameter: extent.size ? minDiameter : 0, maxMeasured, cap: 2 * p.dotRadius[1] },
    words: { shown: textPx.length, minTextPx: textPx.length ? Math.min(...textPx) : null, maxTextPx: textPx.length ? Math.max(...textPx) : null, readable: textPx.filter((t) => t >= 12 - 1e-6).length },
    labels: { visible: visibleLabels.length, names: visibleLabels.map((l) => l.name), reasons: ls.labels.reduce((m, l) => { if (l.reason) m[l.reason] = (m[l.reason] ?? 0) + 1; return m; }, {}) },
    location: { kind: ls.location.kind, text: ls.location.text, shown: !document.getElementById('cluster-location').hidden },
    overlaps,
    smallest,
  };
}
/* eslint-enable no-undef */

function viewsFor(ds) {
  const { views, info } = computeViews(ds);
  const byName = Object.fromEntries(views.map((v) => [v.name.replace(/^\d-/, ''), v]));
  // 少し外: 縁の視点と同じ向きで、さらに 0.23 離れた位置（クラスタの縁から約 0.35 外）
  const e = byName.edge;
  const out = norm(sub(e.pos, e.look));
  const near = { name: 'near', label: 'クラスタの少し外', pos: add(e.look, mul(out, len(sub(e.pos, e.look)) + 0.23)), look: e.look };
  return { info, list: [
    { name: 'home', label: 'ホーム（全体が見える視点）', home: true },
    near,
    { ...e, name: 'edge' },
    { ...byName.inside, name: 'inside' },
    { ...byName.deep, name: 'deep' },
  ] };
}

async function runDataset(browser, base, id, dir) {
  console.log(`\n[${id}]`);
  const ds = loadDataset(path.join(root, 'public/data', dir));
  const { list } = viewsFor(ds);
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`[error] ${m.text()}`); });
  page.on('pageerror', (e) => consoleErrors.push(`[pageerror] ${e.message}`));
  await page.goto(`${base}?data=${id}`);
  await page.waitForFunction(() => window.__explorer && (window.__explorer.ready || window.__explorer.error), null, { timeout: 120000 });
  const out = {};
  for (const v of list) {
    const spec = v.home ? await page.evaluate(() => window.__explorer.homeView()) : v;
    await setView(page, spec);
    await waitSettled(page);
    await page.mouse.move(2, 2); // ホバーの輪を出さない
    await frames(page, 2);
    await page.screenshot({ path: path.join(outDir, `${id}-${v.name}.png`) });
    const m = await page.evaluate(measure, [SNAP_OFFSET_PX, CLEAR_MARGIN_PX]);
    out[v.name] = m;
    console.log(`  ${v.label}: 丸い点 ${m.dots.visible} 個・直径の最大 ${m.dots.maxDiameter.toFixed(1)}px（実測 ${m.dots.maxMeasured.toFixed(1)}px、上限 ${m.dots.cap}px）`
      + ` / 単語の近くの点 ${m.dots.nearWords} 個・直径の最大 ${m.dots.maxNearWords.toFixed(1)}px`
      + ` / 単語 ${m.words.shown} 語（12px 以上 ${m.words.readable}、文字の高さ ${m.words.minTextPx?.toFixed(1) ?? '-'}〜${m.words.maxTextPx?.toFixed(1) ?? '-'}px）`
      + ` / 目印 ${m.labels.visible} 個 ${JSON.stringify(m.labels.reasons)} / 現在地 ${m.location.shown ? m.location.text : '（なし）'}`);
  }
  // 吸着: 縁の視点で、小さく孤立した点の中心から少しずらした位置にホバーする
  const edge = list.find((v) => v.name === 'edge');
  await setView(page, edge);
  await waitSettled(page);
  const m = await page.evaluate(measure, [SNAP_OFFSET_PX, CLEAR_MARGIN_PX]);
  let snap = null;
  if (m.smallest) {
    const t = m.smallest;
    await page.mouse.move(t.x + SNAP_OFFSET_PX, t.y);
    let hovered = null;
    for (let k = 0; k < 30 && hovered !== t.id; k++) {
      await frames(page, 1);
      hovered = (await page.evaluate(() => window.__explorer.interaction.getState())).hovered;
    }
    snap = { ...t, hovered };
    await page.mouse.move(2, 2);
  }
  out.snap = snap;
  out.boundary = await budgetBoundary(page, edge);
  await page.close();
  return out;
}

const labelInfo = (page) => page.evaluate(() => {
  const l = window.__explorer.labels.getState();
  return { budget: l.budget, proximity: l.proximity, key: l.labels.filter((s) => s.visible).map((s) => s.id).join(',') };
});

/**
 * 目印の数の上限が切り替わる境目（縁の視点から同じ向きに離れていく途中）を探し、その前後でカメラを小さく往復させて、
 * 目印の表示が切り替わり続けないかを数える。
 */
async function budgetBoundary(page, edge) {
  const out = norm(sub(edge.pos, edge.look));
  const r0 = len(sub(edge.pos, edge.look));
  const at = (s) => ({ pos: add(edge.look, mul(out, s)), look: edge.look });
  const go = async (s) => { await setView(page, at(s)); await waitStill(page); await frames(page, 2); return labelInfo(page); };
  // 上限が変わる 2 点を、0.02 刻みで探す
  let prevS = r0, prev = await go(r0), found = null;
  for (let s = r0 + 0.02; s < r0 + 1.0; s += 0.02) {
    const cur = await go(s);
    if (cur.budget !== prev.budget) { found = [prevS, s]; break; }
    prevS = s; prev = cur;
  }
  if (!found) return null;
  // 二分探索で境目を 0.001 まで詰める（近い側から近づける）
  let [lo, hi] = found;
  const loBudget = (await go(lo)).budget;
  while (hi - lo > 0.001) {
    const mid = (lo + hi) / 2;
    await go(lo); // 近い側の状態から動かす
    if ((await go(mid)).budget === loBudget) lo = mid; else hi = mid;
  }
  // 境目をまたいで ±0.002 往復する
  const d = 0.002;
  await go(hi + d);
  let last = (await go(hi + d)).key, toggles = 0;
  const budgets = new Set();
  for (let k = 0; k < 16; k++) {
    const info = await go(k % 2 === 0 ? hi - d : hi + d);
    budgets.add(info.budget);
    if (info.key !== last) toggles++;
    last = info.key;
  }
  return { distance: hi, from: loBudget, toggles, budgets: [...budgets] };
}

async function main() {
  if (!args.includes('--no-build')) {
    console.log('ビルド中…');
    execSync('npm run build', { cwd: root, stdio: 'inherit' });
  }
  fs.mkdirSync(outDir, { recursive: true });
  const { base, stop } = startPreview(root, port);
  let browser;
  const report = {};
  try {
    await waitForServer(base);
    browser = await chromium.launch({ args: CHROMIUM_ARGS });
    report['word2vec-10k'] = await runDataset(browser, base, 'word2vec-10k', 'word2vec-10k');
    report.mnist = await runDataset(browser, base, 'mnist', 'mnist');
  } finally {
    if (browser) await browser.close();
    stop();
  }
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));

  if (!reportOnly) {
    console.log('\n[判定]');
    const w = report['word2vec-10k'];
    for (const name of ['edge', 'near']) {
      const r = w[name];
      const limit = r.words.minTextPx === null ? null : DOT_TO_TEXT_MAX * r.words.minTextPx;
      check(`word2vec ${name}: 丸い点の直径の最大値が、単語の文字の高さの最小値の ${DOT_TO_TEXT_MAX} 倍以下`,
        limit !== null && r.dots.maxDiameter <= limit + 1e-6 && r.dots.maxMeasured <= limit + 1.5,
        `直径の最大 ${r.dots.maxDiameter.toFixed(1)}px（実測 ${r.dots.maxMeasured.toFixed(1)}px）、文字の高さの最小 ${r.words.minTextPx?.toFixed(1) ?? '-'}px`);
    }
    for (const name of ['near', 'edge', 'inside']) {
      const r = w[name];
      check(`word2vec ${name}: 単語の矩形の近くの丸い点は小さい（直径 ${NEAR_WORD_DOT_MAX}px 以下）`, r.dots.maxNearWords <= NEAR_WORD_DOT_MAX + 1e-3,
        `${r.dots.nearWords} 個、直径の最大 ${r.dots.maxNearWords.toFixed(1)}px`);
    }
    check('word2vec inside: 近い点ほど大きい（直径の最大値が最小サイズの 2 倍以上）', w.inside.dots.maxDiameter >= 2 * w.inside.dots.minDiameter,
      `${w.inside.dots.minDiameter.toFixed(1)}〜${w.inside.dots.maxDiameter.toFixed(1)}px`);
    check(`word2vec edge: 読める大きさ（12px 以上）の単語が 15 語以上出ている`, w.edge.words.readable >= 15, `${w.edge.words.readable} 語`);
    for (const id of ['word2vec-10k', 'mnist']) {
      const r = report[id];
      check(`${id} edge: 画面に出る目印の数が ${NEAR_LABEL_LIMIT} 以下で、現在地が出ている`, r.edge.labels.visible <= NEAR_LABEL_LIMIT && r.edge.location.shown,
        `${r.edge.labels.visible} 個（${r.edge.labels.names.join(' / ')}）、現在地 ${r.edge.location.text}`);
      check(`${id} inside・deep: 内部でも、画面に出る目印の数が ${NEAR_LABEL_LIMIT} 以下（内部と外で同じ規則）`, ['inside', 'deep'].every((k) => r[k].labels.visible <= NEAR_LABEL_LIMIT),
        ['inside', 'deep'].map((k) => `${k} ${r[k].labels.visible} 個`).join('、'));
      check(`${id} home: 目印の数が変更前と同じ（${HOME_LABELS_BEFORE[id]} 個）`, r.home.labels.visible === HOME_LABELS_BEFORE[id], `${r.home.labels.visible} 個`);
      check(`${id}: 表示中の目印の矩形と単語の矩形が重ならない（全視点）`, ['home', 'near', 'edge', 'inside', 'deep'].every((k) => r[k].overlaps === 0),
        ['home', 'near', 'edge', 'inside', 'deep'].map((k) => r[k].overlaps).join(','));
      check(`${id}: 目印の数の上限の境目（クラスタの中心から ${r.boundary?.distance.toFixed(3) ?? '-'}）で、カメラを小さく往復させても目印の表示が切り替わり続けない`,
        r.boundary && r.boundary.toggles === 0, JSON.stringify(r.boundary));
      check(`${id} edge: 小さな点（直径 ${r.snap?.d.toFixed(1) ?? '-'}px）でも、中心から ${SNAP_OFFSET_PX}px ずらしたホバーで選ばれる（吸着）`,
        r.snap && r.snap.hovered === r.snap.id, JSON.stringify(r.snap));
    }
  }
  const failed = results.filter((r) => !r.ok);
  console.log(consoleErrors.length ? `\nコンソールエラー ${consoleErrors.length} 件:\n${consoleErrors.join('\n')}` : '\nコンソールエラー: なし');
  if (!reportOnly) console.log(`結果: ${results.length - failed.length} / ${results.length} 合格${failed.length ? `（失敗: ${failed.map((f) => f.name).join(' / ')}）` : ''}`);
  process.exitCode = failed.length || consoleErrors.length ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exit(1); });
