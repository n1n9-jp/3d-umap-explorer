#!/usr/bin/env node
/**
 * 近くの単語の文字（src/text/）の検証。`?data=word2vec-10k` で、ヘッドレス Chromium へ実際のマウス・キーの入力を送る。
 *
 *   node scripts/verify/words.cjs [--no-build] [--port 4340] [--out artifacts/words]
 *
 * 確かめること:
 *   - クラスタの内部の視点で、単語が文字として描かれる（表示中の単語の数が 0 より多く、上限以下）。表示中の単語の画面上の矩形が互いに重ならない
 *   - 表示中の単語の位置が、その点を投影した位置と一致する（番号の画像で、文字の画素がその単語の矩形の中にある）。
 *     文字の画素の色が、その点の色（霧を含む）と一致する。文字を出している点の丸い点は消えている
 *   - 番号の画像で、文字の画素がその点の番号になる。通常の描画と番号の画像の形が（輪郭の 2 画素を除いて）一致する。
 *     文字の画素で pick するとその点が真下に返る。文字の上でホバー・クリックすると、その点がホバー・選択され、強調が単語を囲む矩形になる
 *   - カメラが止まっている間、表示する単語の集合が変わらない（選び直しもしない）。カメラを小さく往復させても、表示と非表示が切り替わり続けない
 *   - deviceScaleFactor 1 と 2 で、文字の見かけの大きさ（CSS ピクセル）が同じ
 *   - 奥の単語が、手前の点に正しく隠れる（手前の点の中心の画素は、奥の単語の番号にならない）
 *   - 全体が見える視点（遠方）では、文字が出ず、丸い点だけで描かれる
 *   - K キーで文字が消え（丸い点に戻る）、もう一度押すと戻る。HUD の操作説明に K キーがある
 *   - MNIST へ切り替えると、単語のメッシュとアトラスが解放される（往復しても WebGL のテクスチャとジオメトリの数が増え続けない）。MNIST では働かない
 *   - 選び直し 1 回の時間、グリフアトラスの生成時間、フレーム時間（文字の表示の有無）を出力する（ソフトウェア描画なので参考値）
 *   - コンソールエラーがない
 * スクリーンショット（クラスタの縁・内部・内部の密な場所・点を選択した状態）を --out に保存する。失敗があれば終了コード 1 で終わる。
 */
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { loadDataset, computeViews, waitForServer, startPreview, CHROMIUM_ARGS, sub, add, mul, len, norm } = require('./lib.cjs');

const root = path.resolve(__dirname, '../..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const outDir = path.resolve(root, opt('out', 'artifacts/words'));
const port = Number(opt('port', '4340'));
const width = 1280, height = 800;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const metrics = {};

// ---------- 期待値（アプリのコードとは別に、ソースとデータから読む） ----------

const paletteSrc = fs.readFileSync(path.join(root, 'src/render/palette.ts'), 'utf8');
const PALETTE = [...paletteSrc.slice(paletteSrc.indexOf('LABEL_COLORS'), paletteSrc.indexOf('];')).matchAll(/'(#[0-9a-f]{6})'/gi)].map((m) => m[1].toLowerCase());
const NOISE = /NOISE_COLOR = '(#[0-9a-f]{6})'/i.exec(fs.readFileSync(path.join(root, 'src/render/colorScheme.ts'), 'utf8'))[1].toLowerCase();
const w2v = loadDataset(path.join(root, 'public/data/word2vec-10k'));
const W2V_NOISE = w2v.manifest.clusters.noise;
const expectedColor = (i) => (w2v.coarse[i] === W2V_NOISE ? NOISE : PALETTE[w2v.coarse[i] % PALETTE.length]);
const { views: libViews } = computeViews(w2v);
const VIEWS = Object.fromEntries(libViews.map((v) => [v.name.replace(/^\d-/, ''), v]));

// ---------- ページの操作 ----------

const consoleErrors = [];

async function openPage(browser, base, query, dpr = 1) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: dpr });
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`[error] ${m.text()} ${m.location()?.url ?? ''}`); });
  page.on('pageerror', (e) => consoleErrors.push(`[pageerror] ${e.message}`));
  page.on('requestfailed', (r) => consoleErrors.push(`[requestfailed] ${r.url()}`));
  await page.goto(`${base}?${query}`);
  await page.waitForFunction(() => window.__explorer && (window.__explorer.ready || window.__explorer.error), null, { timeout: 120000 });
  return page;
}

const state = (page) => page.evaluate(() => window.__explorer.getState());
const words = (page) => page.evaluate(() => window.__explorer.words.getState());
const ix = (page) => page.evaluate(() => window.__explorer.interaction.getState());
const frames = (page, n) => page.evaluate((k) => window.__explorer.measureFrames(k), n);
const setView = (page, v) => page.evaluate((x) => window.__explorer.setView(x), { pos: v.pos, look: v.look });
const shownKey = (s) => s.shown.map((w) => w.index).sort((a, b) => a - b).join(',');

/** カメラが動かなくなるまで待つ。 */
async function waitStill(page, maxFrames = 80) {
  let prev = await state(page);
  for (let k = 0; k < maxFrames; k++) {
    await frames(page, 1);
    const s = await state(page);
    if (!s.homing && len(sub(s.position, prev.position)) < 1e-9 && len(sub(s.direction, prev.direction)) < 1e-9) return s;
    prev = s;
  }
  return prev;
}

/** カメラが止まり、単語の選び直しと表示の切り替えが終わる（表示中の集合が 3 フレーム続けて同じで、切り替え中の単語がない）まで待つ。 */
async function waitWords(page, maxFrames = 60) {
  await waitStill(page);
  let prev = null, same = 0, s = null;
  for (let k = 0; k < maxFrames; k++) {
    await frames(page, 1);
    s = await words(page);
    if (!s) return null;
    const key = shownKey(s);
    same = key === prev && s.fading === 0 && s.drawnWords === s.shown.length ? same + 1 : 0;
    prev = key;
    if (same >= 3) return s;
  }
  return s;
}

/**
 * ページの中で、表示中の単語ごとに、番号の画像と通常の描画を調べる。
 * - 文字の画素（番号がその点の画素）の外接矩形と、単語の矩形（選んだときの画面上の位置）の関係
 * - 内側の画素（3×3 が同じ番号）の色と、その点の色（霧を含む）
 * - 投影した点の位置と、単語の基準点
 * - 通常の描画と番号の画像の形の一致（輪郭の 2 画素を除く）
 */
/* eslint-disable no-undef */
async function analyze() {
  const ex = window.__explorer, dbg = ex.picking;
  const ws = ex.words.getState();
  const frame = dbg.readFrame();
  const img = await dbg.readIdImage();
  const { width: W, height: H, ids } = img;
  const scale = dbg.bufferScale();
  const fog = ex.pointCloud.mesh.material.uniforms.uFog.value;
  const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const BG = [7, 8, 12];
  const byId = new Map(ws.shown.map((w) => [w.index, { w, n: 0, minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }]));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const s = byId.get(ids[y * W + x]);
    if (!s) continue;
    s.n++;
    s.minX = Math.min(s.minX, x); s.maxX = Math.max(s.maxX, x + 1);
    s.minY = Math.min(s.minY, y); s.maxY = Math.max(s.maxY, y + 1);
  }
  const perWord = [];
  let colorSamples = 0, colorBad = 0, maxColorErr = 0;
  const colorBadEx = [];
  let anchorErr = 0;
  const dotScales = ex.pointCloud.dotScales;
  let dotsNotHidden = 0;
  for (const s of byId.values()) {
    const w = s.w;
    const p = dbg.project(w.index);
    anchorErr = Math.max(anchorErr, Math.hypot(p.clientX - w.anchorX, p.clientY - w.anchorY));
    if (dotScales[w.index] !== 0) dotsNotHidden++;
    const r = w.rect;
    const bbox = s.n ? { x0: s.minX / scale, y0: s.minY / scale, x1: s.maxX / scale, y1: s.maxY / scale } : null;
    const outside = bbox ? Math.max(0, (r.x - r.width / 2) - bbox.x0, bbox.x1 - (r.x + r.width / 2), (r.y - r.height / 2) - bbox.y0, bbox.y1 - (r.y + r.height / 2)) : 0;
    // 色: 内側の画素（3×3 が同じ番号）
    const want = hex(ex.dataset.pointColor(w.index));
    const f = fog.z * (1 - Math.exp(-Math.max(w.distance - fog.x, 0) / fog.y));
    const wantRgb = want.map((c, k) => c * (1 - f) + BG[k] * f);
    let samples = 0;
    if (bbox) {
      for (let y = Math.max(1, s.minY); y < Math.min(H - 1, s.maxY) && samples < 40; y++) for (let x = Math.max(1, s.minX); x < Math.min(W - 1, s.maxX) && samples < 40; x++) {
        let solid = true;
        for (let dy = -1; dy <= 1 && solid; dy++) for (let dx = -1; dx <= 1; dx++) if (ids[(y + dy) * W + x + dx] !== w.index) { solid = false; break; }
        if (!solid) continue;
        const o = 4 * (y * W + x);
        const err = Math.max(...wantRgb.map((c, k) => Math.abs(c - frame.rgba[o + k])));
        samples++; colorSamples++;
        maxColorErr = Math.max(maxColorErr, err);
        if (err > 6) { colorBad++; if (colorBadEx.length < 4) colorBadEx.push(`${w.text} (${x},${y}) 期待 ${wantRgb.map((c) => c.toFixed(0))} 実際 ${Array.from(frame.rgba.subarray(o, o + 3))}`); }
      }
    }
    perWord.push({ index: w.index, text: w.text, n: s.n, rect: r, bbox, outside, textPx: w.textPx, distance: w.distance,
      glyphHeightCss: bbox ? bbox.y1 - bbox.y0 : 0, colorSamples: samples });
  }

  // 形の一致（picking.cjs と同じ規則: 背景から 12 より離れた画素と、番号のある画素。輪郭の 2 画素は除く）
  const T = 12;
  const vis = new Uint8Array(W * H), nz = new Uint8Array(W * H);
  for (let k = 0; k < W * H; k++) {
    const o = 4 * k;
    vis[k] = Math.max(Math.abs(frame.rgba[o] - BG[0]), Math.abs(frame.rgba[o + 1] - BG[1]), Math.abs(frame.rgba[o + 2] - BG[2])) > T ? 1 : 0;
    nz[k] = ids[k] >= 0 ? 1 : 0;
  }
  const edge = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const k = y * W + x;
    const dx = x + 1 < W && (nz[k] !== nz[k + 1] || vis[k] !== vis[k + 1]);
    const dy = y + 1 < H && (nz[k] !== nz[k + W] || vis[k] !== vis[k + W]);
    if (dx || dy) { edge[k] = 1; if (dx) edge[k + 1] = 1; if (dy) edge[k + W] = 1; }
  }
  const near = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!edge[y * W + x]) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < W && yy < H) near[yy * W + xx] = 1;
    }
  }
  // 単語の矩形の内側だけを数える（文字の形の一致。点群の丸い点は picking.cjs・datasets.cjs が確かめる）
  const inWord = new Uint8Array(W * H);
  for (const s of byId.values()) {
    const r = s.w.rect;
    const x0 = Math.max(0, Math.floor((r.x - r.width / 2) * scale)), x1 = Math.min(W, Math.ceil((r.x + r.width / 2) * scale));
    const y0 = Math.max(0, Math.floor((r.y - r.height / 2) * scale)), y1 = Math.min(H, Math.ceil((r.y + r.height / 2) * scale));
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) inWord[y * W + x] = 1;
  }
  let visOnly = 0, idOnly = 0, wordVisOnly = 0, wordIdOnly = 0, wordPixels = 0;
  const diffEx = [];
  for (let k = 0; k < W * H; k++) {
    if (inWord[k]) wordPixels++;
    if (vis[k] === nz[k] || near[k]) continue;
    if (vis[k]) visOnly++; else idOnly++;
    if (inWord[k]) { if (vis[k]) wordVisOnly++; else wordIdOnly++; }
    if (diffEx.length < 6) diffEx.push(`(${k % W},${Math.floor(k / W)}) rgb ${Array.from(frame.rgba.subarray(4 * k, 4 * k + 3))} id ${ids[k]}`);
  }

  // 手前の点に隠れる: 表示中の単語の矩形の中に中心が入る、単語より手前の点（丸い点が見えている）の中心の画素は、その単語の番号にならない
  let occluders = 0, occludedWrong = 0;
  const occEx = [];
  const shownSet = new Set(ws.shown.map((w) => w.index));
  const proj = [];
  for (let i = 0; i < dbg.count; i++) proj.push(dbg.project(i));
  for (const w of ws.shown) {
    const r = w.rect;
    for (let i = 0; i < dbg.count; i++) {
      if (shownSet.has(i) || dotScales[i] < 1) continue;
      const p = proj[i];
      if (p.depth <= 0 || p.faded || p.distance >= w.distance * 0.97 || p.sizePx < 4) continue;
      if (Math.abs(p.clientX - r.x) > r.width / 2 || Math.abs(p.clientY - r.y) > r.height / 2) continue;
      const px = Math.floor(p.clientX * scale), py = Math.floor(p.clientY * scale);
      if (px < 0 || py < 0 || px >= W || py >= H) continue;
      occluders++;
      if (ids[py * W + px] === w.index) { occludedWrong++; if (occEx.length < 4) occEx.push(`${w.text} の前の点 #${i}`); }
    }
  }
  // 奥の点が単語の後ろに隠れる: 単語の矩形の中に中心が入る、単語より奥の点のうち、中心の画素が単語の番号のもの（文字の本体が点を隠している）
  let hiddenBehind = 0;
  for (const w of ws.shown) {
    const r = w.rect;
    for (let i = 0; i < dbg.count; i++) {
      if (shownSet.has(i)) continue;
      const p = proj[i];
      if (p.depth <= 0 || p.faded || p.distance <= w.distance * 1.03) continue;
      if (Math.abs(p.clientX - r.x) > r.width / 2 || Math.abs(p.clientY - r.y) > r.height / 2) continue;
      const px = Math.floor(p.clientX * scale), py = Math.floor(p.clientY * scale);
      if (px >= 0 && py >= 0 && px < W && py < H && ids[py * W + px] === w.index) hiddenBehind++;
    }
  }

  // 文字の画素での pick（真下にその点）。単語ごとに、文字の画素を最大 2 つ（上から走査して最初の画素と、中央の行の画素）
  const probes = [];
  for (const s of byId.values()) {
    if (!s.n) continue;
    const midY = Math.floor((s.minY + s.maxY) / 2);
    let took = 0;
    for (const y0 of [midY, s.minY]) {
      for (let y = y0; y < s.maxY && took < 2; y++) {
        let found = false;
        for (let x = s.minX; x < s.maxX; x++) {
          if (ids[y * W + x] === s.w.index) { probes.push({ index: s.w.index, x: (x + 0.5) / scale, y: (y + 0.5) / scale }); found = true; took++; break; }
        }
        if (found) break;
      }
    }
  }
  let pickOk = 0;
  const pickBad = [];
  for (const pr of probes) {
    const r = await ex.pick(pr.x, pr.y);
    if (r && r.index === pr.index && r.pixelDistance === 0) pickOk++;
    else if (pickBad.length < 4) pickBad.push(`#${pr.index} (${pr.x.toFixed(1)},${pr.y.toFixed(1)}) → ${JSON.stringify(r)}`);
  }

  return {
    shown: ws.shown.length, maxWords: ws.params.maxWords, perWord, anchorErr, dotsNotHidden,
    color: { samples: colorSamples, bad: colorBad, max: maxColorErr, examples: colorBadEx },
    shape: { visOnly, idOnly, wordVisOnly, wordIdOnly, wordPixels, examples: diffEx },
    occlusion: { occluders, wrong: occludedWrong, examples: occEx, hiddenBehind },
    pick: { probes: probes.length, ok: pickOk, bad: pickBad },
    scale,
  };
}
/* eslint-enable no-undef */

function overlaps(shown) {
  const bad = [];
  for (let i = 0; i < shown.length; i++) for (let j = i + 1; j < shown.length; j++) {
    const a = shown[i].rect, b = shown[j].rect;
    if (Math.abs(a.x - b.x) < (a.width + b.width) / 2 && Math.abs(a.y - b.y) < (a.height + b.height) / 2) bad.push(`${shown[i].text}×${shown[j].text}`);
  }
  return bad;
}

// ---------- 検証本体 ----------

async function testDisplay(page) {
  console.log('\n[クラスタの内部の視点: 文字の表示・位置・色・ピッキング]');
  const err = await page.evaluate(() => window.__explorer.error ?? null);
  const atlas = (await words(page))?.atlas;
  check('?data=word2vec-10k で開くと、エラーなく単語の文字の部品が作られる', !err && atlas && atlas.glyphs > 0, JSON.stringify(atlas));
  metrics.atlas = atlas;

  for (const name of ['edge', 'inside', 'deep']) {
    await setView(page, VIEWS[name]);
    const s = await waitWords(page);
    await page.screenshot({ path: path.join(outDir, `w2v-${name}.png`) });
    const a = await page.evaluate(analyze);
    const ov = overlaps(s.shown);
    console.log(`  ${name}: 表示中 ${s.shown.length} 語（候補 ${s.select.candidates}、条件を満たす ${s.select.eligible}）、文字 ${s.drawnGlyphs}、文字の高さ ${Math.min(...s.shown.map((w) => w.textPx)).toFixed(1)}〜${Math.max(...s.shown.map((w) => w.textPx)).toFixed(1)}px`);
    check(`${name}: 単語が文字として描かれる（表示中の単語の数が 0 より多く、上限 ${s.params.maxWords} 以下）`, s.shown.length > 0 && s.shown.length <= s.params.maxWords && s.drawnWords === s.shown.length,
      `${s.shown.length} 語`);
    check(`${name}: 表示中の単語の画面上の矩形が互いに重ならない`, ov.length === 0, ov.slice(0, 5).join(' / '));
    const smallest = Math.min(...s.shown.map((w) => w.textPx));
    check(`${name}: 画面上の文字の高さ（1 em）が 8px 以上（新しく出す単語は 9px 以上）`, smallest >= 8, `最小 ${smallest.toFixed(2)}px`);
    check(`${name}: 単語の基準点が、その点を投影した位置と一致する`, a.anchorErr < 0.5, `最大のずれ ${a.anchorErr.toFixed(3)}px`);
    const visible = a.perWord.filter((w) => w.n > 0);
    const outside = a.perWord.filter((w) => w.outside > 1.5);
    check(`${name}: 番号の画像で、文字の画素がその単語の矩形の中にある（位置が点の位置と一致する）`, visible.length >= a.perWord.length * 0.8 && outside.length === 0,
      `文字の画素がある単語 ${visible.length}/${a.perWord.length}、矩形からはみ出す単語 ${outside.length}${outside.length ? `（${outside.slice(0, 3).map((w) => `${w.text} ${w.outside.toFixed(1)}px`).join(', ')}）` : ''}`);
    // 色は、3×3 が同じ番号の内側の画素（MSAA で背景と混ざらない画素）で比べる。文字が小さく（14px 未満）内側の画素がない視点は、ほかの視点に委ねる
    const largest = Math.max(...s.shown.map((w) => w.textPx));
    const colorOk = a.color.bad <= a.color.samples * 0.01 && (a.color.samples >= 100 || largest < 14);
    check(`${name}: 文字の画素の色が、その点の色（霧を含む）と一致する`, colorOk,
      `${a.color.samples} 画素中 不一致 ${a.color.bad}（最大の差 ${a.color.max.toFixed(1)}）${a.color.samples < 100 ? `、文字が小さく（最大 ${largest.toFixed(1)}px）内側の画素が少ない` : ''}${a.color.examples.join(' / ')}`);
    check(`${name}: 文字を出している点の丸い点は消えている（文字と重ならない）`, a.dotsNotHidden === 0, `残っている点 ${a.dotsNotHidden}`);
    check(`${name}: 文字の画素で pick すると、その点が真下に返る`, a.pick.probes >= visible.length && a.pick.ok === a.pick.probes,
      `${a.pick.ok}/${a.pick.probes} ${a.pick.bad.join(' / ')}`);
    check(`${name}: 通常の描画と番号の画像の形が一致する（輪郭の 2 画素を除く）`, a.shape.visOnly + a.shape.idOnly === 0,
      `単語の矩形の中 ${a.shape.wordPixels} 画素で食い違い ${a.shape.wordVisOnly + a.shape.wordIdOnly}、画面全体で ${a.shape.visOnly + a.shape.idOnly}（描画のみ ${a.shape.visOnly}、番号のみ ${a.shape.idOnly}）${a.shape.examples.slice(0, 3).join(' / ')}`);
    check(`${name}: 奥の単語が手前の点に隠れる（手前の点の中心の画素が、奥の単語の番号にならない）`, a.occlusion.wrong === 0,
      `単語の矩形の中の手前の点 ${a.occlusion.occluders} 個、誤り ${a.occlusion.wrong}、単語に隠れた奥の点 ${a.occlusion.hiddenBehind} 個 ${a.occlusion.examples.join(' / ')}`);
    metrics[`occlusion-${name}`] = a.occlusion;
    if (name === 'inside') metrics.insideWords = s.shown.slice(0, 30).map((w) => w.text).join(' ');
  }
  const occ = ['edge', 'inside', 'deep'].reduce((n, k) => n + metrics[`occlusion-${k}`].occluders, 0);
  const behind = ['edge', 'inside', 'deep'].reduce((n, k) => n + metrics[`occlusion-${k}`].hiddenBehind, 0);
  check('奥行きの検証に使える配置がある（単語の矩形の中に手前の点、単語に隠れた奥の点がある）', occ > 0 && behind > 0, `手前の点 ${occ} 個、隠れた奥の点 ${behind} 個`);
}

async function testHoverSelect(page) {
  console.log('\n[文字の上でのホバー・選択と、単語を囲む強調]');
  await setView(page, VIEWS.inside);
  const s = await waitWords(page);
  // 文字の高さが大きく、パネル・HUD・ミニマップ・目印にかからない単語の、基準点から離れた文字の画素
  const target = await page.evaluate(async (wh) => {
    const ex = window.__explorer, dbg = ex.picking;
    const ws = ex.words.getState();
    const img = await dbg.readIdImage();
    const scale = dbg.bufferScale();
    const ok = (x, y) => x > 40 && y > 60 && x < wh.w - 40 && y < wh.h - 40 && !(x > wh.w - 380 && y < 240) && !(x < 680 && y > wh.h - 220) && !(x > wh.w - 260 && y > wh.h - 240);
    const canvas = document.querySelector('#app canvas');
    const cands = ws.shown.filter((w) => w.textPx >= 14 && ok(w.rect.x, w.rect.y)).sort((a, b) => b.textPx - a.textPx);
    for (const w of cands) {
      // 単語の右寄りの文字（基準点から 1 em 以上離れた画素）
      for (let y = Math.floor((w.rect.y - w.rect.height / 4) * scale); y < (w.rect.y + w.rect.height / 4) * scale; y++) {
        for (let x = Math.floor((w.rect.x + w.rect.width / 2) * scale) - 2; x > w.anchorX * scale + w.textPx * scale; x--) {
          let solid = true;
          for (let dy = -1; dy <= 1 && solid; dy++) for (let dx = -1; dx <= 1; dx++) if (img.ids[(y + dy) * img.width + x + dx] !== w.index) { solid = false; break; }
          if (!solid) continue;
          const cx = (x + 0.5) / scale, cy = (y + 0.5) / scale;
          if (!ok(cx, cy) || document.elementFromPoint(cx, cy) !== canvas) continue;
          return { index: w.index, text: w.text, x: cx, y: cy, rect: w.rect, anchorX: w.anchorX, anchorY: w.anchorY, textPx: w.textPx };
        }
      }
    }
    return null;
  }, { w: width, h: height });
  if (!target) { check('ホバーの検証に使う単語が見つかる', false, `表示中 ${s.shown.length} 語`); return; }
  console.log(`  単語 "${target.text}"（#${target.index}）の文字の上 (${target.x.toFixed(1)}, ${target.y.toFixed(1)})、基準点から ${Math.hypot(target.x - target.anchorX, target.y - target.anchorY).toFixed(1)}px`);
  await page.mouse.move(target.x, target.y);
  let hov = null;
  for (let k = 0; k < 30; k++) { await frames(page, 1); hov = await ix(page); if (hov.hovered === target.index) break; }
  await frames(page, 1);
  const hoverInfo = await page.evaluate(() => {
    const el = document.getElementById('hover-label');
    const box = window.__explorer.pointCloud.highlight.children[0].material.uniforms.uBox.value;
    return { hidden: el.hidden, text: el.textContent, box: [box.x, box.y, box.z, box.w] };
  });
  check('文字の上にカーソルを置くと、その点がホバーされ、単語がホバーのラベルに出る', hov.hovered === target.index && !hoverInfo.hidden && hoverInfo.text === w2v.text[target.index],
    `ホバー ${hov.hovered}、ラベル "${hoverInfo.text}"`);
  check('ホバーの強調が、単語を囲む矩形になる', hoverInfo.box[0] > 0 && hoverInfo.box[1] > 0, JSON.stringify(hoverInfo.box.map((v) => +v.toFixed(5))));

  await page.mouse.down();
  await page.mouse.up();
  let sel = null;
  for (let k = 0; k < 30; k++) { await frames(page, 1); sel = await ix(page); if (sel.selected === target.index) break; }
  await page.mouse.move(target.x, height - 30); // 強調とパネルを撮るため、カーソルを外す
  await frames(page, 4);
  const selInfo = await page.evaluate(({ rect }) => {
    const ex = window.__explorer;
    const box = ex.pointCloud.highlight.children[1].material.uniforms.uBox.value;
    const f = ex.picking.readFrame();
    const s = ex.picking.bufferScale();
    // 単語の矩形の外側 2〜14px の帯にある、選択の黄色（#ffc233）の画素
    let yellow = 0, band = 0;
    const x0 = Math.floor((rect.x - rect.width / 2 - 14) * s), x1 = Math.ceil((rect.x + rect.width / 2 + 14) * s);
    const y0 = Math.floor((rect.y - rect.height / 2 - 14) * s), y1 = Math.ceil((rect.y + rect.height / 2 + 14) * s);
    for (let y = Math.max(0, y0); y < Math.min(f.height, y1); y++) for (let x = Math.max(0, x0); x < Math.min(f.width, x1); x++) {
      const cx = x / s, cy = y / s;
      const dx = Math.abs(cx - rect.x) - rect.width / 2, dy = Math.abs(cy - rect.y) - rect.height / 2;
      if (Math.max(dx, dy) < 2) continue;
      band++;
      const o = 4 * (y * f.width + x);
      if (Math.abs(f.rgba[o] - 255) < 40 && Math.abs(f.rgba[o + 1] - 194) < 40 && Math.abs(f.rgba[o + 2] - 51) < 50) yellow++;
    }
    return { box: [box.x, box.y, box.z, box.w], label: document.getElementById('info-label').textContent, hidden: document.getElementById('info').hidden, yellow, band };
  }, { rect: target.rect });
  check('文字の上をクリックすると、その点が選択され、情報パネルに単語が出る', sel.selected === target.index && !selInfo.hidden && selInfo.label === w2v.text[target.index],
    `選択 ${sel.selected}、パネル "${selInfo.label}"`);
  check('選択の強調が、単語を囲む矩形になる（単語の矩形の外側に黄色の枠が描かれる）', selInfo.box[0] > 0 && selInfo.yellow >= 40,
    `黄色の画素 ${selInfo.yellow}/${selInfo.band}、box ${JSON.stringify(selInfo.box.map((v) => +v.toFixed(5)))}`);
  await page.screenshot({ path: path.join(outDir, 'w2v-selected.png') });
  await page.keyboard.press('Escape');
  await frames(page, 2);
}

async function testStability(page) {
  console.log('\n[フレーム間の安定]');
  await setView(page, VIEWS.inside);
  const s0 = await waitWords(page);
  const keys = new Set();
  const count0 = s0.select.count;
  for (let k = 0; k < 12; k++) { await frames(page, 1); keys.add(shownKey(await words(page))); }
  const s1 = await words(page);
  check('カメラが止まっている間、表示する単語の集合が変わらず、選び直しもしない', keys.size === 1 && s1.select.count === count0,
    `12 フレームで集合 ${keys.size} 種類、選び直し ${s1.select.count - count0} 回`);

  // 小さな往復: 画面の横方向へ、最も近い表示中の単語が画面上で ±1px 動く幅
  const st = await state(page);
  const em = s0.params.textScale * (await page.evaluate(() => window.__explorer.pointCloud.params.pointSize));
  const maxPxPerUnit = Math.max(...s0.shown.map((w) => w.textPx / em));
  const amp = 1 / maxPxPerUnit;
  const right = norm([-st.direction[2], 0, st.direction[0]]);
  const at = (sgn) => ({ pos: add(st.position, mul(right, sgn * amp)), look: add(st.lookAt, mul(right, sgn * amp)) });
  const seq = [];
  for (let k = 0; k < 16; k++) {
    await setView(page, at(k % 2 === 0 ? 1 : -1));
    await frames(page, 3); // 選び直し（100ms に 1 回まで）と切り替えが起こるだけ進める
    seq.push(shownKey(await words(page)));
  }
  let toggles = 0;
  for (let k = 6; k < seq.length; k++) if (seq[k] !== seq[k - 2]) toggles++;
  check('カメラを小さく往復させても（最も近い単語が画面上で ±1px）、表示と非表示が切り替わり続けない', toggles === 0,
    `16 往復の後半で切り替わり ${toggles} 回、振れ幅 ±${amp.toExponential(2)}`);
  await setView(page, VIEWS.inside);
  await waitWords(page);
}

async function testFarAndToggle(page) {
  console.log('\n[遠方の視点と K キー]');
  const home = await page.evaluate(() => window.__explorer.homeView());
  await setView(page, home);
  const s = await waitWords(page);
  const ids = await page.evaluate(async () => { const ws = window.__explorer.words.getState(); return { shown: ws.shown.length, glyphs: ws.drawnGlyphs }; });
  check('全体が見える視点（ホーム）では文字が出ず、丸い点だけで描かれる', s.shown.length === 0 && ids.glyphs === 0, JSON.stringify(ids));
  await page.screenshot({ path: path.join(outDir, 'w2v-home.png') });

  await setView(page, VIEWS.inside);
  const before = await waitWords(page);
  const hud = await page.evaluate(() => document.getElementById('hud').innerText.split('\n')[2]);
  check('HUD の操作説明に K キーがある', hud.includes('K 単語の文字'), hud);
  await page.keyboard.press('k');
  await frames(page, 3);
  const off = await page.evaluate(() => {
    const ex = window.__explorer, ws = ex.words.getState();
    return { enabled: ws.enabled, shown: ws.shown.length, glyphs: ws.drawnGlyphs, dotsHidden: Array.from(ex.pointCloud.dotScales).filter((v) => v !== 1).length };
  });
  check('K キーで文字が消え、すべての点が丸い点に戻る', !off.enabled && off.shown === 0 && off.glyphs === 0 && off.dotsHidden === 0, JSON.stringify(off));
  const offFrames = await frames(page, 20);
  await page.keyboard.press('k');
  const on = await waitWords(page);
  check('もう一度 K キーを押すと、文字が戻る', on.enabled && on.shown.length > 0 && on.drawnGlyphs > 0, `${on.shown.length} 語（切り替え前 ${before.shown.length} 語）`);
  const onFrames = await frames(page, 20);
  metrics.frameMs = { wordsOn: onFrames.medianMs, wordsOff: offFrames.medianMs, shown: on.shown.length, glyphs: on.drawnGlyphs };
}

async function testDpr(browser, base, page1) {
  console.log('\n[deviceScaleFactor 1 と 2 での見かけの大きさ]');
  await setView(page1, VIEWS.inside);
  const s1 = await waitWords(page1);
  const a1 = await page1.evaluate(analyze);
  const page2 = await openPage(browser, base, 'data=word2vec-10k', 2);
  try {
    await setView(page2, VIEWS.inside);
    const s2 = await waitWords(page2);
    const a2 = await page2.evaluate(analyze);
    const m1 = new Map(a1.perWord.map((w) => [w.index, w]));
    const ratios = [], textRatios = [];
    for (const w of a2.perWord) {
      const v = m1.get(w.index);
      if (!v || !v.bbox || !w.bbox || v.glyphHeightCss < 6) continue;
      ratios.push(w.glyphHeightCss / v.glyphHeightCss);
      textRatios.push(w.textPx / v.textPx);
    }
    ratios.sort((a, b) => a - b);
    const med = ratios[ratios.length >> 1];
    const common = s2.shown.filter((w) => m1.has(w.index)).length;
    check('deviceScaleFactor 2 でも、同じ単語の文字の見かけの高さ（CSS ピクセル）が 1 のときと同じ', ratios.length >= 10 && Math.abs(med - 1) < 0.06 && textRatios.every((r) => Math.abs(r - 1) < 1e-6),
      `共通の単語 ${common}（dpr1 ${s1.shown.length} 語、dpr2 ${s2.shown.length} 語）、比べた単語 ${ratios.length}、文字の画素の高さの比の中央値 ${med?.toFixed(3)}（${ratios[0]?.toFixed(3)}〜${ratios[ratios.length - 1]?.toFixed(3)}）、描画バッファの倍率 ${a1.scale} / ${a2.scale}`);
    check('deviceScaleFactor 2 でも、文字の画素の色と形、pick が一致する', a2.color.bad <= a2.color.samples * 0.01 && a2.shape.visOnly + a2.shape.idOnly === 0 && a2.pick.ok === a2.pick.probes,
      `色の不一致 ${a2.color.bad}/${a2.color.samples}、形の食い違い ${a2.shape.visOnly + a2.shape.idOnly}、pick ${a2.pick.ok}/${a2.pick.probes}`);
  } finally {
    await page2.close();
  }
}

async function testSwitching(page) {
  console.log('\n[MNIST への切り替えと解放]');
  const switchTo = async (id) => {
    const g = (await page.evaluate(() => window.__explorer.dataset.getState())).generation;
    const r = await page.evaluate((x) => window.__explorer.dataset.switchTo(x), id);
    await page.waitForFunction((gg) => { const s = window.__explorer.dataset.getState(); return !s.loading && s.generation > gg; }, g, { timeout: 120000 });
    await frames(page, 3);
    return r;
  };
  const mem = () => page.evaluate(() => window.__explorer.memory());
  const samples = [];
  for (let k = 0; k < 4; k++) {
    await switchTo('mnist');
    const m = await mem();
    const mn = await page.evaluate(() => ({
      words: window.__explorer.words.getState(),
      hud: document.getElementById('hud').innerText.split('\n')[2],
      dotsOnly: window.__explorer.pointCloud.dotsOnly,
      layers: window.__explorer.pointCloud.mesh.geometry.getAttribute('instanceDotScale') ? 1 : 0,
    }));
    if (k === 0) {
      check('MNIST では単語の文字は働かない（部品がなく、HUD に K キーがなく、点群に丸い点の倍率の属性もない）', mn.words === null && !mn.hud.includes('K 単語') && !mn.dotsOnly && mn.layers === 0, JSON.stringify({ words: mn.words, hasK: mn.hud.includes('K 単語') }));
    }
    await switchTo('word2vec-10k');
    await setView(page, VIEWS.inside);
    const s = await waitWords(page);
    const w = await mem();
    samples.push({ mnist: m, w2v: w, shown: s.shown.length });
    console.log(`  往復 ${k}: MNIST ${JSON.stringify(m)} / word2vec ${JSON.stringify(w)}（表示中 ${s.shown.length} 語）`);
  }
  const first = samples[1], last = samples[samples.length - 1];
  check('MNIST と往復しても、WebGL のテクスチャとジオメトリの数が増え続けない（単語のメッシュとアトラスが解放される）',
    last.mnist.textures <= first.mnist.textures && last.mnist.geometries <= first.mnist.geometries && last.w2v.textures <= first.w2v.textures && last.w2v.geometries <= first.w2v.geometries,
    `MNIST テクスチャ ${samples.map((x) => x.mnist.textures).join('→')}、ジオメトリ ${samples.map((x) => x.mnist.geometries).join('→')} / word2vec テクスチャ ${samples.map((x) => x.w2v.textures).join('→')}、ジオメトリ ${samples.map((x) => x.w2v.geometries).join('→')}`);
  check('切り替えのあとも、単語の文字が表示される', samples.every((x) => x.shown > 0), samples.map((x) => x.shown).join(', '));
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
    const page = await openPage(browser, base, 'data=word2vec-10k');
    await testDisplay(page);
    await testHoverSelect(page);
    await testStability(page);
    await testFarAndToggle(page);
    await testDpr(browser, base, page);
    const ws = await words(page);
    metrics.select = ws.select;
    metrics.params = ws.params;
    await testSwitching(page);
    await page.close();
  } finally {
    if (browser) await browser.close();
    stop();
  }
  console.log('\n[計測（ソフトウェア描画なので参考値）]');
  console.log(`  グリフアトラス: ${metrics.atlas.glyphs} 字、${metrics.atlas.width}×${metrics.atlas.height}、生成 ${metrics.atlas.buildMs.toFixed(1)}ms`);
  console.log(`  選び直し: ${metrics.select.count} 回、平均 ${metrics.select.meanMs.toFixed(2)}ms、最大 ${metrics.select.maxMs.toFixed(2)}ms（候補 ${metrics.select.candidates}）`);
  console.log(`  フレーム時間（中央値）: 文字あり ${metrics.frameMs.wordsOn.toFixed(1)}ms（${metrics.frameMs.shown} 語・${metrics.frameMs.glyphs} 字） / 文字なし ${metrics.frameMs.wordsOff.toFixed(1)}ms`);
  console.log(`  設定: ${JSON.stringify(metrics.params)}`);
  console.log(`  内部の視点の単語（先頭 30）: ${metrics.insideWords}`);
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ results, metrics, consoleErrors }, null, 2));
  const failed = results.filter((r) => !r.ok);
  console.log(consoleErrors.length ? `\nコンソールエラー ${consoleErrors.length} 件:\n${consoleErrors.join('\n')}` : '\nコンソールエラー: なし');
  console.log(`結果: ${results.length - failed.length} / ${results.length} 合格${failed.length ? `（失敗: ${failed.map((f) => f.name).join(' / ')}）` : ''}`);
  process.exitCode = failed.length || consoleErrors.length ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exit(1); });
