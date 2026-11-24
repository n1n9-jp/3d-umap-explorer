#!/usr/bin/env node
/**
 * クラスタの目印と現在地（src/labels/）の検証。
 * ビルドしてプレビューサーバーを起動し、ヘッドレス Chromium へ実際のマウス・キーの入力を送る。
 *
 *   node scripts/verify/labels.cjs [--no-build] [--port 4330] [--out artifacts/labels] [--only pointer,stability,...]
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
 *   - 目印の上でも、ホイールとドラッグが目印のない場所と同じように働く: ホイールで飛行速度（俯瞰モードでは距離）が変わる。
 *     Ctrl＋ホイールはページのズームにならない（既定の動作を止める）。目印の上から始めたドラッグで視点が回り、
 *     目印のクリックとしては扱われない（回る量は目印のない場所のドラッグと同じ）。そのあとの動かさないクリックでは飛ぶ
 *   - カメラを小さく往復させても、重なり・画面の端の境目で目印の表示と非表示が切り替わり続けない
 *   - クラスタの球の表面の付近で、カメラの位置を小さく往復させても（内から・外から）、向きを小さく往復させても、
 *     目印の表示・非表示と現在地の表示（「現在地」と「最寄り」）が切り替わり続けない（入る距離と出る距離に幅がある）。
 *     球が重なる場所で、現在地のクラスタが入れ替わり続けない
 *   - 境界をゆっくり内から外へ、外から内へまたぐとき、1 フレームで現れる・消える目印の数が上限（MAX_LABEL_CHANGE_PER_FRAME）以下。
 *     内部と外が同じ規則で目印の数を決めるので、境界で目印が一度に多数現れたり消えたりしない
 *   - 画面の端では、目印の矩形が画面に収まるものだけが出る（中心が画面内でも、矩形がはみ出すものは出ない）
 *   - キーボードでフォーカスした目印が出なくなるときは、フォーカスが次に出ている目印へ移る（body へ落ちない）。
 *     フォーカス中の目印は、ほかの目印との重なりでは隠れない
 *   - 現在地の表示に距離の数値が出ない。移動で文面が変わらない間は、要素を書き換えない（DOM の変更が 0 件）
 *   - 幅の狭い画面で、HUD の操作説明が項目の切れ目で折り返し、画面からはみ出さない
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
const {
  loadDataset, waitForServer, startPreview, CHROMIUM_ARGS, sub, add, mul, len, norm, waitReorient, waitCameraIdle,
} = require('./lib.cjs');

const root = path.resolve(__dirname, '../..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const outDir = path.resolve(root, opt('out', 'artifacts/labels'));
const port = Number(opt('port', '4330'));
const dataPath = 'data/mnist/';
const FOV = 60; // src/main.ts の PerspectiveCamera の縦の視野角
const LABEL_PX_TOLERANCE = 1.0; // 投影位置の許容誤差（CSS ピクセル）
/** 境界をゆっくりまたぐとき、1 フレームで現れる・消える目印の数の上限（src/labels/ClusterLabels.ts の内部と外で同じ上限の規則。自身の目印 1 個 + 数の上限の切り替わり） */
const MAX_LABEL_CHANGE_PER_FRAME = 3;
const only = opt('only', null);
const wanted = (name) => !only || only.split(',').includes(name);

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

/** 自動移動が終わり（状態と模擬の時間で待つ）、カメラが動かなくなり、目印がそのカメラで更新されるまで待つ。 */
async function settle(page, maxFrames = 60) {
  await waitCameraIdle(page);
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
  // 全体が見える視点の見せ方は、内部の規則（小さく薄く・単語と重なる目印を隠す）の影響を受けない:
  // 倍率と不透明度が、距離だけから決まる式（0.6R〜3R で 1→0.75 倍、1→0.6）と一致する（R は manifest の bounds.radius）
  const R = ds.manifest.bounds.radius;
  let lookErr = 0;
  for (const l of shown) {
    const t = Math.min(1, Math.max(0, (l.distance - 0.6 * R) / (2.4 * R)));
    lookErr = Math.max(lookErr, Math.abs(l.scale - (1 - 0.25 * t)), Math.abs(l.opacity - (1 - 0.4 * t)));
  }
  check('全体が見える視点の目印の大きさと不透明度が、距離だけから決まる式のまま（内部の見せ方の影響がない）', lookErr < 1e-9 && shown.every((l) => l.reason === null),
    `式との差の最大 ${lookErr.toExponential(2)}`);
  const farRect = rects.find((r) => r.id === farL.id), nearRect = rects.find((r) => r.id === nearL.id);
  check('見た目の大きさと不透明度も、遠いほうが小さく薄い', farRect.w < nearRect.w && farRect.opacity < nearRect.opacity,
    `近い ${nearRect.w.toFixed(1)}px・${nearRect.opacity.toFixed(2)} / 遠い ${farRect.w.toFixed(1)}px・${farRect.opacity.toFixed(2)}`);

  const loc = await locationText(page);
  const ls = st.location;
  check('全体が見える視点では、どのクラスタの内部でもなく「最寄り: …」と方向が出る', ls.kind === 'nearest' && /^最寄り: .+ のクラスタ/.test(loc.text) && ls.direction && loc.text.includes(ls.direction.word),
    `${JSON.stringify(loc.text)}`);
  check('現在地の表示に距離の数値は出ない（名前と方向だけ）。距離は検証用の状態が返す', ls.name !== null && loc.text === `最寄り: ${ls.name} のクラスタ ${ls.direction.arrow} ${ls.direction.word}` && typeof ls.distance === 'number' && ls.distance > 0,
    `${JSON.stringify(loc.text)}、状態の距離 ${ls.distance}`);
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

async function testInside(page, ds, clusters, size) {
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
    // 内部では、ほかのクラスタの目印を小さく薄くする（距離の式 × 0.85 倍・× 0.6）。単語のない MNIST では、単語との重なりでは隠さない
    const R = ds.manifest.bounds.radius;
    const others = st.labels.filter((x) => x.visible);
    let err = 0;
    for (const o of others) {
      const t = Math.min(1, Math.max(0, (o.distance - 0.6 * R) / (2.4 * R)));
      err = Math.max(err, Math.abs(o.scale - 0.85 * (1 - 0.25 * t)), Math.abs(o.opacity - 0.6 * (1 - 0.4 * t)));
    }
    check(`クラスタ ${id}（${c.name}）の内部: ほかのクラスタの目印は出たまま、小さく薄くなる（単語との重なりで隠れる目印はない）`,
      others.length > 0 && err < 1e-9 && st.labels.every((x) => x.reason !== 'words'), `出ている ${others.length} 個、式との差 ${err.toExponential(2)}`);
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

  // 俯瞰モード: 飛行モードへ切り替えてから移動する
  console.log('\n[俯瞰モードでの目印のクリック]');
  await goTo(page, home.pos, home.look);
  await page.keyboard.press('KeyO');
  await page.waitForFunction(() => window.__explorer.getState().mode === 'overview');
  await waitReorient(page); // 点群の中心への向き直し（0.5 秒。ずれが 3° 未満なら始まらない）が終わるまで待つ
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

// ---------- 目印の上のホイールとドラッグ ----------

/** 目印のない場所（canvas が最前面）の点。 */
async function emptyPoint(page) {
  return page.evaluate(() => {
    for (const [x, y] of [[640, 70], [300, 320], [900, 380], [200, 500], [1000, 250]]) {
      if (x < innerWidth && y < innerHeight && document.elementFromPoint(x, y)?.tagName === 'CANVAS') return { x, y };
    }
    return null;
  });
}

/** 画面に出ていて、中心が最前面にある目印（その位置でホイールとドラッグを試せる）。 */
async function topVisibleChip(page, nth = 0) {
  const st = await labelState(page);
  const ids = [];
  for (const l of st.labels.filter((x) => x.visible).sort((a, b) => a.distance - b.distance)) {
    const ok = await page.evaluate(([x, y, id]) => document.elementFromPoint(x, y)?.closest?.('.cluster-label')?.dataset.clusterId === String(id), [l.x, l.y, l.id]);
    if (ok) ids.push(l);
  }
  return ids[nth] ?? null;
}

async function wheelAt(page, x, y, dy, { ctrl = false } = {}) {
  await page.mouse.move(x, y);
  if (ctrl) await page.keyboard.down('Control');
  await page.mouse.wheel(0, dy);
  if (ctrl) await page.keyboard.up('Control');
  await frames(page, 3);
  // 俯瞰モードの距離は目標へ時定数 0.15 秒で近づくので、寄り終える（zooming が false になる）まで待つ
  for (let k = 0; k < 120; k++) {
    const st = await state(page);
    if (!st.overview || !st.overview.zooming) break;
    await frames(page, 1);
  }
}

async function dragBy(page, x, y, dx, dy) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  await page.waitForTimeout(250); // ポインタを止めてから離す（離す直前の動きが速いと、回転の慣性が付くので）
  await page.mouse.up();
  await frames(page, 3);
}

async function testPointerOnLabel(page, clusters) {
  console.log('\n[目印の上のホイールとドラッグ]');
  const home = await overviewView(page);
  await goTo(page, home.pos, home.look);
  // ホイールの記録（ページのズームを止めているか: 本物の入力の wheel が、ウィンドウに届いた時点で defaultPrevented か）
  await page.evaluate(() => {
    window.__wheels = [];
    window.addEventListener('wheel', (e) => window.__wheels.push({ trusted: e.isTrusted, ctrl: e.ctrlKey, prevented: e.defaultPrevented, onLabel: !!e.target.closest?.('.cluster-label') }));
  });
  const empty = await emptyPoint(page);
  const chip = await topVisibleChip(page, 0);
  check('前提: 目印のない場所と、中心が最前面の目印がある', !!empty && !!chip);
  if (!empty || !chip) return;

  // ---- 飛行モードのホイール: 目印の上と、ない場所で、同じだけ速度が変わる ----
  const sp0 = (await state(page)).speed;
  await wheelAt(page, empty.x, empty.y, -100);
  const sp1 = (await state(page)).speed;
  await page.waitForTimeout(700); // 払いの継続（ホイールの連続操作）を終わらせる
  await wheelAt(page, chip.x, chip.y, -100);
  const sp2 = (await state(page)).speed;
  check('目印の上のホイールで、飛行速度が変わる（目印のない場所と同じ倍率）', sp1 > sp0 && sp2 > sp1 && Math.abs(sp2 / sp1 - sp1 / sp0) < 1e-6,
    `速度 ${sp0.toPrecision(4)} → ${sp1.toPrecision(4)}（目印のない場所）→ ${sp2.toPrecision(4)}（目印の上）`);
  await page.waitForTimeout(700);
  const dprBefore = await page.evaluate(() => devicePixelRatio);
  await wheelAt(page, chip.x, chip.y, -100, { ctrl: true });
  const sp3 = (await state(page)).speed;
  const log = await page.evaluate(() => window.__wheels.filter((w) => w.trusted && w.ctrl));
  check('目印の上の Ctrl＋ホイールは、ページのズームにならない（既定の動作が止められ、速度も変わらない）',
    log.length > 0 && log.every((w) => w.prevented && w.onLabel) && sp3 === sp2 && (await page.evaluate(() => devicePixelRatio)) === dprBefore,
    JSON.stringify(log));
  await page.waitForTimeout(700);
  await wheelAt(page, empty.x, empty.y, 100); // 速度を戻す
  await page.waitForTimeout(700);
  await wheelAt(page, chip.x, chip.y, 100);

  // ---- 目印の上から始めたドラッグ: 目印のない場所のドラッグと同じだけ視点が回り、飛ばず、点の選択も変えない ----
  const home2 = await overviewView(page);
  await goTo(page, home2.pos, home2.look);
  const chip2 = await topVisibleChip(page, 0);
  const selBefore = await ix(page);
  const posBefore = await state(page);
  await dragBy(page, chip2.x, chip2.y, 120, 90);
  const afterChip = await state(page);
  await page.waitForTimeout(300);
  await frames(page, 2);
  const afterChipLater = await state(page);
  await goTo(page, home2.pos, home2.look);
  const e2 = await emptyPoint(page);
  await dragBy(page, e2.x, e2.y, 120, 90);
  const afterEmpty = await state(page);
  const turned = len(sub(afterChip.direction, posBefore.direction));
  check('目印の上から始めたドラッグで、視点が回る（目印のない場所のドラッグと同じ量）', turned > 0.05 && len(sub(afterChip.direction, afterEmpty.direction)) < 1e-6,
    `回転 ${turned.toFixed(4)}、目印のない場所との差 ${len(sub(afterChip.direction, afterEmpty.direction)).toExponential(2)}`);
  check('目印の上から始めたドラッグは、目印のクリックにならない（クラスタへ飛ばない）・点の選択も変えない',
    len(sub(afterChip.position, posBefore.position)) < 1e-9 && len(sub(afterChipLater.position, posBefore.position)) < 1e-9 && (await ix(page)).selected === selBefore.selected && afterChipLater.mode === 'fly',
    `位置の変化 ${len(sub(afterChipLater.position, posBefore.position)).toExponential(2)}、選択 ${(await ix(page)).selected}`);

  // ---- ドラッグのあとでも、動かさないクリックでは飛ぶ ----
  await goTo(page, home2.pos, home2.look);
  const chip3 = await topVisibleChip(page, 1);
  const s0 = await state(page);
  await page.mouse.move(chip3.x, chip3.y);
  await page.mouse.down();
  await page.mouse.move(chip3.x + 2, chip3.y + 1); // 閾値（4px）未満の揺れはクリック
  await page.mouse.up();
  await waitFor(page, async (pg) => ({ ok: len(sub((await state(pg)).position, s0.position)) > 1e-6 }), 12);
  const s1 = await settle(page, 80);
  const d1 = len(sub(s1.position, clusters[chip3.id].center));
  check('目印を動かさずに押して離すと（4px 未満の揺れ）、これまでどおりクラスタの手前へ飛ぶ', Math.abs(d1 - 1.15 * clusters[chip3.id].radius / Math.sin(Math.PI / 6)) < 1e-3, `中心までの距離 ${d1.toFixed(4)}`);

  // ---- 俯瞰モード: ホイールで距離が変わる ----
  await goTo(page, home2.pos, home2.look);
  await page.keyboard.press('KeyO');
  await page.waitForFunction(() => window.__explorer.getState().mode === 'overview');
  await waitReorient(page); // 点群の中心への向き直し（0.5 秒。ずれが 3° 未満なら始まらない）が終わるまで待つ
  await frames(page, 3);
  const so = await state(page);
  const dist = (st) => len(sub(st.position, st.pivot));
  const oempty = await emptyPoint(page);
  const ochip = await topVisibleChip(page, 0);
  check('前提（俯瞰モード）: 目印のない場所と、最前面の目印がある', !!oempty && !!ochip);
  if (oempty && ochip) {
    await wheelAt(page, oempty.x, oempty.y, -100);
    const d_a = dist(await state(page));
    await page.waitForTimeout(700);
    const ochip2 = await topVisibleChip(page, 0); // 距離が変わったので位置を取り直す
    await wheelAt(page, ochip2.x, ochip2.y, -100);
    const d_b = dist(await state(page));
    const d_0 = dist(so);
    check('俯瞰モード: 目印の上のホイールで、点群の中心までの距離が変わる（目印のない場所と同じ倍率）', d_a < d_0 && d_b < d_a && Math.abs(d_b / d_a - d_a / d_0) < 1e-6,
      `距離 ${d_0.toFixed(4)} → ${d_a.toFixed(4)}（目印のない場所）→ ${d_b.toFixed(4)}（目印の上）`);
    await page.waitForTimeout(700);
    const ochip3 = await topVisibleChip(page, 0);
    const dprO = await page.evaluate(() => devicePixelRatio);
    await wheelAt(page, ochip3.x, ochip3.y, -100, { ctrl: true });
    const logO = await page.evaluate(() => window.__wheels.filter((w) => w.trusted && w.ctrl && w.onLabel));
    // 俯瞰モードの Ctrl＋ホイールはピンチとして寄る。マウスの 1 ノッチ（deltaY −100）は、1 回の上限の 1.15³ 分の 1 倍に収まる
    const d_c = dist(await state(page));
    check('俯瞰モード: 目印の上の Ctrl＋ホイールもページのズームにならず、ピンチとして寄る（1 ノッチで 1.15³ 分の 1 倍まで）',
      logO.length > 0 && logO.every((w) => w.prevented) && Math.abs(d_c / d_b - 1.15 ** -3) < 1e-6 && (await page.evaluate(() => devicePixelRatio)) === dprO,
      `距離 ${d_b.toFixed(4)} → ${d_c.toFixed(4)}（${(d_c / d_b).toFixed(6)} 倍、見込み ${(1.15 ** -3).toFixed(6)}）、${JSON.stringify(logO)}`);
    // 目印の上のドラッグで点群の中心のまわりを回る（目印のない場所のドラッグと同じ量）
    await goTo(page, so.position, so.lookAt);
    const before = await state(page);
    const c4 = await topVisibleChip(page, 0);
    await dragBy(page, c4.x, c4.y, 100, 60);
    const aChip = await state(page);
    await goTo(page, so.position, so.lookAt);
    const e4 = await emptyPoint(page);
    await dragBy(page, e4.x, e4.y, 100, 60);
    const aEmpty = await state(page);
    check('俯瞰モード: 目印の上から始めたドラッグで、点群の中心のまわりを回る（目印のない場所と同じ量）。飛ばない',
      len(sub(aChip.position, before.position)) > 0.05 && len(sub(aChip.position, aEmpty.position)) < 1e-6 && aChip.mode === 'overview',
      `位置の変化 ${len(sub(aChip.position, before.position)).toFixed(4)}、目印のない場所との差 ${len(sub(aChip.position, aEmpty.position)).toExponential(2)}、モード ${aChip.mode}`);
  }
  await page.keyboard.press('KeyO');
  await page.waitForFunction(() => window.__explorer.getState().mode === 'fly');
  await frames(page, 2);
}

// ---------- 切り替えの安定（ちらつき）と画面の端 ----------

const visibilityKey = (st) => st.labels.map((l) => (l.visible ? '1' : '0')).join('');

async function viewAt(page, v) {
  await setView(page, v.pos, v.look);
  await frames(page, 1); // 要求の次のフレームが、新しい視点で目印を更新する
  return labelState(page);
}

/**
 * 経路 `path(t)`（t の小さい側から大きい側へ）を細かく進め、目印の表示が変わる最初の境目を見つける。
 * 見つけたら、その直前・直後の t と、変わった目印の id・理由（変わったあとの）を返す。
 */
async function findBoundary(page, path, t0, t1, n, wantReason, { vanish = false } = {}) {
  let prev = await viewAt(page, path(t0));
  let prevT = t0;
  for (let k = 1; k <= n; k++) {
    const t = t0 + ((t1 - t0) * k) / n;
    const st = await viewAt(page, path(t));
    for (let i = 0; i < st.labels.length; i++) {
      const a = prev.labels[i], b = st.labels[i];
      if (a.visible !== b.visible && (!vanish || a.visible) && wantReason.includes(a.visible ? b.reason : a.reason)) {
        return { before: prevT, after: t, id: b.id, nowVisible: b.visible, reason: a.visible ? b.reason : a.reason };
      }
    }
    prev = st;
    prevT = t;
  }
  return null;
}

/** 境目をまたぐ 2 つの視点（`tA` は手前、`tB` は向こう）の間で、カメラを往復させて、表示が切り替わる回数を数える。 */
async function oscillate(page, path, tA, tB, rounds) {
  await viewAt(page, path(tB)); // 境目の向こう側で落ち着かせる
  let last = visibilityKey(await viewAt(page, path(tB)));
  let toggles = 0;
  for (let k = 0; k < rounds; k++) {
    const key = visibilityKey(await viewAt(page, path(k % 2 === 0 ? tA : tB)));
    if (key !== last) toggles++;
    last = key;
  }
  return toggles;
}

async function testStability(page) {
  console.log('\n[目印の表示の安定（重なり・画面の端の境目）]');
  const home = await overviewView(page);
  const look = home.look;
  const dir = norm(sub(home.pos, look));
  const R = len(sub(home.pos, look));
  const out = (t) => ({ pos: add(look, mul(dir, R * t)), look }); // t が大きいほど離れる（目印が寄り集まる）
  const inward = (t) => ({ pos: add(look, mul(dir, R * (1.2 - t))), look }); // t が大きいほど近づく（外側の目印が画面の外へ出る）
  const paths = [
    ['離れる', out, 1.0, 2.6, 40, ['overlap']],
    ['近づく', inward, 0.0, 0.8, 40, ['offscreen']],
  ];
  let foundAny = 0;
  for (const [name, path, t0, t1, n, reasons] of paths) {
    const b = await findBoundary(page, path, t0, t1, n, reasons);
    if (!b) { console.log(`  ${name}: 境目が見つからない（${reasons.join('・')}）`); continue; }
    // 粗い境目の中で、細かく境目を探す（前のフレームの結果に依るので、境目の手前へ戻って落ち着かせてから進める）
    const step = (b.after - b.before) / 24;
    let fine = null;
    await viewAt(page, path(b.before - (b.after - b.before) * 3));
    let prev = visibilityKey(await viewAt(page, path(b.before)));
    for (let k = 1; k <= 24; k++) {
      const t = b.before + step * k;
      const key = visibilityKey(await viewAt(page, path(t)));
      if (key !== prev) { fine = t; break; }
    }
    if (fine === null) { console.log(`  ${name}: 細かい境目が見つからない`); continue; }
    foundAny++;
    // 境目をまたぐ隣り合う 2 つの細かい刻みの間を往復する。目印の画面上の動きが、切り替えの幅（間隔 3px・端 7.5px）に収まることも確かめる
    const sA = await viewAt(page, path(fine - step));
    const sB = await viewAt(page, path(fine));
    const la = sA.labels.find((l) => l.id === b.id), lb = sB.labels.find((l) => l.id === b.id);
    const motion = la.x !== null && lb.x !== null ? Math.hypot(la.x - lb.x, la.y - lb.y) : 0;
    const toggles = await oscillate(page, path, fine - step, fine, 16);
    check(`カメラを小さく往復させても、目印の表示が切り替わり続けない（${name}: クラスタ ${b.id} の ${b.reason}、往復の振れは画面上で ${motion.toFixed(2)}px）`, motion < 2 && toggles === 0, `16 往復で切り替わり ${toggles} 回`);
  }
  check('重なりまたは画面の端の境目が、少なくとも 1 つ見つかった', foundAny >= 1, `${foundAny} 個`);
}

/** 現在地と目印の表示を 1 つの文字列にする（変わったら、表示のどこかが切り替わっている） */
const stateKey = (st) => `${st.location.kind}:${st.location.clusterId}|${st.labels.map((l) => (l.visible ? '1' : '0')).join('')}`;

/** 2 つの表示の違い（現れた・消えた目印の数の合計） */
const labelDiff = (a, b) => a.labels.reduce((n, l, i) => n + (l.visible !== b.labels[i].visible ? 1 : 0), 0);

async function testBoundary(page, clusters) {
  console.log('\n[クラスタの境界での安定と、またぐときの目印の数の変化]');
  const stats = [];
  for (const id of [2, 4, 7]) {
    const c = clusters[id];
    const u = norm(c.center);
    const at = (r) => add(c.center, mul(u, c.radius * r)); // 球の表面の付近（r は中心からの距離 ÷ radius）。外側（点群の外）へ向かう向き
    const look = c.center;
    const tag = `クラスタ ${id}（${c.name}）`;

    // 外から近づいて、帯（0.95〜1.05）の中で、位置を小さく往復させる（半径の 0.99 倍と 1.03 倍の間）
    await viewAt(page, { pos: at(1.6), look });
    for (let r = 1.6; r >= 1.03; r -= 0.03) await viewAt(page, { pos: at(r), look });
    const keysOut = [];
    for (let k = 0; k < 20; k++) keysOut.push(stateKey(await viewAt(page, { pos: at(k % 2 === 0 ? 0.99 : 1.03), look })));
    check(`${tag}: 外から近づいて、半径の 0.99 倍と 1.03 倍の間を往復しても、現在地・目印の表示が切り替わり続けない（外のまま）`,
      new Set(keysOut).size === 1 && keysOut[0].startsWith('nearest:'), `${new Set(keysOut).size} 通り（${keysOut[0].split('|')[0]}）`);

    // 内から離れて、同じ帯の中で往復させる（内のまま）
    await viewAt(page, { pos: at(0.4), look });
    for (let r = 0.4; r <= 1.0; r += 0.03) await viewAt(page, { pos: at(r), look });
    const keysIn = [];
    for (let k = 0; k < 20; k++) keysIn.push(stateKey(await viewAt(page, { pos: at(k % 2 === 0 ? 0.97 : 1.03), look })));
    check(`${tag}: 内から出ようとして、半径の 0.97 倍と 1.03 倍の間を往復しても、現在地・目印の表示が切り替わり続けない（内のまま）`,
      new Set(keysIn).size === 1 && keysIn[0].startsWith(`inside:${id}`), `${new Set(keysIn).size} 通り（${keysIn[0].split('|')[0]}）`);

    // 向きの小さな往復（表面の上で、視線を ±0.2 度ずつ左右へ）。位置は帯の中
    const pos = at(1.0);
    const dir0 = norm(sub(look, pos));
    const yaw = (d, a) => [d[0] * Math.cos(a) - d[2] * Math.sin(a), d[1], d[0] * Math.sin(a) + d[2] * Math.cos(a)];
    await viewAt(page, { pos, look });
    const keysTurn = [];
    for (let k = 0; k < 20; k++) {
      const d = yaw(dir0, (k % 2 === 0 ? 1 : -1) * 0.2 * Math.PI / 180);
      keysTurn.push(stateKey(await viewAt(page, { pos, look: add(pos, mul(d, 0.5)) })));
    }
    check(`${tag}: 表面の上で視線を ±0.2 度ずつ往復させても、現在地・目印の表示が切り替わり続けない`, new Set(keysTurn).size === 1, `${new Set(keysTurn).size} 通り`);

    // 境界をゆっくりまたぐ: 内から外へ、外から内へ。1 フレームで現れる・消える目印の数を数える
    const crossing = async (from, to, steps) => {
      let prev = await viewAt(page, { pos: at(from), look });
      let maxChange = 0, kindChanges = 0;
      for (let k = 1; k <= steps; k++) {
        const r = from + ((to - from) * k) / steps;
        const st = await viewAt(page, { pos: at(r), look });
        maxChange = Math.max(maxChange, labelDiff(prev, st));
        if (st.location.kind !== prev.location.kind) kindChanges++;
        prev = st;
      }
      return { maxChange, kindChanges };
    };
    const outward = await crossing(0.3, 1.8, 100);
    await viewAt(page, { pos: at(1.8), look });
    const inward = await crossing(1.8, 0.3, 100);
    stats.push({ id, outward, inward });
    check(`${tag}: 内から外へゆっくりまたぐとき、1 フレームで現れる・消える目印は ${MAX_LABEL_CHANGE_PER_FRAME} 個以下で、内外の切り替えは 1 回`,
      outward.maxChange <= MAX_LABEL_CHANGE_PER_FRAME && outward.kindChanges === 1, `最大 ${outward.maxChange} 個/フレーム、内外の切り替え ${outward.kindChanges} 回`);
    check(`${tag}: 外から内へゆっくりまたぐとき、1 フレームで現れる・消える目印は ${MAX_LABEL_CHANGE_PER_FRAME} 個以下で、内外の切り替えは 1 回`,
      inward.maxChange <= MAX_LABEL_CHANGE_PER_FRAME && inward.kindChanges === 1, `最大 ${inward.maxChange} 個/フレーム、内外の切り替え ${inward.kindChanges} 回`);
  }

  // 球が重なる場所: 2 つのクラスタの（距離 ÷ 半径）が等しい位置の付近で往復させても、現在地のクラスタが入れ替わり続けない
  let tested = 0;
  for (let i = 0; i < clusters.length && tested < 2; i++) {
    for (let j = i + 1; j < clusters.length && tested < 2; j++) {
      const a = clusters[i], b = clusters[j];
      const D = len(sub(b.center, a.center));
      const t = (a.radius * D) / (a.radius + b.radius); // a の中心からの距離（両方の ratio が等しくなる位置）
      if (!(D < a.radius + b.radius) || t / a.radius > 0.85) continue;
      const dir = norm(sub(b.center, a.center));
      const amp = 0.02 * Math.min(a.radius, b.radius);
      const pos = (off) => add(a.center, mul(dir, t + off));
      const lookAt = add(a.center, mul(dir, t));
      await viewAt(page, { pos: pos(-0.1 * a.radius), look: lookAt });
      const ids = [];
      for (let k = 0; k < 20; k++) {
        const st = await viewAt(page, { pos: pos(k % 2 === 0 ? amp : -amp), look: lookAt });
        ids.push(st.location.kind === 'inside' ? st.location.clusterId : -1);
      }
      check(`重なり合うクラスタ ${i} と ${j} の境目（距離 ÷ 半径が等しい位置）で、往復しても、現在地のクラスタが入れ替わり続けない`,
        new Set(ids).size === 1 && ids[0] >= 0, `現在地 ${[...new Set(ids)].join(',')}`);
      tested++;
    }
  }
  check('球が重なる 2 つのクラスタの組が見つかった', tested >= 1, `${tested} 組`);
  console.log(`  参考: ${stats.map((s) => `クラスタ ${s.id} 内→外 最大 ${s.outward.maxChange}/フレーム、外→内 最大 ${s.inward.maxChange}/フレーム`).join(' / ')}`);
}

async function testEdges(page, clusters, size) {
  console.log('\n[画面の端]');
  const home = await overviewView(page);
  const dir = norm(sub(home.pos, home.look));
  const R = len(sub(home.pos, home.look));
  const side = norm([dir[2], 0, -dir[0]]);
  let views = 0, protruding = 0, cut = 0, centerInsideRectOut = 0;
  const bad = [];
  for (const k of [-0.5, -0.3, -0.15, 0, 0.15, 0.3, 0.5, 0.7]) {
    for (const zoom of [0.55, 0.8]) {
      const pos = add(add(home.look, mul(dir, R * zoom)), mul(side, R * k));
      const s = await goTo(page, pos, add(home.look, mul(side, R * k * 0.35)));
      const st = await labelState(page);
      views++;
      const rects = await page.evaluate(() => [...document.querySelectorAll('.cluster-label')].map((e) => {
        const r = e.getBoundingClientRect();
        return { id: Number(e.dataset.clusterId), l: r.left, t: r.top, r: r.right, b: r.bottom, hidden: getComputedStyle(e).visibility === 'hidden', w: innerWidth, h: innerHeight };
      }));
      for (const r of rects) {
        if (r.hidden) continue;
        if (r.l < 0 || r.t < 0 || r.r > r.w || r.b > r.h) { protruding++; bad.push([k, zoom, r.id, r.l, r.t, r.r, r.b]); }
      }
      for (const l of st.labels) {
        const p = projectIndependent(s, clusters[l.id].center, size.width, size.height);
        if (p && p.x >= 0 && p.x <= size.width && p.y >= 0 && p.y <= size.height && !l.visible && l.reason === 'offscreen') centerInsideRectOut++;
        if (l.visible) cut += 0;
      }
    }
  }
  check(`画面の端で、表示中の目印が画面からはみ出さない（${views} 視点）`, protruding === 0, `はみ出し ${protruding} 件 ${JSON.stringify(bad.slice(0, 3))}`);
  check('中心は画面の内側にあっても、矩形がはみ出す目印は出さない（理由 offscreen）', centerInsideRectOut > 0, `${centerInsideRectOut} 件`);
}

// ---------- フォーカス ----------

async function testFocus(page, clusters) {
  console.log('\n[フォーカス中の目印が出なくなるとき]');
  const home = await overviewView(page);
  await goTo(page, home.pos, home.look);
  const st = await labelState(page);
  const target = st.labels.filter((l) => l.visible).sort((a, b) => a.distance - b.distance)[0];
  await page.evaluate((id) => document.querySelector(`.cluster-label[data-cluster-id="${id}"]`).focus(), target.id);
  const focusedBefore = await page.evaluate(() => Number(document.activeElement.dataset?.clusterId ?? -1));
  check('前提: 目印にフォーカスしている', focusedBefore === target.id, `フォーカス ${focusedBefore}`);
  // そのクラスタの内部へ入ると、目印は出なくなる（理由 inside）。ほかの目印は出ている
  const c = clusters[target.id];
  await goTo(page, add(c.center, mul(norm(c.center), c.radius * 0.3)), c.center);
  const st2 = await labelState(page);
  const hidden = st2.labels.find((l) => l.id === target.id);
  const others = st2.labels.filter((l) => l.visible);
  const active = await page.evaluate(() => ({ cls: document.activeElement?.classList?.contains('cluster-label') ? Number(document.activeElement.dataset.clusterId) : null, tag: document.activeElement?.tagName }));
  check('前提: フォーカス中の目印が出なくなった（クラスタの内部）。ほかの目印は出ている', !hidden.visible && others.length > 0, `理由 ${hidden.reason}、出ている ${others.length} 個`);
  check('フォーカス中の目印が出なくなると、フォーカスは次に出ている目印へ移る（body へ落ちない）', active.cls !== null && active.cls !== target.id && others.some((l) => l.id === active.cls), JSON.stringify(active));
  const visibleNow = await page.evaluate(() => getComputedStyle(document.activeElement).visibility);
  check('移った先の目印は見えている（フォーカスの輪が出る）', visibleNow === 'visible');
  await page.evaluate(() => document.activeElement && document.activeElement.blur());

  // 出ている目印がほかにないときは、フォーカスを外す（隠れた目印にフォーカスを残さない）
  await goTo(page, add(c.center, mul(norm(c.center), c.radius * 0.3)), c.center);
  await page.evaluate((id) => document.querySelector(`.cluster-label[data-cluster-id="${id}"]`)?.focus(), target.id);
  // 後ろを向けて、すべての目印を出なくする（点群の外から外向きを見る）
  const away = norm(c.center);
  await goTo(page, mul(away, 3.5), mul(away, 7));
  const st3 = await labelState(page);
  const active3 = await page.evaluate(() => document.activeElement?.tagName);
  check('すべての目印が出なくなったときは、フォーカスが隠れた目印に残らない', st3.labels.every((l) => !l.visible) && active3 === 'BODY', `出ている ${st3.labels.filter((l) => l.visible).length} 個、フォーカス ${active3}`);

  // 重なりでは隠さない: 重なりが起きる境目で、フォーカス中の遠い目印が残り、近い目印が隠れる
  const dir = norm(sub(home.pos, home.look));
  const R = len(sub(home.pos, home.look));
  const out = (t) => ({ pos: add(home.look, mul(dir, R * t)), look: home.look });
  const b = await findBoundary(page, out, 1.0, 2.6, 40, ['overlap'], { vanish: true });
  if (!b) { check('前提: 離れると重なりで隠れる目印がある', false); return; }
  // 隠れた直前の視点で、隠れる側の目印にフォーカスし、境目の向こうへ進める
  await viewAt(page, out(b.before - (b.after - b.before) * 3)); // 出ている状態へ戻してから（切り替えに幅があるので）
  const stB = await viewAt(page, out(b.before));
  check('前提: 境目の直前では、その目印は出ている', stB.labels.find((l) => l.id === b.id).visible);
  await page.evaluate((id) => document.querySelector(`.cluster-label[data-cluster-id="${id}"]`).focus(), b.id);
  const stF = await viewAt(page, out(b.after));
  const lf = stF.labels.find((l) => l.id === b.id);
  const act = await page.evaluate(() => (document.activeElement?.classList?.contains('cluster-label') ? Number(document.activeElement.dataset.clusterId) : null));
  check(`フォーカス中の目印（クラスタ ${b.id}）は、ほかの目印と重なっても隠れず、フォーカスも残る`, lf.visible && act === b.id, `visible ${lf.visible}、reason ${lf.reason}、フォーカス ${act}`);
  const rects = [];
  for (const l of stF.labels.filter((x) => x.visible)) { const r = await elementCenter(page, l.id); rects.push({ id: l.id, x: r.x, y: r.y, w: r.w, h: r.h }); }
  check('そのとき、表示中の目印は画面上で重なっていない', rectsOverlapAny(rects) === null, JSON.stringify(rectsOverlapAny(rects)));
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
}

// ---------- 現在地の表示の更新 ----------

async function testLocationDom(page) {
  console.log('\n[現在地の表示の更新]');
  await goTo(page, [0, 0, 2.2], [0, 0, 0]);
  const st0 = await labelState(page);
  await page.evaluate(() => {
    const el = document.getElementById('cluster-location');
    window.__locMutations = [];
    window.__locNodes = [...el.children];
    new MutationObserver((rs) => window.__locMutations.push(...rs.map((r) => r.type))).observe(el, { childList: true, characterData: true, attributes: true, subtree: true });
  });
  // 向きが変わらない範囲で、少しずつ近づく（縁までの距離だけが変わる）
  let moved = 0, lastDistance = st0.location.distance;
  let sameText = true;
  for (const z of [2.18, 2.16, 2.14, 2.12]) {
    await goTo(page, [0, 0, z], [0, 0, 0]);
    const st = await labelState(page);
    if (st.location.text !== st0.location.text) sameText = false;
    if (Math.abs(st.location.distance - lastDistance) > 1e-6) moved++;
    lastDistance = st.location.distance;
  }
  const res = await page.evaluate(() => ({ mutations: window.__locMutations.length, same: [...document.getElementById('cluster-location').children].every((c, i) => c === window.__locNodes[i]), n: window.__locNodes.length }));
  check('距離だけが変わる移動では、現在地の表示の要素を書き換えない（DOM の変更 0 件、要素も作り直さない）', moved >= 3 && sameText && res.mutations === 0 && res.same && res.n === 2,
    `距離が変わった ${moved} 回、DOM の変更 ${res.mutations} 件、要素 ${res.n} 個`);
  // 向き（文面）が変わるときは、文字だけを書き換える（要素は同じ）
  const c0 = (await labelState(page)).location.text;
  await goTo(page, [0, 0, 2.2], [3, 0, 2.2]);
  const c1 = (await labelState(page)).location.text;
  const res2 = await page.evaluate(() => ({ same: [...document.getElementById('cluster-location').children].every((c, i) => c === window.__locNodes[i]), text: document.getElementById('cluster-location').innerText.trim(), types: window.__locMutations.slice() }));
  check('文面が変わるときは、文字だけを書き換え、要素は作り直さない', c1 !== c0 && res2.same && res2.text === c1 && res2.types.every((t) => t === 'characterData' || t === 'childList' || t === 'attributes'),
    `${JSON.stringify(c0)} → ${JSON.stringify(c1)}`);
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
    if (w === 600) {
      await page.screenshot({ path: path.join(outDir, '6-portrait.png') });
      const hud = await page.evaluate(() => {
        const el = document.getElementById('hud');
        const r = el.getBoundingClientRect();
        const items = [...el.querySelectorAll('.hud-item')];
        const lines = new Set(items.map((e) => Math.round(e.getBoundingClientRect().top)));
        const loc = document.getElementById('cluster-location').getBoundingClientRect();
        return {
          right: r.right, left: r.left, innerWidth, help: el.innerText.split('\n')[2],
          brokenItems: items.filter((e) => e.getClientRects().length !== 1).length, helpLines: lines.size, n: items.length,
          locBottom: loc.bottom, hudTop: r.top,
        };
      });
      check('幅 600 の画面: HUD が画面からはみ出さず、操作説明が複数行に折り返される（項目の途中では折り返さない）',
        hud.left >= 0 && hud.right <= hud.innerWidth && hud.brokenItems === 0 && hud.helpLines >= 2 && hud.n >= 9, JSON.stringify(hud));
      check('幅 600 の画面: 操作説明に L キーと M キーがある。現在地の表示は HUD の上にあって重ならない', hud.help.includes('L 目印の表示') && hud.help.includes('M ミニマップ') && hud.locBottom <= hud.hudTop, `現在地の下端 ${hud.locBottom}、HUD の上端 ${hud.hudTop}`);
    }
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
    check('目印の要素も現在地の表示も出ない。HUD に L キーの説明がなく、M キーの説明は残る', dom.chips === 0 && dom.containerHidden && dom.locationHidden && !dom.hud.includes('L 目印') && dom.hud.includes('M ミニマップ'), JSON.stringify(dom));
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

    if (wanted('overview')) await testOverview(page, ds, clusters, size);
    if (wanted('offscreen')) await testBehindAndOffscreen(page, clusters, size);
    if (wanted('inside')) await testInside(page, ds, clusters, size);
    if (wanted('toggle')) await testToggle(page);
    if (wanted('keyboard')) await testKeyboard(page, clusters);
    if (wanted('click')) await testClickToFly(page, ds, clusters, coarse, size);
    if (wanted('pointer')) await testPointerOnLabel(page, clusters);
    if (wanted('stability')) await testStability(page);
    if (wanted('boundary')) await testBoundary(page, clusters);
    if (wanted('edges')) await testEdges(page, clusters, size);
    if (wanted('focus')) await testFocus(page, clusters);
    if (wanted('location')) await testLocationDom(page);
    if (wanted('shots')) await takeShots(page, ds, clusters);
    await page.close();
    if (wanted('resize')) await testResize(browser, base, clusters);
    if (wanted('noclusters')) await testNoClusters(browser, base);

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
