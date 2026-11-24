#!/usr/bin/env node
/**
 * 単語のデータセット（word2vec）の表示と、データセットの切り替えの検証。
 * ビルドしてプレビューサーバーを起動し、ヘッドレス Chromium へ実際のマウス・キーの入力を送る。
 *
 *   node scripts/verify/datasets.cjs [--no-build] [--port 4330] [--out artifacts/datasets] [--rounds 5] [--only-failure]
 *
 * 確かめること:
 *   - `?data=word2vec-10k` で開くと、エラーなく表示され、全点が丸い点として描かれ（番号の画像で、各点の画素が半径の円の内側に収まる）、
 *     点の色がクラスタに対応する（同じクラスタは同じ色、パレットの 10 色の繰り返し、クラスタなしは灰色。画面の画素も霧を含めて一致）
 *   - ホバーで単語が出る。クリックで情報パネルに単語・番号・クラスタ（なければ「なし」）が出て、画像は出ない。読み上げの文。ダブルクリックでその点へ飛ぶ
 *   - ピッキングの小領域と全画面の番号が一致し、通常の描画と形が一致する（picking.cjs のページ内の検証を再利用）
 *   - 目印が出て、色が点の色と一致し、クリックでクラスタの手前へ飛ぶ。内部で現在地が出る。ミニマップに点群とカメラが出る。
 *     H キーでホームへ戻る。速度の自動調整が働く（クラスタの内部で遅く、外で速い）
 *   - 画面上の選択欄で MNIST と word2vec を往復して、それぞれ正しく表示される。URL が更新され、ブラウザの戻るで前のデータセットへ戻る。
 *     往復を繰り返しても、WebGL のテクスチャとジオメトリの数、JS のヒープ、イベントのリスナーの数が増え続けない。
 *     切り替え後に、前のデータの点がホバーや選択に現れない
 *   - 存在しないデータセットを指定すると、エラーが表示され、表示中のデータセットと操作が保たれる（起動時の指定でも、あとから選択欄で開ける）
 *   - 単語の文字の生成を意図的に失敗させる（`window.__explorer.faults.words`）と、表示全体は失敗にならず、丸い点だけで表示が続き、HUD に知らせる文が出る。
 *     キーでの移動量は、文字が生成できたときと同じ（2 倍になっていない）。表示の生成そのものを失敗させる（`faults.view`）と、前のデータで作り直し、
 *     カメラ操作などのリスナーの数が失敗の前と同じで、キーでの移動量も同じ
 *   - コンソールエラーがない
 * スクリーンショット（全体・クラスタの縁・内部・点を選択した状態）を --out に保存する。失敗があれば終了コード 1 で終わる。
 */
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { loadDataset, waitForServer, startPreview, CHROMIUM_ARGS, sub, add, mul, len, norm, readInfoRect, waitCameraIdle } = require('./lib.cjs');
const { pageChecks } = require('./picking.cjs');

const root = path.resolve(__dirname, '../..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const outDir = path.resolve(root, opt('out', 'artifacts/datasets'));
const port = Number(opt('port', '4330'));
const rounds = Number(opt('rounds', '5'));
const width = 1280, height = 800;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// ---------- 期待値（アプリのコードとは別に、ソースとデータから読む） ----------

const paletteSrc = fs.readFileSync(path.join(root, 'src/render/palette.ts'), 'utf8');
const PALETTE = [...paletteSrc.slice(paletteSrc.indexOf('LABEL_COLORS'), paletteSrc.indexOf('];')).matchAll(/'(#[0-9a-f]{6})'/gi)].map((m) => m[1].toLowerCase());
const NOISE = /NOISE_COLOR = '(#[0-9a-f]{6})'/i.exec(fs.readFileSync(path.join(root, 'src/render/colorScheme.ts'), 'utf8'))[1].toLowerCase();
const hexRgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

const w2v = loadDataset(path.join(root, 'public/data/word2vec-10k'));
const mnist = loadDataset(path.join(root, 'public/data/mnist'));
const W2V_NOISE = w2v.manifest.clusters.noise;
const w2vCoarse = w2v.manifest.clusters.levels[0].clusters;
const expectedW2vColor = (i) => (w2v.coarse[i] === W2V_NOISE ? NOISE : PALETTE[w2v.coarse[i] % PALETTE.length]);

// ---------- ページの操作 ----------

const consoleErrors = [];
/** 意図して起こした失敗（存在しないデータセット）のコンソール出力。エラーとして数えない */
const expectedErrorPattern = /no-such|nope-dataset/;

async function openPage(browser, base, query) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const loc = m.location()?.url ?? '';
    if (expectedErrorPattern.test(m.text()) || expectedErrorPattern.test(loc)) return;
    consoleErrors.push(`[error] ${m.text()} ${loc}`);
  });
  page.on('pageerror', (e) => consoleErrors.push(`[pageerror] ${e.message}`));
  page.on('requestfailed', (r) => { if (!expectedErrorPattern.test(r.url())) consoleErrors.push(`[requestfailed] ${r.url()}`); });
  await page.goto(`${base}?${query}`);
  await page.waitForFunction(() => window.__explorer && (window.__explorer.ready || window.__explorer.error), null, { timeout: 120000 });
  return page;
}

const state = (page) => page.evaluate(() => window.__explorer.getState());
const ix = (page) => page.evaluate(() => window.__explorer.interaction.getState());
const ds = (page) => page.evaluate(() => window.__explorer.dataset.getState());
const frames = (page, n) => page.evaluate((k) => window.__explorer.measureFrames(k), n);
const setView = (page, pos, look) => page.evaluate((v) => window.__explorer.setView(v), { pos, look });
const pickAt = (page, x, y) => page.evaluate(([a, b]) => window.__explorer.pick(a, b).then((r) => (r ? r.index : null)), [x, y]);

/** 1 フレームずつ進めながら、`fn(page)` が { ok: true } を返すまで最大 `maxFrames` フレーム待つ。 */
async function waitFrames(page, fn, maxFrames = 30) {
  let v;
  for (let k = 0; k <= maxFrames; k++) {
    v = await fn(page);
    if (v && v.ok) return { ...v, frames: k };
    await frames(page, 1);
  }
  return { ...v, frames: maxFrames, ok: false };
}

/** カメラが動かなくなるまで待つ（連続する 2 フレームで位置と向きが同じ、かつホームへの移動中でない）。 */
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

/** 切り替えが終わる（generation が進み、読み込み中でない）まで待つ。 */
async function waitSwitched(page, prevGeneration) {
  await page.waitForFunction((g) => {
    const s = window.__explorer.dataset.getState();
    return !s.loading && (s.generation > g || s.error !== null);
  }, prevGeneration, { timeout: 120000 });
  await frames(page, 2);
  return ds(page);
}

/** 画面に見えていて、投影した中心で pick するとその点が真下に返る点を探す（大きく見えるものから）。 */
async function findVisiblePoint(page, { minPx = 6, exclude = [], filter = null } = {}) {
  const info = await readInfoRect(page); // 情報パネルは実際の矩形で避ける（一覧が加わって大きさが変わる）
  return page.evaluate(async ({ minPx, exclude, w, h, filter, info }) => {
    const ex = window.__explorer;
    const inInfo = (x, y) => info && x > info.left - 12 && x < info.right + 12 && y > info.top - 12 && y < info.bottom + 12;
    const ok = (x, y) => x > 40 && y > 60 && x < w - 40 && y < h - 40 && !inInfo(x, y) && !(x < 680 && y > h - 220) && !(x > w - 260 && y > h - 240);
    const allow = filter ? new Set(filter) : null;
    const cands = [];
    for (let i = 0; i < ex.picking.count; i++) {
      if (exclude.includes(i) || (allow && !allow.has(i))) continue;
      const p = ex.picking.project(i);
      if (p.depth <= 0 || p.faded || p.sizePx < minPx) continue;
      const x = Math.round(p.clientX), y = Math.round(p.clientY);
      if (!ok(x, y)) continue;
      cands.push({ i, x, y, sizePx: p.sizePx });
    }
    cands.sort((a, b) => b.sizePx - a.sizePx);
    const canvas = document.querySelector('#app canvas');
    for (const c of cands.slice(0, 200)) {
      if (document.elementFromPoint(c.x, c.y) !== canvas) continue; // 目印・パネルの下の点は、マウスで触れない
      const r = await ex.pick(c.x, c.y);
      if (r && r.index === c.i && r.pixelDistance === 0) return c;
    }
    return null;
  }, { minPx, exclude, w: width, h: height, filter, info });
}

/** クラスタの内側を見る視点（中心から外向きに半径の半分の位置から、中心を見る）。 */
function clusterViews(c) {
  const out = len(c.center) < 1e-3 ? [0, 0, 1] : norm(c.center);
  const r4 = (v) => v.map((x) => Number(x.toFixed(4)));
  return {
    edge: { pos: r4(add(c.center, mul(out, c.radius + 0.12))), look: r4(c.center) },
    inside: { pos: r4(add(c.center, mul(out, c.radius * 0.5))), look: r4(c.center) },
  };
}

// ---------- 検証本体 ----------

async function testWord2vecDisplay(page) {
  console.log('\n[word2vec の表示]');
  const d = await ds(page);
  const err = await page.evaluate(() => window.__explorer.error ?? null);
  check('?data=word2vec-10k で開くと、エラーなく表示される', !err && d.current && d.current.id === 'word2vec-10k' && d.current.kind === 'text' && d.current.count === 10000, JSON.stringify(d.current));
  const ui = await page.evaluate(() => ({
    select: document.getElementById('dataset-select').value,
    options: [...document.querySelectorAll('#dataset-select option')].map((o) => o.value),
    hud: window.__explorer.hud.getState().detail[0],
    dotsOnly: window.__explorer.pointCloud.dotsOnly,
    pointSize: window.__explorer.pointCloud.params.pointSize,
    dotRadius: window.__explorer.pointCloud.params.dotRadius,
  }));
  check('選択欄に一覧のデータセットが並び、表示中のものが選ばれている', ui.select === 'word2vec-10k' && ui.options.join(',') === 'mnist,word2vec-10k', JSON.stringify(ui));
  check('HUD にデータ名と、点の間隔から決めた点の大きさ（0.00967）が出る', ui.hud.includes('Word2Vec 10k') && ui.hud.includes('0.00967') && ui.pointSize === 0.00967, ui.hud);
  check('画像のないデータセットなので、全点を丸い点で描く（DOTS_ONLY）', ui.dotsOnly === true, JSON.stringify(ui.dotRadius));

  // ---- 点の色: 同じクラスタは同じ色、パレットの繰り返し、クラスタなしは灰色 ----
  const colors = await page.evaluate(() => Array.from({ length: 10000 }, (_, i) => window.__explorer.dataset.pointColor(i)));
  let colorBad = 0;
  for (let i = 0; i < colors.length; i++) if (colors[i].toLowerCase() !== expectedW2vColor(i)) colorBad++;
  const noiseCount = [...w2v.coarse].filter((c) => c === W2V_NOISE).length;
  check('点の色の割り当てがクラスタに対応する（クラスタ id の 10 色の繰り返し、クラスタなしは灰色）', colorBad === 0,
    `食い違い ${colorBad} 点、クラスタなし ${noiseCount} 点（${((100 * noiseCount) / 10000).toFixed(1)}%）`);

  // ---- 画面の画素: 内部の視点で、点の中心の色が期待の色（霧を含む）と一致し、各点の画素が円の内側に収まる ----
  const c0 = w2vCoarse[0];
  const v = clusterViews(c0).inside;
  await setView(page, v.pos, v.look);
  await waitStill(page);
  const pix = await page.evaluate(async () => {
    const ex = window.__explorer, dbg = ex.picking;
    const frame = dbg.readFrame();
    const img = await dbg.readIdImage();
    const { width: W, height: H, ids } = img;
    const scale = dbg.bufferScale();
    const fog = ex.pointCloud.mesh.material.uniforms.uFog.value; // x: 始まり, y: 距離, z: 上限
    const dotR = ex.pointCloud.params.dotRadius;
    // 点ごとの画素数と、中心からの最大距離
    const stats = new Map();
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const id = ids[y * W + x];
      if (id < 0) continue;
      let s = stats.get(id);
      if (!s) stats.set(id, (s = { n: 0, maxD: 0 }));
      s.n++;
    }
    const samples = [];
    let outside = 0, checked = 0, maxExcess = 0;
    const big = [];
    for (const [id, s] of stats) {
      const p = dbg.project(id);
      if (p.depth <= 0 || p.faded) continue;
      const cx = p.clientX * scale, cy = p.clientY * scale;
      const r = Math.min(dotR[0] * p.sizePx, dotR[1]) * scale; // 円の半径（描画バッファの画素）
      if (p.sizePx >= 6) big.push({ id, r, cx, cy, size: p.sizePx * scale, distance: p.distance });
    }
    big.sort((a, b) => b.size - a.size);
    for (const b of big.slice(0, 300)) {
      // その点の画素は、すべて円（半径 + 1 画素）の内側にある。ビルボードの四隅（円の外）には出ない
      const r = Math.ceil(b.size / 2) + 2;
      let n = 0;
      for (let y = Math.max(0, Math.floor(b.cy - r)); y < Math.min(H, b.cy + r); y++) for (let x = Math.max(0, Math.floor(b.cx - r)); x < Math.min(W, b.cx + r); x++) {
        if (ids[y * W + x] !== b.id) continue;
        n++;
        const d = Math.hypot(x + 0.5 - b.cx, y + 0.5 - b.cy);
        if (d > b.r + 1) { outside++; maxExcess = Math.max(maxExcess, d - b.r); }
      }
      if (n) checked++;
      // 中心の 3x3 がすべてその点なら、中心の色を霧を含めて比べる
      const px = Math.floor(b.cx), py = Math.floor(b.cy);
      let solid = px > 0 && py > 0 && px < W - 1 && py < H - 1 && b.r >= 2.5;
      for (let dy = -1; dy <= 1 && solid; dy++) for (let dx = -1; dx <= 1; dx++) if (ids[(py + dy) * W + px + dx] !== b.id) { solid = false; break; }
      if (solid && samples.length < 150) {
        const o = 4 * (py * W + px);
        const f = fog.z * (1 - Math.exp(-Math.max(b.distance - fog.x, 0) / fog.y));
        samples.push({ id: b.id, rgb: [frame.rgba[o], frame.rgba[o + 1], frame.rgba[o + 2]], fog: f, color: ex.dataset.pointColor(b.id) });
      }
    }
    return { checked, outside, maxExcess, samples, idPoints: stats.size, bigCount: big.length };
  });
  check('内部の視点で、大きく見える点（6px 以上）の画素がすべて円の内側にある（ビルボードの四角ではなく丸い点）', pix.checked >= 50 && pix.outside === 0,
    `調べた点 ${pix.checked}、円の外の画素 ${pix.outside}（最大のはみ出し ${pix.maxExcess.toFixed(2)}px）、番号の画像の点 ${pix.idPoints}`);
  const bg = [7, 8, 12];
  let colorPixBad = 0;
  const bad = [];
  for (const s of pix.samples) {
    const want = hexRgb(expectedW2vColor(s.id)).map((c, k) => c * (1 - s.fog) + bg[k] * s.fog);
    const err2 = Math.max(...want.map((c, k) => Math.abs(c - s.rgb[k])));
    if (err2 > 4) { colorPixBad++; if (bad.length < 4) bad.push(`#${s.id} 期待 ${want.map((c) => c.toFixed(0))} 実際 ${s.rgb}`); }
  }
  const sampledNoise = pix.samples.filter((s) => w2v.coarse[s.id] === W2V_NOISE).length;
  check('画面の点の中心の色が、クラスタの色（霧を含む）と一致する（クラスタなしは灰色）', pix.samples.length >= 30 && colorPixBad === 0,
    `${pix.samples.length} 点中 不一致 ${colorPixBad}（うちクラスタなし ${sampledNoise} 点）${bad.join(' / ')}`);
}

async function testPicking(page) {
  console.log('\n[word2vec のピッキング]');
  const c0 = w2vCoarse[0];
  const views = [
    { name: 'home', ...(await page.evaluate(() => window.__explorer.homeView())) },
    { name: 'inside', ...clusterViews(c0).inside },
  ];
  let seed = 11;
  for (const v of views) {
    await setView(page, v.pos, v.look);
    await waitStill(page);
    const res = await page.evaluate(pageChecks, { samples: 160, seed: seed++, saveImages: false });
    const p = res.picks;
    check(`${v.name}: 小領域と全画面の番号が一致し、通常の描画と形が一致する`, res.failures.length === 0,
      `pick ${p.total} 件（真下 ${p.under}・吸着 ${p.snapped}・null ${p.nullCase}）不一致 ${p.mismatch}、形の食い違い ${res.shape.visOnly + res.shape.idOnly}、点 ${res.distinctIds} 個${res.failures.length ? `、${res.failures.slice(0, 3).join(' / ')}` : ''}`);
  }
}

async function testInteraction(page) {
  console.log('\n[word2vec のホバー・選択・ダブルクリック]');
  const v = clusterViews(w2vCoarse[1]).inside;
  await setView(page, v.pos, v.look);
  await waitStill(page);
  const p = await findVisiblePoint(page, { minPx: 8 });
  if (!p) { check('検証に使う点が見つかる', false); return; }
  await page.mouse.move(p.x, p.y);
  const h = await waitFrames(page, async (pg) => { const s = await ix(pg); return { ok: s.hovered === p.i, s }; });
  const hover = await page.evaluate(() => { const el = document.getElementById('hover-label'); return { hidden: el.hidden, text: el.textContent }; });
  check('点の上にカーソルを置くと、その点の単語がホバーに出る', h.ok && !hover.hidden && hover.text === w2v.text[p.i], `点 #${p.i}、表示 "${hover.text}"、期待 "${w2v.text[p.i]}"`);

  await page.mouse.down();
  await page.mouse.up();
  await waitFrames(page, async (pg) => ({ ok: (await ix(pg)).selected === p.i }));
  const info = await page.evaluate(() => ({
    hidden: document.getElementById('info').hidden,
    kind: document.getElementById('info').dataset.kind,
    label: document.getElementById('info-label').textContent,
    index: document.getElementById('info-index').textContent,
    cluster: document.getElementById('info-cluster').textContent,
    imageHidden: document.getElementById('info-image').hidden,
    imageDisplay: getComputedStyle(document.getElementById('info-image')).display,
    live: document.getElementById('info-live').textContent,
    swatch: getComputedStyle(document.getElementById('info-swatch')).backgroundColor,
  }));
  const cid = w2v.coarse[p.i];
  const clusterName = cid === W2V_NOISE ? 'なし' : w2vCoarse[cid].name;
  const word = w2v.text[p.i];
  check('クリックで選択され、情報パネルに単語・番号・クラスタが出る（画像は出ない）',
    !info.hidden && info.kind === 'text' && info.label === word && info.index === `#${p.i}` && info.cluster === clusterName && info.imageHidden && info.imageDisplay === 'none',
    JSON.stringify(info));
  const [er, eg, eb] = hexRgb(expectedW2vColor(p.i));
  check('情報パネルの色の印が、点の色と一致する', info.swatch === `rgb(${er}, ${eg}, ${eb})`, info.swatch);
  check('読み上げの文が単語のデータに合う（「選択した単語: …」）', info.live === `選択した単語: ${word}、番号 ${p.i}、クラスタ ${clusterName}`, info.live);
  await page.screenshot({ path: path.join(outDir, 'w2v-4-selected.png') });

  // クラスタに属さない点の「なし」
  const noiseIdx = [];
  for (let i = 0; i < w2v.count; i++) if (w2v.coarse[i] === W2V_NOISE) noiseIdx.push(i);
  const home = await page.evaluate(() => window.__explorer.homeView());
  const np = await (async () => {
    // クラスタなしの点を手前に見る視点を作る（クラスタなしの点から少し離れて、その点を見る）
    for (const i of noiseIdx.filter((_, k) => k % 97 === 0)) {
      const P = [w2v.positions[3 * i], w2v.positions[3 * i + 1], w2v.positions[3 * i + 2]];
      const dir = norm(sub(home.pos, P));
      await setView(page, add(P, mul(dir, 0.06)), P);
      await waitStill(page);
      const q = await findVisiblePoint(page, { minPx: 6, filter: [i] });
      if (q) return q;
    }
    return null;
  })();
  if (np) {
    await page.mouse.click(np.x, np.y);
    await waitFrames(page, async (pg) => ({ ok: (await ix(pg)).selected === np.i }));
    const c = await page.evaluate(() => document.getElementById('info-cluster').textContent);
    check('クラスタに属さない点のクラスタは「なし」', c === 'なし', `点 #${np.i}（${w2v.text[np.i]}）: "${c}"`);
  } else {
    check('クラスタに属さない点が見つかる', false);
  }

  // ダブルクリックで飛ぶ
  await setView(page, v.pos, v.look);
  await waitStill(page);
  const q = await findVisiblePoint(page, { minPx: 6 });
  const stop = await page.evaluate((i) => window.__explorer.interaction.stopDistance(i), q.i);
  await page.mouse.dblclick(q.x, q.y);
  await waitFrames(page, async (pg) => ({ ok: len(sub((await state(pg)).position, v.pos)) > 1e-4 }), 10);
  const s = await waitStill(page, 120);
  const P = [w2v.positions[3 * q.i], w2v.positions[3 * q.i + 1], w2v.positions[3 * q.i + 2]];
  const dist = len(sub(s.position, P));
  const proj = await page.evaluate((i) => window.__explorer.picking.project(i), q.i);
  check('ダブルクリックでその点の手前へ飛び、点が画面の中央に見える', Math.abs(dist - stop.distance) < 2e-3 && Math.hypot(proj.clientX - width / 2, proj.clientY - height / 2) < 3 && (await ix(page)).selected === q.i,
    `距離 ${dist.toFixed(4)}（期待 ${stop.distance.toFixed(4)}）、画面上 (${proj.clientX.toFixed(1)}, ${proj.clientY.toFixed(1)})、${proj.sizePx.toFixed(1)}px`);
  await page.keyboard.press('Escape');
  await page.mouse.move(5, height / 2);
}

async function testLabelsMinimapHomeSpeed(page) {
  console.log('\n[word2vec の目印・現在地・ミニマップ・ホーム・速度の自動調整]');
  const home = await page.evaluate(() => window.__explorer.homeView());
  await setView(page, home.pos, home.look);
  await waitStill(page);
  const st = await page.evaluate(() => window.__explorer.labels.getState());
  const shown = st.labels.filter((l) => l.visible);
  check('目印が使え、全体が見える位置で複数の目印が出る', st.available && st.labels.length === w2vCoarse.length && shown.length >= 6, `${shown.length} / ${st.labels.length} 個`);
  const chips = await page.evaluate(() => [...document.querySelectorAll('.cluster-label')].map((e) => ({
    id: Number(e.dataset.clusterId), c: getComputedStyle(e).getPropertyValue('--c').trim().toLowerCase(), text: e.querySelector('.cluster-label-name').textContent, aria: e.getAttribute('aria-label'),
    w: e.getBoundingClientRect().width, terms: e.classList.contains('is-terms'),
  })));
  const colorOk = chips.every((c) => c.c === PALETTE[c.id % PALETTE.length]);
  check('目印の色がクラスタの番号から決めた色（点の色と同じ）', colorOk, chips.slice(0, 4).map((c) => `${c.id}:${c.c}`).join(' '));
  const textOk = chips.every((c) => c.terms && c.aria === `${w2vCoarse[c.id].name} のクラスタへ移動` && c.text === w2vCoarse[c.id].terms.join(' · ') && c.w <= 260);
  check('長い名前（代表の単語 3 語）を目印の幅（260px 以下）に収め、読み上げ名は全体', textOk, chips.slice(0, 3).map((c) => `${c.text}（${c.w.toFixed(0)}px）`).join(' / '));
  await page.screenshot({ path: path.join(outDir, 'w2v-1-overview.png') });

  // 目印のクリックで飛ぶ
  const target = shown.sort((a, b) => a.distance - b.distance)[1];
  const c = w2vCoarse[target.id];
  const s0 = await state(page);
  await page.locator(`.cluster-label[data-cluster-id="${target.id}"]`).click();
  await waitFrames(page, async (pg) => ({ ok: len(sub((await state(pg)).position, s0.position)) > 1e-6 }), 10);
  const s = await waitStill(page, 120);
  const expected = 1.15 * c.radius / Math.sin(Math.min(Math.PI / 6, Math.atan(Math.tan(Math.PI / 6) * (width / height))));
  check(`目印（${c.name}）のクリックで、そのクラスタの手前へ飛ぶ`, Math.abs(len(sub(s.position, c.center)) - expected) < 1e-3, `距離 ${len(sub(s.position, c.center)).toFixed(4)}、期待 ${expected.toFixed(4)}`);
  const ev = clusterViews(c).edge;
  await setView(page, ev.pos, ev.look);
  await waitStill(page);
  await page.screenshot({ path: path.join(outDir, 'w2v-2-edge.png') });

  // 内部で現在地
  const iv = clusterViews(c).inside;
  await setView(page, iv.pos, iv.look);
  await waitStill(page);
  const loc = await page.evaluate(() => ({ s: window.__explorer.labels.getState().location, hidden: document.getElementById('cluster-location').hidden, text: document.getElementById('cluster-location').innerText }));
  check('クラスタの内部で現在地が出る', loc.s.kind === 'inside' && !loc.hidden && loc.text.includes(c.name), JSON.stringify(loc.text));
  await page.screenshot({ path: path.join(outDir, 'w2v-3-inside.png') });

  // ミニマップ
  const mm = await page.evaluate(() => {
    const m = window.__explorer.minimap;
    const st = m.getState();
    const f = m.readFrame(true);
    const r = st.map;
    const counts = new Map();
    let colored = 0;
    for (let y = Math.ceil(r.top) + 2; y < r.top + r.height - 2; y++) for (let x = Math.ceil(r.left) + 2; x < r.left + r.width - 2; x++) {
      const o = 4 * (y * f.width + x);
      const key = `${f.rgba[o]},${f.rgba[o + 1]},${f.rgba[o + 2]}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const panel = sorted[0][0];
    for (const [k, n] of sorted) if (k !== panel) colored += n;
    return { visible: st.visible, pointCount: st.pointCount, camera: st.camera, map: r, colored, total: r.width * r.height };
  });
  const camIn = !mm.camera.outside && mm.camera.x >= mm.map.left && mm.camera.x <= mm.map.left + mm.map.width && mm.camera.y >= mm.map.top && mm.camera.y <= mm.map.top + mm.map.height;
  check('ミニマップに点群（1 万点）とカメラの印が出る', mm.visible && mm.pointCount === 10000 && mm.colored > 0.1 * mm.total && camIn,
    `点の画素 ${mm.colored} / ${mm.total}、カメラ (${mm.camera.x.toFixed(1)}, ${mm.camera.y.toFixed(1)})`);
  const camMark = await page.evaluate(() => { const e = document.querySelector('#minimap .mm-camera'); return e ? getComputedStyle(e).display !== 'none' && e.getAttribute('visibility') !== 'hidden' : false; });
  check('ミニマップのカメラの印（白い丸）が表示されている', camMark);

  // 速度の自動調整: 内部では遅く、外では速い
  const inside = await waitFrames(page, async (pg) => { const st2 = await state(pg); return { ok: st2.autoSpeed.distance !== null, st2 }; });
  await frames(page, 20);
  const sIn = await state(page);
  // H でホームへ
  await page.mouse.move(5, height / 2);
  await page.keyboard.press('KeyH');
  const started = await waitFrames(page, async (pg) => ({ ok: (await state(pg)).homing }), 5);
  const sHome = await waitStill(page, 120);
  const homeNow = await page.evaluate(() => window.__explorer.homeView());
  check('H キーでホームの視点へ戻る', started.ok && len(sub(sHome.position, homeNow.pos)) < 1e-4, `ホームまでの距離 ${len(sub(sHome.position, homeNow.pos)).toExponential(2)}`);
  await frames(page, 30);
  const sOut = await state(page);
  check('速度の自動調整が働く（クラスタの内部で遅く、点群の外で速い）', inside.ok && sIn.autoSpeed.available && sIn.autoSpeed.enabled && sIn.autoSpeed.scale < 0.6 && sOut.autoSpeed.scale > 2,
    `内部の係数 ${sIn.autoSpeed.scale.toFixed(3)}（距離 ${sIn.autoSpeed.distance?.toFixed(4)}）、ホームの係数 ${sOut.autoSpeed.scale.toFixed(3)}`);
}

/** window と canvas に付いているイベントのリスナーの数（CDP の DOMDebugger.getEventListeners）。 */
async function listenerCounts(page, cdp) {
  const count = async (expr) => {
    const { result } = await cdp.send('Runtime.evaluate', { expression: expr });
    const { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId, depth: 0 });
    await cdp.send('Runtime.releaseObject', { objectId: result.objectId });
    const by = {};
    for (const l of listeners) by[l.type] = (by[l.type] ?? 0) + 1;
    return { total: listeners.length, by };
  };
  return {
    window: await count('window'),
    canvas: await count('document.querySelector("#app canvas")'),
    document: await count('document'),
    infoClose: await count('document.getElementById("info-close")'),
  };
}

async function heapAfterGc(cdp) {
  for (let k = 0; k < 3; k++) await cdp.send('HeapProfiler.collectGarbage');
  const { usedSize } = await cdp.send('Runtime.getHeapUsage');
  return usedSize;
}

async function selectViaUi(page, id) {
  const g = (await ds(page)).generation;
  await page.selectOption('#dataset-select', id);
  // 読み込み中は「読み込み中…」と出て、選択欄は無効になる
  const during = await page.evaluate(() => ({ status: document.getElementById('dataset-status').textContent, disabled: document.getElementById('dataset-select').disabled }));
  const after = await waitSwitched(page, g);
  return { during, after };
}

async function testSwitching(page, cdp) {
  console.log('\n[選択欄での切り替え]');
  // word2vec で点を選んでおく（切り替えで消えること）
  const v = clusterViews(w2vCoarse[2]).inside;
  await setView(page, v.pos, v.look);
  await waitStill(page);
  const p = await findVisiblePoint(page, { minPx: 6 });
  if (p) { await page.mouse.click(p.x, p.y); await waitFrames(page, async (pg) => ({ ok: (await ix(pg)).selected === p.i })); }

  const r1 = await selectViaUi(page, 'mnist');
  check('選択欄で MNIST へ切り替えられ、読み込み中であることが出る', r1.after.current?.id === 'mnist' && r1.after.error === null && r1.during.status === '読み込み中…' && r1.during.disabled,
    `${JSON.stringify(r1.during)} → ${JSON.stringify(r1.after.current)}`);
  const m = await page.evaluate(() => ({
    url: location.search, dotsOnly: window.__explorer.pointCloud.dotsOnly, size: window.__explorer.pointCloud.params.pointSize,
    hud: window.__explorer.hud.getState().detail[0], labels: window.__explorer.labels.getState().labels.length,
    sel: window.__explorer.interaction.getState(), info: document.getElementById('info').hidden, ready: window.__explorer.ready,
    chips: document.querySelectorAll('.cluster-label').length, minimaps: document.querySelectorAll('#minimap').length,
    focus: document.activeElement?.id ?? document.activeElement?.tagName,
  }));
  const homeM = await page.evaluate(() => window.__explorer.homeView());
  const sM = await state(page);
  check('MNIST が正しく表示される（画像と丸い点、大きさ 0.004、目印 10 個、URL が ?data=mnist、視点はホーム）',
    m.url === '?data=mnist' && m.dotsOnly === false && m.size === 0.004 && m.hud.startsWith('MNIST') && m.labels === 10 && m.chips === 10 && m.minimaps === 1 && m.ready && len(sub(sM.position, homeM.pos)) < 1e-6,
    JSON.stringify(m));
  check('切り替えで、前のデータの選択が消える（情報パネルも隠れる）', m.sel.selected === null && m.sel.hovered === null && m.info, JSON.stringify(m.sel));
  check('切り替えたあと、選択欄からフォーカスが外れ、キー操作が効く', m.focus !== 'dataset-select', String(m.focus));

  // MNIST の点のホバーは MNIST のラベル（数字）になる
  const mv = await page.evaluate(() => window.__explorer.homeView());
  await setView(page, mv.pos, mv.look);
  await waitStill(page);
  const mp = await findVisiblePoint(page, { minPx: 3 });
  if (mp) {
    await page.mouse.move(mp.x, mp.y);
    const h = await waitFrames(page, async (pg) => { const s = await ix(pg); return { ok: s.hovered === mp.i, s }; });
    const label = await page.evaluate(() => document.getElementById('hover-label').textContent);
    const want = mnist.manifest.labels.names[mnist.labels[mp.i]];
    check('切り替え後のホバーは新しいデータの点（MNIST の数字）', h.ok && label === want, `点 #${mp.i}、ホバー ${h.s.hovered}、"${label}"（期待 "${want}"）`);
    await page.mouse.click(mp.x, mp.y);
    await waitFrames(page, async (pg) => ({ ok: (await ix(pg)).selected === mp.i }));
    const info = await page.evaluate(() => ({ label: document.getElementById('info-label').textContent, img: !document.getElementById('info-image').hidden, kind: document.getElementById('info').dataset.kind }));
    check('MNIST では情報パネルに画像とラベルが出る', info.img && info.kind === 'image' && info.label === want, JSON.stringify(info));
    await page.mouse.move(5, height / 2);
  } else {
    check('MNIST でホバーの検証に使う点が見つかる', false);
  }

  // ブラウザの戻る
  const g = (await ds(page)).generation;
  await page.goBack();
  const back = await waitSwitched(page, g);
  check('ブラウザの戻るで、前のデータセット（word2vec）へ戻る', back.current?.id === 'word2vec-10k' && (await page.evaluate(() => document.getElementById('dataset-select').value)) === 'word2vec-10k', JSON.stringify(back.current));

  // ---- 往復を繰り返して、資源とリスナーが増え続けないこと ----
  const samples = [];
  for (let k = 1; k <= rounds; k++) {
    const a = await selectViaUi(page, 'mnist');
    const mm = await page.evaluate(() => ({ mem: window.__explorer.memory(), labels: window.__explorer.labels.getState().labels.length }));
    const b = await selectViaUi(page, 'word2vec-10k');
    await frames(page, 3);
    const ww = await page.evaluate(() => ({ mem: window.__explorer.memory(), labels: window.__explorer.labels.getState().labels.length }));
    const heap = await heapAfterGc(cdp);
    const listeners = await listenerCounts(page, cdp);
    samples.push({ k, mnist: mm, w2v: ww, heap, listeners, ok: a.after.current?.id === 'mnist' && b.after.current?.id === 'word2vec-10k' && mm.labels === 10 && ww.labels === w2vCoarse.length });
    console.log(`  往復 ${k}: MNIST ${JSON.stringify(mm.mem)} / word2vec ${JSON.stringify(ww.mem)} / ヒープ ${(heap / 1048576).toFixed(1)} MB / リスナー window ${listeners.window.total}・canvas ${listeners.canvas.total}・document ${listeners.document.total}・× ${listeners.infoClose.total}`);
  }
  check(`${rounds} 往復とも、それぞれのデータセットが正しく表示される`, samples.every((s) => s.ok));
  const first = samples[0], lastS = samples[samples.length - 1];
  const memSame = samples.every((s) => JSON.stringify(s.mnist.mem) === JSON.stringify(first.mnist.mem) && JSON.stringify(s.w2v.mem) === JSON.stringify(first.w2v.mem));
  check('WebGL のテクスチャ・ジオメトリ（バッファ）・プログラムの数が往復で増えない', memSame, `1 回目 ${JSON.stringify(first.w2v.mem)}、${rounds} 回目 ${JSON.stringify(lastS.w2v.mem)}`);
  const heapGrowth = lastS.heap - samples[Math.min(1, samples.length - 1)].heap;
  check('JS のヒープ（GC 後）が往復で増え続けない（2 回目から最後までの増加が 3 MB 未満）', heapGrowth < 3 * 1048576,
    samples.map((s) => `${(s.heap / 1048576).toFixed(1)}`).join(' → ') + ' MB');
  const lsSame = samples.every((s) => JSON.stringify(s.listeners) === JSON.stringify(first.listeners));
  check('イベントのリスナー（window・document・canvas・閉じるボタン）の数が往復で変わらない', lsSame,
    `window ${JSON.stringify(first.listeners.window.by)}、canvas ${first.listeners.canvas.total}、× ${first.listeners.infoClose.total}`);
  check('閉じるボタンのリスナーは 1 つだけ（前のデータの情報パネルのものが残らない）', first.listeners.infoClose.total === 1, String(first.listeners.infoClose.total));
}

async function testErrors(browser, base, page) {
  console.log('\n[存在しないデータセット]');
  const before = await ds(page);
  const r1 = await page.evaluate(() => window.__explorer.dataset.switchTo('no-such-dataset'));
  await frames(page, 2);
  const ui1 = await page.evaluate(() => ({ status: document.getElementById('dataset-status').textContent, hidden: document.getElementById('dataset-status').hidden, select: document.getElementById('dataset-select').value, disabled: document.getElementById('dataset-select').disabled }));
  const after1 = await ds(page);
  check('一覧にない id を指定すると、エラーが表示され、表示中のデータセットを保つ', !r1.ok && /一覧にありません/.test(ui1.status) && !ui1.hidden && ui1.select === before.current.id && !ui1.disabled && after1.current.id === before.current.id && after1.generation === before.generation,
    `${ui1.status}`);
  const r2 = await page.evaluate(() => window.__explorer.dataset.switchTo('data/nope-dataset/'));
  await frames(page, 2);
  const ui2 = await page.evaluate(() => document.getElementById('dataset-status').textContent);
  const after2 = await ds(page);
  check('存在しない場所を指定すると、エラーが表示され、表示中のデータセットを保つ', !r2.ok && /失敗/.test(ui2) && after2.current.id === before.current.id, ui2);
  // 操作できる状態を保つ: W で進み、ホバーが働く
  const s0 = await state(page);
  await page.mouse.move(5, height / 2);
  await page.keyboard.down('KeyW');
  await frames(page, 5);
  await page.keyboard.up('KeyW');
  const s1 = await state(page);
  const p = await (async () => { const home = await page.evaluate(() => window.__explorer.homeView()); await setView(page, home.pos, home.look); await waitStill(page); return findVisiblePoint(page, { minPx: 3 }); })();
  let hoverOk = false;
  if (p) { await page.mouse.move(p.x, p.y); hoverOk = (await waitFrames(page, async (pg) => ({ ok: (await ix(pg)).hovered === p.i }))).ok; await page.mouse.move(5, height / 2); }
  check('失敗のあとも操作できる（W で進み、ホバーが働く）', len(sub(s1.position, s0.position)) > 1e-4 && hoverOk);
  // 次の切り替えでエラーの表示が消える
  const r3 = await selectViaUi(page, 'mnist');
  const st3 = await page.evaluate(() => document.getElementById('dataset-status').hidden);
  check('次の切り替えが成功すると、エラーの表示が消える', r3.after.current.id === 'mnist' && st3);

  // 起動時に存在しないデータセットを指定
  const p2 = await openPage(browser, base, 'data=no-such-dataset');
  const e2 = await p2.evaluate(() => ({ ready: window.__explorer.ready, error: window.__explorer.error, hud: document.getElementById('hud').innerText, hudError: document.getElementById('hud').classList.contains('error'), status: document.getElementById('dataset-status').textContent, switcher: !document.getElementById('dataset-switcher').hidden, disabled: document.getElementById('dataset-select').disabled }));
  check('起動時に存在しないデータセットを指定すると、エラーが表示され、選択欄は使える', !e2.ready && /一覧にありません/.test(e2.error) && e2.hudError && /失敗/.test(e2.hud) && e2.switcher && !e2.disabled, JSON.stringify(e2));
  const g = (await ds(p2)).generation;
  await p2.selectOption('#dataset-select', 'word2vec-10k');
  const after = await waitSwitched(p2, g);
  const ready = await p2.evaluate(() => ({ ready: window.__explorer.ready, error: window.__explorer.error ?? null, hudError: document.getElementById('hud').classList.contains('error'), url: location.search }));
  check('そのあと選択欄で開くと、使える状態になる（ready、HUD のエラーが消え、URL が更新される）', after.current?.id === 'word2vec-10k' && ready.ready && ready.error === null && !ready.hudError && ready.url === '?data=word2vec-10k', JSON.stringify(ready));
  await p2.close();
}

/** ホームの視点から W を押し続けて止まるまでの移動距離（キーのリスナーが二重に登録されていると 2 倍になる）。 */
async function holdWDistance(page) {
  await page.evaluate(() => window.__explorer.setView(window.__explorer.homeView()));
  await waitStill(page);
  const s0 = await state(page);
  await page.keyboard.down('KeyW');
  await frames(page, 6);
  await page.keyboard.up('KeyW');
  const s1 = await waitStill(page);
  return len(sub(s1.position, s0.position));
}

async function testFailureHandling(browser, base) {
  console.log('\n[単語の文字・表示の生成の失敗]');
  // 対照: 文字が生成できる通常の表示（word2vec）での、W の移動量
  const ctl = await openPage(browser, base, 'data=word2vec-10k');
  const dNormal = await holdWDistance(ctl);
  check('（対照）word2vec を通常どおり表示し、W で前へ進める', dNormal > 1e-3 && (await ctl.evaluate(() => window.__explorer.words.getState())) !== null, `移動 ${dNormal.toFixed(4)}`);

  // 単語の文字の生成だけを失敗させる（MNIST から word2vec へ切り替えるときに生成される）
  const page = await openPage(browser, base, 'data=mnist');
  await page.evaluate(() => { window.__explorer.faults.words = 1; });
  const gen = (await ds(page)).generation;
  const r = await page.evaluate(() => window.__explorer.dataset.switchTo('word2vec-10k'));
  const d = await waitSwitched(page, gen);
  const hud = await page.evaluate(() => document.getElementById('hud').innerText);
  const words = await page.evaluate(() => window.__explorer.words.getState());
  const notice = await page.evaluate(() => window.__explorer.notice());
  const dots = await page.evaluate(() => ({ dotsOnly: window.__explorer.pointCloud.dotsOnly, count: window.__explorer.picking.count }));
  check('単語の文字の生成が失敗しても、表示全体は失敗にならず、word2vec が表示される', r.ok && d.error === null && d.current?.id === 'word2vec-10k' && d.generation === gen + 1, JSON.stringify({ r, current: d.current }));
  check('文字なし（丸い点だけ）で表示が続く（文字の状態が null、全点が丸い点）', words === null && dots.dotsOnly && dots.count === 10000, JSON.stringify({ words, dots }));
  check('利用者に分かる形で知らせる（HUD に、文字を表示できない旨と丸い点だけで表示している旨）', /単語の文字を表示できません/.test(hud) && /丸い点だけ/.test(hud) && notice !== null && !/K 単語の文字/.test(hud), hud.split('\n').slice(-1)[0]);
  await page.keyboard.press('KeyK'); // 文字のないデータセットでも、K キーで何も壊れない
  await frames(page, 2);
  const dFail = await holdWDistance(page);
  check('キーでの移動量が通常と同じ（2 倍になっていない）', dFail > 1e-3 && dFail / dNormal > 0.8 && dFail / dNormal < 1.25, `文字の失敗後 ${dFail.toFixed(4)}、通常 ${dNormal.toFixed(4)}（比 ${(dFail / dNormal).toFixed(2)}）`);
  const msg = await page.evaluate(() => document.getElementById('dataset-status').textContent);
  check('切り替えのエラーは出ない（選択欄の横に失敗の文がない）', msg === '', msg);

  // 表示の生成そのものを失敗させる: 前のデータで作り直して表示を保ち、リスナーが二重にならない
  const cdp = await page.context().newCDPSession(page);
  await page.evaluate(() => { window.__explorer.faults.words = 0; });
  const gen2 = (await ds(page)).generation;
  const lsBefore = await listenerCounts(page, cdp);
  await page.evaluate(() => { window.__explorer.faults.view = 1; });
  const r2 = await page.evaluate(() => window.__explorer.dataset.switchTo('mnist'));
  const d2 = await waitSwitched(page, gen2);
  const lsAfter = await listenerCounts(page, cdp);
  check('表示の生成を失敗させると、エラーを報告し、前のデータ（word2vec）の表示を保つ', !r2.ok && /検証用/.test(r2.error ?? '') && d2.current?.id === 'word2vec-10k' && d2.generation === gen2 && d2.error !== null, JSON.stringify({ r2, current: d2.current }));
  const same = JSON.stringify(lsAfter) === JSON.stringify(lsBefore);
  check('失敗して作り直したあとも、イベントのリスナー（window・document・canvas）の数が失敗の前と同じ（二重に登録されない）', same, same ? `window ${lsAfter.window.total}、canvas ${lsAfter.canvas.total}` : `前 ${JSON.stringify(lsBefore)} 後 ${JSON.stringify(lsAfter)}`);
  const dRebuilt = await holdWDistance(page);
  check('作り直したあとのキーでの移動量が通常と同じ（2 倍になっていない）', dRebuilt > 1e-3 && dRebuilt / dNormal > 0.8 && dRebuilt / dNormal < 1.25, `${dRebuilt.toFixed(4)}（通常 ${dNormal.toFixed(4)}、比 ${(dRebuilt / dNormal).toFixed(2)}）`);
  const hover = await page.evaluate(() => document.querySelectorAll('#cluster-labels > *').length);
  check('目印の要素が二重に残らない（作りかけの表示の DOM を破棄している）', hover === w2vCoarse.length, `${hover} 個（クラスタ ${w2vCoarse.length}）`);
  // そのあと、通常どおり切り替えられる
  const gen3 = (await ds(page)).generation;
  const r3 = await page.evaluate(() => window.__explorer.dataset.switchTo('mnist'));
  const d3 = await waitSwitched(page, gen3);
  check('そのあとの切り替えは成功する（MNIST が表示され、エラーが消える）', r3.ok && d3.current?.id === 'mnist' && d3.error === null, JSON.stringify(d3.current));
  await ctl.close();
  await page.close();
}

async function main() {
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
    if (args.includes('--only-failure')) { // 失敗の検証だけ（開発中の繰り返し用）
      await testFailureHandling(browser, base);
    } else {
      const page = await openPage(browser, base, 'data=word2vec-10k');
      // 近くの単語の文字（src/text/。words.cjs で検証する）は、ここでは無効にして、丸い点の形と点の同一性を確かめる
      // （K キーと同じ切り替え。データセットを切り替えても保つ）
      await page.evaluate(() => window.__explorer.words.setEnabled(false));
      const cdp = await page.context().newCDPSession(page);
      await testWord2vecDisplay(page);
      await testPicking(page);
      await testInteraction(page);
      await testLabelsMinimapHomeSpeed(page);
      await testSwitching(page, cdp);
      await testErrors(browser, base, page);
      await page.close();
      await testFailureHandling(browser, base);
    }
  } finally {
    if (browser) await browser.close();
    stop();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(consoleErrors.length ? `\nコンソールエラー ${consoleErrors.length} 件:\n${consoleErrors.join('\n')}` : '\nコンソールエラー: なし');
  console.log(`結果: ${results.length - failed.length} / ${results.length} 合格${failed.length ? `（失敗: ${failed.map((f) => f.name).join(' / ')}）` : ''}`);
  process.exitCode = failed.length || consoleErrors.length ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exit(1); });
