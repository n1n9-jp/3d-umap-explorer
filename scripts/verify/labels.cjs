#!/usr/bin/env node
/**
 * クラスタの目印と現在地（src/labels/）の検証。
 * ビルドしてプレビューサーバーを起動し、ヘッドレス Chromium へ実際のマウス・キーの入力を送る。
 *
 *   node scripts/verify/labels.cjs [--no-build] [--port 4330] [--out artifacts/labels]
 *
 * 確かめること:
 *   - 全体が見える視点で、粗い階層の 10 個の目印がすべて表示され、画面上の位置がクラスタの中心の投影と一致する
 *     （投影はこのスクリプトが、カメラの位置・向き・視野角から独立に計算する）。名前が manifest と一致する。要素の見た目の中心も一致する
 *   - 近い目印ほど大きく濃く、遠い目印ほど小さく薄い（距離に単調）
 *   - カメラの後ろのクラスタの目印が表示されない。画面の外へ投影されるクラスタの目印も表示されない
 *   - 重なる目印は、近いほうだけが残る（画面上で重なる目印がない）
 *   - クラスタの内部（中心から radius 以内）へ移動すると、そのクラスタの目印が消え、現在地の表示がそのクラスタの名前になる。外へ出ると戻る
 *   - どのクラスタの内部でもないときは、最寄りのクラスタの名前と方向が出る
 *   - 目印をクリックすると、そのクラスタの手前へ移動し、移動後にそのクラスタの点の大半が画面内に入る。クリックで点の選択が変わらない。
 *     俯瞰モードからは飛行モードへ切り替えて移動する
 *   - 目印をキーボード（Tab でフォーカス・Enter）で実行できる
 *   - L キーで目印と現在地が消え、もう一度押すと戻る。HUD の操作説明に L キーがある
 *   - 画面の大きさを変えても、目印の位置が合っている（横長・縦長）
 *   - クラスタのないデータセットでは、機能が無効になり、エラーにならない
 *   - コンソールエラーがない
 * ソフトウェア描画では 1 フレームが約 200 ミリ秒かかるので、待ちはフレーム数と状態の変化で数える。
 * 失敗があれば終了コード 1 で終わる。スクリーンショットを --out に保存する。
 */
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { loadDataset, waitForServer, startPreview, CHROMIUM_ARGS, sub, add, mul, len, norm } = require('./lib.cjs');

const root = path.resolve(__dirname, '../..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const outDir = path.resolve(root, opt('out', 'artifacts/labels'));
const port = Number(opt('port', '4330'));
const dataPath = 'data/mnist/';
const FOV = 60; // src/main.ts の PerspectiveCamera の縦の視野角
const LABEL_PX_TOLERANCE = 1.0; // 投影位置の許容誤差（CSS ピクセル）

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const consoleErrors = [];
async function openPage(browser, base, { width, height, query = `data=${dataPath}` } = {}) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`[error] ${m.text()}`); });
  page.on('pageerror', (e) => consoleErrors.push(`[pageerror] ${e.message}`));
  page.on('requestfailed', (r) => consoleErrors.push(`[requestfailed] ${r.url()}`));
  await page.goto(`${base}?${query}`);
  await page.waitForFunction(() => window.__explorer && (window.__explorer.ready || window.__explorer.error), null, { timeout: 60000 });
  const err = await page.evaluate(() => window.__explorer.error);
  if (err) throw new Error(`アプリの起動に失敗: ${err}`);
  return page;
}

const state = (page) => page.evaluate(() => window.__explorer.getState());
const labelState = (page) => page.evaluate(() => window.__explorer.labels.getState());
const ix = (page) => page.evaluate(() => window.__explorer.interaction.getState());
const frames = (page, n) => page.evaluate((k) => window.__explorer.measureFrames(k), n);
const setView = (page, pos, look) => page.evaluate((v) => window.__explorer.setView(v), { pos, look });

/** 視点を設定し、描画ループが目印を更新するまで待つ（カメラが止まるまで）。 */
async function goTo(page, pos, look) {
  await setView(page, pos, look);
  return settle(page);
}

/** カメラが動かなくなり、目印がそのカメラで更新されるまで待つ。 */
async function settle(page, maxFrames = 60) {
  let prev = await state(page);
  for (let k = 0; k < maxFrames; k++) {
    await frames(page, 2);
    const s = await state(page);
    if (len(sub(s.position, prev.position)) < 1e-9 && len(sub(s.direction, prev.direction)) < 1e-9) return s;
    prev = s;
  }
  return prev;
}

async function waitFor(page, fn, maxFrames = 40) {
  let v;
  for (let k = 0; k <= maxFrames; k++) {
    v = await fn(page);
    if (v && v.ok) return { ...v, frames: k };
    await frames(page, 1);
  }
  return { ...v, frames: maxFrames, ok: false };
}

/** カメラの位置・向き・視野角から、世界の点の画面位置（CSS ピクセル）を独立に求める。奥行きが正でなければ null。 */
function projectIndependent(s, p, width, height) {
  const f = norm(s.direction);
  const right = norm([-f[2], 0, f[0]]); // cross(f, +Y)
  const up = [right[1] * f[2] - right[2] * f[1], right[2] * f[0] - right[0] * f[2], right[0] * f[1] - right[1] * f[0]]; // cross(right, f)
  const d = sub(p, s.position);
  const z = d[0] * f[0] + d[1] * f[1] + d[2] * f[2];
  if (z <= 0) return null;
  const x = d[0] * right[0] + d[1] * right[1] + d[2] * right[2];
  const y = d[0] * up[0] + d[1] * up[1] + d[2] * up[2];
  const t = Math.tan((FOV * Math.PI) / 360);
  const ndcX = x / (z * t * (width / height));
  const ndcY = y / (z * t);
  return { x: (ndcX * 0.5 + 0.5) * width, y: (0.5 - ndcY * 0.5) * height, depth: z };
}

/** 要素の見た目の中心（CSS ピクセル）。 */
const elementCenter = (page, id) => page.evaluate((i) => {
  const el = document.querySelector(`.cluster-label[data-cluster-id="${i}"]`);
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, hidden: getComputedStyle(el).visibility === 'hidden', opacity: Number(getComputedStyle(el).opacity) };
}, id);

const locationText = (page) => page.evaluate(() => {
  const el = document.getElementById('cluster-location');
  return { hidden: el.hidden || getComputedStyle(el).display === 'none', text: el.innerText.trim() };
});

/** 全体が見える視点（ホーム）の少し斜めから。10 個の目印が見える。 */
async function overviewView(page) {
  return page.evaluate(() => window.__explorer.homeView());
}

function rectsOverlapAny(items) {
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      if (Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < (a.h + b.h) / 2) return [a.id, b.id];
    }
  }
  return null;
}

// ---------- 検証本体 ----------

async function testOverview(page, ds, clusters, size) {
  console.log('\n[全体が見える視点]');
  const home = await overviewView(page);
  const s = await goTo(page, home.pos, home.look);
  const st = await labelState(page);
  check('目印の機能が有効', st.available && st.enabled, `available ${st.available}、enabled ${st.enabled}`);
  check('粗い階層のクラスタ数と目印の数が一致する', st.labels.length === clusters.length, `${st.labels.length} 個`);
  const shown = st.labels.filter((l) => l.visible);
  check('10 個の目印がすべて表示されている', shown.length === 10, `表示 ${shown.length} 個、隠れている: ${JSON.stringify(st.labels.filter((l) => !l.visible).map((l) => [l.id, l.reason]))}`);

  let worst = 0, worstId = -1, nameOk = true;
  for (const l of st.labels) {
    const c = clusters[l.id];
    if (l.name !== c.name) nameOk = false;
    const p = projectIndependent(s, c.center, size.width, size.height);
    if (!p || l.x === null) { worst = Infinity; worstId = l.id; continue; }
    const e = Math.hypot(p.x - l.x, p.y - l.y);
    if (e > worst) { worst = e; worstId = l.id; }
  }
  check('名前が manifest のクラスタ名と一致する', nameOk, st.labels.map((l) => l.name).join(','));
  check(`報告された画面上の位置が、独立に投影したクラスタ中心と ${LABEL_PX_TOLERANCE}px 以内で一致する`, worst <= LABEL_PX_TOLERANCE, `最大誤差 ${worst.toFixed(3)}px（クラスタ ${worstId}）`);

  // 要素の見た目（DOM）が報告と一致する
  let domWorst = 0, textOk = true;
  const rects = [];
  for (const l of shown) {
    const r = await elementCenter(page, l.id);
    domWorst = Math.max(domWorst, Math.hypot(r.x - l.x, r.y - l.y));
    if (r.hidden) textOk = false;
    rects.push({ id: l.id, x: r.x, y: r.y, w: r.w, h: r.h, opacity: r.opacity });
  }
  const names = await page.evaluate(() => [...document.querySelectorAll('.cluster-label')].map((e) => [Number(e.dataset.clusterId), e.innerText.trim(), getComputedStyle(e).visibility]));
  check('要素の見た目の中心が、報告された位置と 1px 以内で一致する', domWorst <= 1.0, `最大 ${domWorst.toFixed(3)}px`);
  check('表示中の要素に、クラスタ名の文字が出ている', textOk && names.every(([id, t]) => t === clusters[id].name), JSON.stringify(names));
  check('表示中の目印が、画面の端で切れていない（要素の矩形が画面に収まる）', await page.evaluate(() => [...document.querySelectorAll('.cluster-label')].filter((e) => getComputedStyle(e).visibility !== 'hidden').every((e) => { const r = e.getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; })));
  check('表示中の目印が画面上で重なっていない', rectsOverlapAny(rects) === null, JSON.stringify(rectsOverlapAny(rects)));

  // 距離に応じた見せ方: 近いほど大きく濃い
  const byDist = [...shown].sort((a, b) => a.distance - b.distance);
  let mono = true;
  for (let i = 1; i < byDist.length; i++) if (byDist[i].scale > byDist[i - 1].scale + 1e-9 || byDist[i].opacity > byDist[i - 1].opacity + 1e-9) mono = false;
  const nearL = byDist[0], farL = byDist[byDist.length - 1];
  check('近い目印ほど大きく濃い（距離に対して単調）', mono && nearL.scale > farL.scale && nearL.opacity > farL.opacity,
    `最近 ${nearL.distance.toFixed(2)}: 倍率 ${nearL.scale.toFixed(3)}・濃さ ${nearL.opacity.toFixed(3)} / 最遠 ${farL.distance.toFixed(2)}: ${farL.scale.toFixed(3)}・${farL.opacity.toFixed(3)}`);
  const farRect = rects.find((r) => r.id === farL.id), nearRect = rects.find((r) => r.id === nearL.id);
  check('見た目の大きさと不透明度も、遠いほうが小さく薄い', farRect.w < nearRect.w && farRect.opacity < nearRect.opacity,
    `近い ${nearRect.w.toFixed(1)}px・${nearRect.opacity.toFixed(2)} / 遠い ${farRect.w.toFixed(1)}px・${farRect.opacity.toFixed(2)}`);

  const loc = await locationText(page);
  const ls = st.location;
  check('全体が見える視点では、どのクラスタの内部でもなく「最寄り: …」と方向が出る', ls.kind === 'nearest' && /^最寄り: .+ のクラスタ/.test(loc.text) && ls.direction && loc.text.includes(ls.direction.word),
    `${JSON.stringify(loc.text)}`);
  await page.screenshot({ path: path.join(outDir, '1-overview.png') });
  console.log(`  全体が見える視点 → ${path.relative(root, path.join(outDir, '1-overview.png'))}`);
}

async function testBehindAndOffscreen(page, clusters, size) {
  console.log('\n[後ろ・画面の外]');
  // クラスタ 0 の中心の真後ろ側へ向く: 中心から離れた位置で、中心と反対向きを見る
  const c0 = clusters[0].center;
  const away = norm(c0);
  const pos = mul(away, 2.0); // 点群の外
  const look = add(pos, away); // 外向き（クラスタ 0 は背後）
  const s = await goTo(page, pos, look);
  const st = await labelState(page);
  const checks = st.labels.map((l) => ({ l, p: projectIndependent(s, clusters[l.id].center, size.width, size.height) }));
  const behind = checks.filter((x) => x.p === null);
  check('後ろ向きの視点で、カメラの後ろにあるクラスタがある', behind.length > 0, `${behind.length} 個`);
  check('カメラの後ろのクラスタの目印は表示されない（理由 behind）', behind.every((x) => !x.l.visible && x.l.reason === 'behind'), JSON.stringify(behind.map((x) => [x.l.id, x.l.visible, x.l.reason])));
  const domHidden = await page.evaluate((ids) => ids.map((i) => getComputedStyle(document.querySelector(`.cluster-label[data-cluster-id="${i}"]`)).visibility), behind.map((x) => x.l.id));
  check('後ろのクラスタの要素は見えない（visibility: hidden）', domHidden.every((v) => v === 'hidden'), JSON.stringify(domHidden));

  // 画面の外: カメラの前方にあるが、投影が画面の外になるクラスタ（視線を横へ振って探す）
  const looks = [[1.6, 0, 1.2], [-1.6, 0, 1.2], [0, 1.6, 1.2], [0, -1.6, 1.2], [3, 0, 2.2]];
  let found = null;
  for (const look of looks) {
    const s2 = await goTo(page, [0, 0, 2.2], look);
    const st2 = await labelState(page);
    const off = st2.labels.filter((l) => {
      const p = projectIndependent(s2, clusters[l.id].center, size.width, size.height);
      return p && (p.x < 0 || p.x > size.width || p.y < 0 || p.y > size.height);
    });
    if (off.length > 0) { found = { look, off }; break; }
  }
  check('前方にあって画面の外へ投影されるクラスタがある視点が見つかる', found !== null, found ? `視線 ${JSON.stringify(found.look)}、${found.off.length} 個` : '');
  if (found) {
    check('画面の外へ投影されるクラスタの目印は表示されない（理由 offscreen）', found.off.every((l) => !l.visible && l.reason === 'offscreen'), JSON.stringify(found.off.map((l) => [l.id, l.visible, l.reason])));
  }
}

async function testInside(page, clusters, size) {
  console.log('\n[クラスタの内部と現在地]');
  // 十分に離れた 3 つのクラスタで試す: 中心の少し手前（radius の 0.3 倍）
  for (const id of [2, 4, 7]) {
    const c = clusters[id];
    const out = norm(c.center);
    const outside = add(c.center, mul(out, c.radius * 1.5 + 0.3)); // クラスタの外側（ほかの球にも入らない位置ではない場合は最寄りの判定に依る）
    const inside = add(c.center, mul(out, c.radius * 0.3));
    // 内部へ: 中心を見る
    await goTo(page, inside, c.center);
    const st = await labelState(page);
    const l = st.labels.find((x) => x.id === id);
    check(`クラスタ ${id}（${c.name}）の内部: そのクラスタの目印が消える（理由 inside）`, !l.visible && l.reason === 'inside', `visible ${l.visible}、reason ${l.reason}`);
    check(`クラスタ ${id}（${c.name}）の内部: 現在地の表示がそのクラスタの名前になる`, st.location.kind === 'inside' && st.location.clusterId === id && st.location.name === c.name, JSON.stringify(st.location));
    const loc = await locationText(page);
    check(`クラスタ ${id}（${c.name}）の内部: 画面に「現在地: ${c.name} のクラスタ」が出る`, !loc.hidden && loc.text === `現在地: ${c.name} のクラスタ`, JSON.stringify(loc));
    const domVis = await elementCenter(page, id);
    check(`クラスタ ${id}（${c.name}）の内部: 目印の要素も見えない`, domVis.hidden);
    // 外へ: 同じ向きで中心から離れる（ほかのクラスタの内部になることもあるので、そのクラスタの外であることだけを見る）
    const s = await goTo(page, outside, c.center);
    const st2 = await labelState(page);
    const l2 = st2.labels.find((x) => x.id === id);
    const dist = len(sub(s.position, c.center));
    check(`クラスタ ${id}（${c.name}）の外（中心から ${dist.toFixed(2)} > radius ${c.radius.toFixed(2)}）: 目印が戻る`, dist > c.radius && l2.visible, `visible ${l2.visible}、reason ${l2.reason}`);
    check(`クラスタ ${id}（${c.name}）の外: 現在地の表示がそのクラスタではなくなる`, !(st2.location.kind === 'inside' && st2.location.clusterId === id), JSON.stringify(st2.location));
  }
  // 点群の外（どのクラスタの内部でもない）: 最寄りの名前と方向
  const s = await goTo(page, [0, 0, 2.2], [0, 0, 0]);
  const st = await labelState(page);
  const loc = await locationText(page);
  const nearest = [...clusters].map((c) => ({ c, d: len(sub(s.position, c.center)) - c.radius })).sort((a, b) => a.d - b.d)[0];
  check('点群の外: 最寄りのクラスタ（縁までの距離が最小）の名前と方向が出る',
    st.location.kind === 'nearest' && st.location.clusterId === nearest.c.id && loc.text.startsWith(`最寄り: ${nearest.c.name} のクラスタ`) && /[→↗↑↖←↙↓↘◎↩]/.test(loc.text),
    `${JSON.stringify(loc.text)}（期待 クラスタ ${nearest.c.id}）`);
}

async function testClickToFly(page, ds, clusters, coarse, size) {
  console.log('\n[目印のクリックで飛ぶ]');
  const home = await overviewView(page);
  await goTo(page, home.pos, home.look);
  // 画面中央付近・手前の、重ならない目印を選ぶ（クリックを受け取れる位置）
  const st0 = await labelState(page);
  const target = st0.labels.filter((l) => l.visible).sort((a, b) => a.distance - b.distance)[2];
  const c = clusters[target.id];
  // 点の選択をあらかじめ作っておき、目印のクリックで変わらないことを見る
  const emptySel = await ix(page);
  const s0 = await state(page);
  const el = page.locator(`.cluster-label[data-cluster-id="${target.id}"]`);
  await el.click();
  // 移動が始まるのを待ってから、止まるまで待つ
  await waitFor(page, async (pg) => ({ ok: len(sub((await state(pg)).position, s0.position)) > 1e-6 }), 10);
  const s = await settle(page, 80);
  const dist = len(sub(s.position, c.center));
  const expected = await page.evaluate((r) => {
    const cam = { fov: 60, aspect: window.innerWidth / window.innerHeight };
    const v = (cam.fov * Math.PI) / 360, h = Math.atan(Math.tan(v) * cam.aspect);
    return 1.15 * r / Math.sin(Math.min(v, h));
  }, c.radius);
  check(`目印（クラスタ ${target.id}: ${c.name}）をクリックすると、そのクラスタの手前へ移動する`, Math.abs(dist - expected) < 1e-3, `中心までの距離 ${dist.toFixed(4)}、期待 ${expected.toFixed(4)}`);
  // クラスタ全体が視野に収まるか: そのクラスタの点のうち画面内にあるものの割合
  let total = 0, inView = 0;
  for (let i = 0; i < ds.count; i++) {
    if (coarse[i] !== target.id) continue;
    total++;
    const p = projectIndependent(s, [ds.positions[3 * i], ds.positions[3 * i + 1], ds.positions[3 * i + 2]], size.width, size.height);
    if (p && p.x >= 0 && p.x <= size.width && p.y >= 0 && p.y <= size.height) inView++;
  }
  check('移動後、そのクラスタの点の大半（95% 以上）が画面内に入っている', total > 0 && inView / total >= 0.95, `${inView}/${total} = ${((100 * inView) / total).toFixed(1)}%`);
  const centerPx = projectIndependent(s, c.center, size.width, size.height);
  check('クラスタの中心が画面の中央に見える', Math.hypot(centerPx.x - size.width / 2, centerPx.y - size.height / 2) < 3, `(${centerPx.x.toFixed(1)}, ${centerPx.y.toFixed(1)})`);
  const sel = await ix(page);
  check('目印のクリックで、点の選択は変わらない', sel.selected === emptySel.selected, `選択 ${sel.selected}`);
  check('飛んだ先でも飛行モードのまま', s.mode === 'fly');
  await page.screenshot({ path: path.join(outDir, '2-after-click.png') });
  console.log(`  目印をクリックして飛んだあと → ${path.relative(root, path.join(outDir, '2-after-click.png'))}`);

  // 点を選択している状態で目印をクリックしても、選択は変わらない（クラスタ 6 の縁から見る。点が大きく見える）
  const c6 = clusters[6];
  await goTo(page, add(c6.center, mul(norm(c6.center), c6.radius + 0.12)), c6.center);
  const pt = await page.evaluate(async () => {
    const ex = window.__explorer;
    for (let i = 0; i < ex.picking.count; i += 7) {
      const p = ex.picking.project(i);
      if (p.depth <= 0 || p.faded || p.sizePx < 4) continue;
      const x = Math.round(p.clientX), y = Math.round(p.clientY);
      if (x < 60 || y < 260 || x > innerWidth - 60 || y > innerHeight - 220) continue;
      if (p.sizePx < 6) continue;
      if (document.elementsFromPoint(x, y).some((e) => e.classList.contains('cluster-label'))) continue;
      const r = await ex.pick(x, y);
      if (r && r.index === i && r.pixelDistance === 0) return { i, x, y };
    }
    return null;
  });
  if (pt) {
    await page.mouse.click(pt.x, pt.y);
    await waitFor(page, async (pg) => ({ ok: (await ix(pg)).selected === pt.i }), 20);
    const before = await ix(page);
    const st = await labelState(page);
    const l = st.labels.filter((x) => x.visible).sort((a, b) => b.distance - a.distance)[0];
    check('選択の検証の前提: 縁の視点で目印が見えている', !!l);
    await page.locator(`.cluster-label[data-cluster-id="${l.id}"]`).click();
    await frames(page, 3);
    const after = await ix(page);
    check('点を選択している状態で目印をクリックしても、選択は変わらない（解除もされない）', before.selected === pt.i && after.selected === pt.i, `前 ${before.selected}、後 ${after.selected}`);
    await settle(page, 80);
  } else {
    check('選択の検証に使う点が見つかる', false);
  }

  // 目印の上で押して、外へドラッグしても、視点は回らず選択も変わらない（目印の上の操作はカメラ・ピッキングに届かない）
  await goTo(page, home.pos, home.look);
  const stD = await labelState(page);
  const lD = stD.labels.filter((x) => x.visible)[0];
  const dBefore = await state(page);
  const selBefore = await ix(page);
  await page.mouse.move(lD.x, lD.y);
  await page.mouse.down();
  await page.mouse.move(lD.x + 120, lD.y + 90, { steps: 6 });
  await page.mouse.up();
  await frames(page, 3);
  const dAfter = await state(page);
  const selAfter = await ix(page);
  check('目印の上で押して外へドラッグしても、視点は回らず、点の選択も変わらず、飛びもしない',
    len(sub(dAfter.direction, dBefore.direction)) < 1e-9 && len(sub(dAfter.position, dBefore.position)) < 1e-9 && selAfter.selected === selBefore.selected,
    `向きの変化 ${len(sub(dAfter.direction, dBefore.direction)).toExponential(2)}、選択 ${selAfter.selected}`);

  // 俯瞰モード: 飛行モードへ切り替えてから移動する
  console.log('\n[俯瞰モードでの目印のクリック]');
  await goTo(page, home.pos, home.look);
  await page.keyboard.press('KeyO');
  await page.waitForFunction(() => window.__explorer.getState().mode === 'overview');
  await frames(page, 3);
  const so = await state(page);
  const stO = await labelState(page);
  const tO = stO.labels.filter((l) => l.visible).sort((a, b) => a.distance - b.distance)[1];
  check('俯瞰モードでも目印が出ている', stO.labels.filter((l) => l.visible).length >= 8, `${stO.labels.filter((l) => l.visible).length} 個`);
  await page.locator(`.cluster-label[data-cluster-id="${tO.id}"]`).click();
  const mode = await waitFor(page, async (pg) => ({ ok: (await state(pg)).mode === 'fly' }), 10);
  const s2 = await settle(page, 80);
  const d2 = len(sub(s2.position, clusters[tO.id].center));
  check('俯瞰モードで目印をクリックすると、飛行モードへ切り替わって移動する', mode.ok && s2.mode === 'fly' && len(sub(s2.position, so.position)) > 0.05, `mode ${s2.mode}、移動 ${len(sub(s2.position, so.position)).toFixed(3)}`);
  check('俯瞰モードからの移動先も、クラスタの手前の距離', Math.abs(d2 - 1.15 * clusters[tO.id].radius / Math.sin(Math.PI / 6)) < 1e-3, `距離 ${d2.toFixed(4)}`);
}

async function testKeyboard(page, clusters) {
  console.log('\n[キーボードで目印を実行]');
  const home = await overviewView(page);
  await goTo(page, home.pos, home.look);
  const st = await labelState(page);
  const visibleIds = st.labels.filter((l) => l.visible).map((l) => l.id).sort((a, b) => a - b);
  // Tab でフォーカスを送る: 最初の目印にフォーカスが当たるまで
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  let focused = null;
  for (let k = 0; k < 14 && focused === null; k++) {
    await page.keyboard.press('Tab');
    focused = await page.evaluate(() => (document.activeElement && document.activeElement.classList.contains('cluster-label') ? Number(document.activeElement.dataset.clusterId) : null));
  }
  check('Tab で目印にフォーカスできる（表示中の目印のみ。隠れた目印には当たらない）', focused !== null && visibleIds.includes(focused), `フォーカス ${focused}`);
  const label = await page.evaluate(() => document.activeElement.getAttribute('aria-label'));
  check('目印に、クラスタ名を含む読み上げ名がある', focused !== null && label === `${clusters[focused].name} のクラスタへ移動`, JSON.stringify(label));
  const outline = await page.evaluate(() => { const s = getComputedStyle(document.activeElement); return { style: s.outlineStyle, width: s.outlineWidth }; });
  check('フォーカス中の目印に、見えるフォーカスの輪が出る', outline.style !== 'none' && parseFloat(outline.width) >= 2, JSON.stringify(outline));
  // Tab で動く間にホーム視点のままか確認 → Enter で飛ぶ
  const s0 = await state(page);
  await page.keyboard.press('Enter');
  await waitFor(page, async (pg) => ({ ok: len(sub((await state(pg)).position, s0.position)) > 1e-6 }), 10);
  const s = await settle(page, 80);
  const d = len(sub(s.position, clusters[focused].center));
  check('Enter で、そのクラスタの手前へ移動する', Math.abs(d - 1.15 * clusters[focused].radius / Math.sin(Math.PI / 6)) < 1e-3, `距離 ${d.toFixed(4)}`);
  // フォーカスが目印にあっても、L・O などのショートカットが働く
  await page.evaluate(() => document.querySelector('.cluster-label:not(.is-hidden)')?.focus());
  await page.keyboard.press('KeyL');
  await frames(page, 3);
  const off = await labelState(page);
  check('目印にフォーカスがあっても L キーが働く', off.enabled === false);
  await page.keyboard.press('KeyL');
  await frames(page, 3);
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
}

async function testToggle(page) {
  console.log('\n[L キーで表示・非表示]');
  const home = await overviewView(page);
  await goTo(page, home.pos, home.look);
  const on = await labelState(page);
  const locOn = await locationText(page);
  check('既定は表示', on.enabled && on.labels.filter((l) => l.visible).length === 10 && !locOn.hidden);
  const hud = await page.evaluate(() => document.getElementById('hud').innerText.split('\n'));
  check('HUD の操作説明に L キーがある', hud[2].includes('L 目印の表示'), JSON.stringify(hud[2]));
  check('HUD の最終行は視点のまま', hud[hud.length - 1].startsWith('?pos='), JSON.stringify(hud[hud.length - 1]));
  await page.keyboard.press('KeyL');
  await frames(page, 3);
  const off = await labelState(page);
  const vis = await page.evaluate(() => [...document.querySelectorAll('.cluster-label')].filter((e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden').length);
  const locOff = await locationText(page);
  check('L キーで目印がすべて消える（状態・要素とも）', !off.enabled && off.labels.every((l) => !l.visible && l.reason === 'disabled') && vis === 0, `表示中の要素 ${vis}`);
  check('L キーで現在地の表示も消える', locOff.hidden);
  await page.screenshot({ path: path.join(outDir, '5-hidden.png') });
  await page.keyboard.press('KeyL');
  await frames(page, 3);
  const back = await labelState(page);
  const locBack = await locationText(page);
  check('もう一度 L キーを押すと目印が戻る', back.enabled && back.labels.filter((l) => l.visible).length === 10 && !locBack.hidden);
  // 修飾キーつき・押しっぱなしの繰り返しでは切り替わらない
  await page.keyboard.press('Control+KeyL');
  await frames(page, 2);
  check('Ctrl+L では切り替わらない', (await labelState(page)).enabled);
}

async function testResize(browser, base, clusters) {
  console.log('\n[画面の大きさを変える]');
  const page = await openPage(browser, base, { width: 1280, height: 800 });
  await frames(page, 3);
  for (const [w, h] of [[1280, 800], [900, 900], [600, 900], [1600, 700], [1280, 800]]) {
    await page.setViewportSize({ width: w, height: h });
    await frames(page, 3);
    const home = await page.evaluate(() => window.__explorer.homeView());
    const s = await goTo(page, home.pos, home.look);
    const st = await labelState(page);
    let worst = 0, n = 0;
    for (const l of st.labels) {
      if (!l.visible) continue;
      const p = projectIndependent(s, clusters[l.id].center, w, h);
      worst = Math.max(worst, Math.hypot(p.x - l.x, p.y - l.y));
      const r = await elementCenter(page, l.id);
      worst = Math.max(worst, Math.hypot(r.x - p.x, r.y - p.y));
      n++;
    }
    check(`${w}x${h}: ${n} 個の目印の位置（報告と要素の見た目）が独立の投影と一致する`, n > 0 && worst <= LABEL_PX_TOLERANCE + 0.5, `最大誤差 ${worst.toFixed(3)}px`);
    if (w === 600) await page.screenshot({ path: path.join(outDir, '6-portrait.png') });
  }
  await page.close();
}

async function testNoClusters(browser, base) {
  console.log('\n[クラスタのないデータセット]');
  // manifest から clusters を取り除いたデータセットを dist/data/ に作る（public/ は変えない）
  const src = path.join(root, 'dist', dataPath);
  const dstRel = 'data/mnist-noclusters/';
  const dst = path.join(root, 'dist', dstRel);
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(dst, f));
  const man = JSON.parse(fs.readFileSync(path.join(dst, 'manifest.json'), 'utf8'));
  delete man.clusters;
  fs.writeFileSync(path.join(dst, 'manifest.json'), JSON.stringify(man));
  try {
    const page = await openPage(browser, base, { width: 1000, height: 700, query: `data=${dstRel}` });
    await frames(page, 4);
    const st = await labelState(page);
    check('clusters がない manifest でも起動する', true);
    check('機能が無効（available: false、目印なし）', st.available === false && st.labels.length === 0 && st.enabled === false, JSON.stringify({ available: st.available, enabled: st.enabled, n: st.labels.length }));
    const dom = await page.evaluate(() => ({
      chips: document.querySelectorAll('.cluster-label').length,
      containerHidden: document.getElementById('cluster-labels').hidden,
      locationHidden: document.getElementById('cluster-location').hidden,
      hud: document.getElementById('hud').innerText.split('\n')[2],
    }));
    check('目印の要素も現在地の表示も出ない。HUD に L キーの説明もない', dom.chips === 0 && dom.containerHidden && dom.locationHidden && !dom.hud.includes('L 目印'), JSON.stringify(dom));
    await page.keyboard.press('KeyL');
    await frames(page, 2);
    check('L キーを押してもエラーにならず、無効のまま', (await labelState(page)).enabled === false);
    await page.close();
  } finally {
    fs.rmSync(dst, { recursive: true, force: true });
  }
}

async function takeShots(page, ds, clusters) {
  console.log('\n[スクリーンショット（縁・内部）]');
  // クラスタ 6（数字 8、中心付近が密）で撮る
  const id = 6, c = clusters[id];
  const out = norm(c.center);
  const edgePos = add(c.center, mul(out, c.radius + 0.12));
  await goTo(page, edgePos, c.center);
  await page.screenshot({ path: path.join(outDir, '3-edge.png') });
  const insidePos = add(c.center, mul(out, c.radius * 0.4));
  await goTo(page, insidePos, c.center);
  await page.screenshot({ path: path.join(outDir, '4-inside.png') });
  console.log('  縁 → artifacts/labels/3-edge.png / 内部 → artifacts/labels/4-inside.png');
}

async function main() {
  const dataDir = path.join(root, 'public', dataPath);
  const ds = loadDataset(dataDir);
  const level = ds.manifest.clusters.levels[0];
  const clusters = level.clusters;
  const cb = fs.readFileSync(path.join(dataDir, level.pointFile));
  const coarse = new Uint16Array(cb.buffer.slice(cb.byteOffset, cb.byteOffset + cb.byteLength));

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
    const size = { width: 1280, height: 800 };
    const page = await openPage(browser, base, size);
    await frames(page, 3);

    await testOverview(page, ds, clusters, size);
    await testBehindAndOffscreen(page, clusters, size);
    await testInside(page, clusters, size);
    await testToggle(page);
    await testKeyboard(page, clusters);
    await testClickToFly(page, ds, clusters, coarse, size);
    await takeShots(page, ds, clusters);
    await page.close();
    await testResize(browser, base, clusters);
    await testNoClusters(browser, base);

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
