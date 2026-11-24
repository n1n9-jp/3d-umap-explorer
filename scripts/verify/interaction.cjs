#!/usr/bin/env node
/**
 * ホバー・クリックでの選択・ダブルクリックで点へ飛ぶ操作（src/interaction/）の検証。
 * ビルドしてプレビューサーバーを起動し、ヘッドレス Chromium へ実際のマウス・キーの入力を送る。
 *
 *   node scripts/verify/interaction.cjs [--no-build] [--port 4320] [--out artifacts/interaction]
 *
 * 確かめること:
 *   - ホバー: 点の上へカーソルを動かすと、その点（pick の結果）がホバーになり、ラベルが出る。点のない場所では外れる
 *   - 選択: クリックで選択され、情報パネルにラベル・番号・クラスタ名が出る。パネルの画像がアトラスのセルと一致する
 *   - 解除: 点のない場所のクリックと Esc で、選択が外れる
 *   - ドラッグ: 視点を回すドラッグの終わりを、クリックと誤認しない
 *   - ボタンの重なり: 左を押したまま右を押し、左を先に離す操作（最後に右を離したときにだけ pointerup が出る）で、選択が変わらない。
 *     そのあとの左クリックは 1 回で効く
 *   - capture が外れたとき: 押している最中に O キーでモードを切り替え、要素の外（情報パネルの上）で離したあと、
 *     次のクリックが 1 回で効く
 *   - 情報パネルのアクセシビリティ: リージョンと見出し、読み上げ用の領域（role=status・aria-live）に内容、
 *     画像の代替テキスト、閉じるボタンをキーボードで操作できる
 *   - ダブルクリックと選択（仕様）: 点 B を選択中に点 A をダブルクリックすると選択が A に移って A へ飛ぶ。
 *     点のない場所のダブルクリックは選択を解除して、飛ばない
 *   - 強調表示: 有無でピッキングの結果（番号の画像）が変わらない。通常の描画には輪が出る
 *   - 慣性を止めるための押下: 点を選択した状態で、慣性を付けて視点を回し、回っている最中に、点のない場所で押して離すと、
 *     慣性が止まり、選択は変わらない。別の点の上で押して離しても、選択は変わらない。慣性が止まったあと、同じ場所でもう一度
 *     クリックすると、通常どおり選択が変わる。慣性を止めた押下の直後のクリックは、ダブルクリックとして扱われない（点へ飛ばない）。
 *     飛行・俯瞰の両方。目印の上で始まって、目印が canvas へ合成したポインタイベントで慣性を止めた押下も、点のクリックにならない
 *   - ダブルクリック: その点へ移動し、止まった位置がその点から決めた距離で、点が画面の中央に十分な大きさで見える
 *   - 俯瞰モードでのダブルクリック: 飛行モードへ切り替わって移動する
 *   - コンソールエラーがない
 * ソフトウェア描画では 1 フレームが約 200 ミリ秒かかるので、待ちはフレーム数と状態の変化で数える。
 * 失敗があれば終了コード 1 で終わる。スクリーンショットを --out に保存する。
 */
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { loadDataset, computeViews, waitForServer, startPreview, CHROMIUM_ARGS, sub, len, sendPointer, pointerGesture, flickPoints } = require('./lib.cjs');

const root = path.resolve(__dirname, '../..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const outDir = path.resolve(root, opt('out', 'artifacts/interaction'));
const port = Number(opt('port', '4320'));
const dataPath = 'data/mnist/';
const width = 1280, height = 800;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const consoleErrors = [];
async function openPage(browser, base) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`[error] ${m.text()}`); });
  page.on('pageerror', (e) => consoleErrors.push(`[pageerror] ${e.message}`));
  page.on('requestfailed', (r) => consoleErrors.push(`[requestfailed] ${r.url()}`));
  await page.goto(`${base}?data=${dataPath}`);
  await page.waitForFunction(() => window.__explorer && (window.__explorer.ready || window.__explorer.error), null, { timeout: 60000 });
  const err = await page.evaluate(() => window.__explorer.error);
  if (err) throw new Error(`アプリの起動に失敗: ${err}`);
  return page;
}

const state = (page) => page.evaluate(() => window.__explorer.getState());
const ix = (page) => page.evaluate(() => window.__explorer.interaction.getState());
const frames = (page, n) => page.evaluate((k) => window.__explorer.measureFrames(k), n);
const setView = (page, pos, look) => page.evaluate((v) => window.__explorer.setView(v), { pos, look });
const pickAt = (page, x, y) => page.evaluate(([a, b]) => window.__explorer.pick(a, b).then((r) => (r ? r.index : null)), [x, y]);
const project = (page, i) => page.evaluate((k) => window.__explorer.picking.project(k), i);

/** 1 フレームずつ進めながら、`fn(page)` が真になるまで最大 `maxFrames` フレーム待つ。最後の値を返す。 */
async function waitFrames(page, fn, maxFrames = 20) {
  let v;
  for (let k = 0; k <= maxFrames; k++) {
    v = await fn(page);
    if (v && v.ok) return { ...v, frames: k };
    await frames(page, 1);
  }
  return { ...v, frames: maxFrames, ok: false };
}

/** カメラが動かなくなるまで待つ（連続する 2 フレームで位置と向きが同じ）。 */
async function waitStill(page, maxFrames = 40) {
  let prev = await state(page);
  for (let k = 0; k < maxFrames; k++) {
    await frames(page, 1);
    const s = await state(page);
    if (len(sub(s.position, prev.position)) < 1e-9 && len(sub(s.direction, prev.direction)) < 1e-9) return s;
    prev = s;
  }
  return prev;
}

/** パネル・HUD・ホバーのラベルに重ならない位置か。 */
const usable = (x, y) => x > 40 && y > 40 && x < width - 40 && y < height - 40 && !(x > width - 360 && y < 220) && !(x < 640 && y > height - 200);

/**
 * 画面に見えていて、投影した中心で pick するとその点が真下に返る点を探す（大きく見えるものから）。
 * `exclude` の点は除く。見つからなければ null。
 */
async function findVisiblePoint(page, { minPx = 6, exclude = [] } = {}) {
  return page.evaluate(async ({ minPx, exclude, w, h }) => {
    const ex = window.__explorer;
    const ok = (x, y) => x > 40 && y > 40 && x < w - 40 && y < h - 40 && !(x > w - 360 && y < 220) && !(x < 640 && y > h - 200);
    const cands = [];
    for (let i = 0; i < ex.picking.count; i++) {
      if (exclude.includes(i)) continue;
      const p = ex.picking.project(i);
      if (p.depth <= 0 || p.faded || p.sizePx < minPx) continue;
      const x = Math.round(p.clientX), y = Math.round(p.clientY);
      if (!ok(x, y)) continue;
      cands.push({ i, x, y, sizePx: p.sizePx });
    }
    cands.sort((a, b) => b.sizePx - a.sizePx);
    for (const c of cands.slice(0, 80)) {
      const r = await ex.pick(c.x, c.y);
      if (r && r.index === c.i && r.pixelDistance === 0) return c;
    }
    return null;
  }, { minPx, exclude, w: width, h: height });
}

/** pick が null を返す（吸着の半径内にも点がない）位置を探す。 */
async function findEmptySpot(page) {
  for (let y = 60; y < height - 60; y += 37) {
    for (let x = 60; x < width - 60; x += 41) {
      if (!usable(x, y)) continue;
      if ((await pickAt(page, x, y)) === null) return { x, y };
    }
  }
  return null;
}

// ---------- 検証本体 ----------

async function testHoverAndSelect(page, ds, view, expectCluster) {
  console.log('\n[ホバー]');
  await setView(page, view.pos, view.look);
  await waitStill(page);
  const p = await findVisiblePoint(page);
  if (!p) { check('ホバーの検証に使う点が見つかる', false); return null; }
  const empty = await findEmptySpot(page);
  check('点のない場所が見つかる', empty !== null, empty ? `(${empty.x}, ${empty.y})` : '');

  await page.mouse.move(p.x, p.y);
  const want = await pickAt(page, p.x, p.y);
  const h = await waitFrames(page, async (pg) => { const s = await ix(pg); return { ok: s.hovered === want, s }; });
  check('点の上へカーソルを動かすと、その点（pick の結果）がホバーになる', h.ok && want === p.i,
    `点 #${p.i}（${p.sizePx.toFixed(1)}px）、pick ${want}、ホバー ${h.s.hovered}（${h.frames} フレーム）`);
  const label = await page.evaluate(() => { const el = document.getElementById('hover-label'); return { hidden: el.hidden, text: el.textContent }; });
  const labelName = ds.manifest.labels.names[ds.labels[p.i]];
  check('カーソルの近くにホバー中の点のラベルが出る', !label.hidden && label.text === labelName, `表示 "${label.text}"、期待 "${labelName}"`);
  await page.screenshot({ path: path.join(outDir, '1-hover.png') });

  if (empty) {
    await page.mouse.move(empty.x, empty.y);
    const e = await waitFrames(page, async (pg) => { const s = await ix(pg); return { ok: s.hovered === null, s }; });
    const hidden = await page.evaluate(() => document.getElementById('hover-label').hidden);
    check('点のない場所ではホバーが外れ、ラベルも消える', e.ok && hidden, `ホバー ${e.s.hovered}`);
  }

  console.log('\n[選択と情報パネル]');
  await page.mouse.move(p.x, p.y);
  await waitFrames(page, async (pg) => ({ ok: (await ix(pg)).hovered === p.i }));
  await page.mouse.click(p.x, p.y);
  const sel = await waitFrames(page, async (pg) => { const s = await ix(pg); return { ok: s.selected === p.i, s }; });
  check('クリックで、その点が選択される', sel.ok, `選択 ${sel.s.selected}（${sel.frames} フレーム）`);
  const s1 = await state(page);
  check('クリックでは視点が動かない', len(sub(s1.direction, (await state(page)).direction)) < 1e-9);
  const panel = await page.evaluate(() => ({
    hidden: document.getElementById('info').hidden,
    label: document.getElementById('info-label').textContent,
    index: document.getElementById('info-index').textContent,
    cluster: document.getElementById('info-cluster').textContent,
  }));
  const wantCluster = expectCluster(p.i);
  check('情報パネルに正しいラベル・番号・クラスタ名が出る',
    !panel.hidden && panel.label === labelName && panel.index === `#${p.i}` && panel.cluster === wantCluster,
    `表示 ${JSON.stringify(panel)}、期待 ラベル "${labelName}"・番号 "#${p.i}"・クラスタ "${wantCluster}"`);

  // パネルの画像とアトラスのセルを画素単位で比べる
  const cmp = await page.evaluate(async ({ index, dataPath }) => {
    const ex = window.__explorer;
    void ex;
    const manifest = await (await fetch(`${dataPath}manifest.json`)).json();
    const [cw, ch] = manifest.sprite.cellSize;
    const cols = manifest.sprite.columns;
    const blob = await (await fetch(`${dataPath}${manifest.sprite.file}`)).blob();
    const bmp = await createImageBitmap(blob, { imageOrientation: 'none', colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    const c = new OffscreenCanvas(cw, ch);
    const cx = c.getContext('2d');
    cx.drawImage(bmp, (index % cols) * cw, Math.floor(index / cols) * ch, cw, ch, 0, 0, cw, ch);
    const src = cx.getImageData(0, 0, cw, ch).data;
    const canvas = document.getElementById('info-image');
    const W = canvas.width, H = canvas.height;
    const dst = canvas.getContext('2d').getImageData(0, 0, W, H).data;
    const sx = W / cw, sy = H / ch;
    let maxDiff = 0, blockVariance = 0, inkPixels = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const o = 4 * (y * W + x), so = 4 * (Math.floor(y / sy) * cw + Math.floor(x / sx));
      for (let k = 0; k < 3; k++) maxDiff = Math.max(maxDiff, Math.abs(dst[o + k] - src[so + k]));
      // 拡大したセルの中は同じ色（補間でぼかしていない）
      const bo = 4 * (Math.floor(y / sy) * sy * W + Math.floor(x / sx) * sx);
      blockVariance = Math.max(blockVariance, Math.abs(dst[o] - dst[bo]));
    }
    for (let i = 0; i < src.length; i += 4) if (Math.abs(src[i] - src[0]) > 64) inkPixels++;
    return { W, H, sx, sy, maxDiff, blockVariance, inkPixels };
  }, { index: p.i, dataPath });
  check('パネルの画像が、アトラスのその点のセルを補間なしで拡大したものと一致する',
    cmp.maxDiff <= 2 && cmp.blockVariance === 0 && cmp.inkPixels > 20 && Number.isInteger(cmp.sx) && cmp.sx >= 2,
    `${cmp.W}x${cmp.H}（${cmp.sx} 倍）、最大差 ${cmp.maxDiff}、セル内のばらつき ${cmp.blockVariance}、インクの画素 ${cmp.inkPixels}`);
  await page.mouse.move(p.x + 60, p.y + 40); // ホバーの輪を選択の輪から離して撮る
  await frames(page, 3);
  await page.screenshot({ path: path.join(outDir, '2-selected.png') });
  return { p, empty };
}

/** 情報パネルのアクセシビリティ。選択中（点 p）の状態から始め、選択された状態で終わる。 */
async function testPanelA11y(page, ds, p, expectCluster) {
  console.log('\n[情報パネルのアクセシビリティ]');
  const labelName = ds.manifest.labels.names[ds.labels[p.i]];
  const a = await page.evaluate(() => {
    const info = document.getElementById('info');
    const live = document.getElementById('info-live');
    const img = document.getElementById('info-image');
    const heading = document.getElementById(info.getAttribute('aria-labelledby') || '');
    const close = document.getElementById('info-close');
    return {
      role: info.getAttribute('role'),
      headingTag: heading && heading.tagName,
      headingText: heading && heading.textContent,
      liveRole: live.getAttribute('role'),
      liveAria: live.getAttribute('aria-live'),
      liveAtomic: live.getAttribute('aria-atomic'),
      liveText: live.textContent,
      liveInsideHiddenPanel: info.contains(live),
      imgRole: img.getAttribute('role'),
      imgAlt: img.getAttribute('aria-label'),
      closeTag: close.tagName, closeType: close.type, closeLabel: close.getAttribute('aria-label'), closeTabindex: close.getAttribute('tabindex'),
    };
  });
  check('パネルは見出しつきのリージョン（role=region、aria-labelledby が見出し h2 を指す）',
    a.role === 'region' && a.headingTag === 'H2' && a.headingText === '選択中の点', JSON.stringify({ role: a.role, heading: a.headingTag, text: a.headingText }));
  check('読み上げ用の領域が role=status・aria-live=polite・aria-atomic=true で、パネルの外（常に DOM にある）にある',
    a.liveRole === 'status' && a.liveAria === 'polite' && a.liveAtomic === 'true' && !a.liveInsideHiddenPanel, JSON.stringify({ role: a.liveRole, live: a.liveAria, atomic: a.liveAtomic }));
  const wantCluster = expectCluster(p.i);
  check('選択すると、読み上げ用の領域にラベル・番号・クラスタ名が入る',
    a.liveText.includes(`${labelName}`) && a.liveText.includes(`番号 ${p.i}`) && a.liveText.includes(wantCluster), `"${a.liveText}"`);
  check('画像のキャンバスに role=img と代替テキスト（手書きの数字 N の画像）がある',
    a.imgRole === 'img' && a.imgAlt === `手書きの数字 ${labelName} の画像`, `role ${a.imgRole}、"${a.imgAlt}"`);
  check('閉じるボタンは button 要素（type=button）で、名前があり、tabindex で外されていない',
    a.closeTag === 'BUTTON' && a.closeType === 'button' && a.closeLabel === '選択を解除' && a.closeTabindex === null, JSON.stringify({ label: a.closeLabel, tabindex: a.closeTabindex }));

  // アクセシビリティツリー上の見え方
  const snap = await page.locator('#info').ariaSnapshot();
  check('アクセシビリティツリーに、見出し・画像（代替テキスト）・ボタンが出る',
    snap.includes('heading "選択中の点"') && snap.includes(`img "手書きの数字 ${labelName} の画像"`) && snap.includes('button "選択を解除"'), snap.replace(/\n/g, ' / '));

  // 別の点を選ぶと代替テキストと読み上げが更新される
  const q = await findVisiblePoint(page, { exclude: [p.i] });
  if (q) {
    await page.mouse.click(q.x, q.y);
    await waitFrames(page, async (pg) => ({ ok: (await ix(pg)).selected === q.i }));
    const b = await page.evaluate(() => ({ alt: document.getElementById('info-image').getAttribute('aria-label'), live: document.getElementById('info-live').textContent }));
    const qName = ds.manifest.labels.names[ds.labels[q.i]];
    check('別の点を選ぶと、代替テキストと読み上げの内容がその点に更新される',
      b.alt === `手書きの数字 ${qName} の画像` && b.live.includes(`番号 ${q.i}`) && b.live.includes(expectCluster(q.i)), `"${b.alt}"、"${b.live}"`);
  }

  // キーボードで閉じる: Tab で閉じるボタンへ移り、Enter で選択を解除する
  await page.evaluate(() => { if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); });
  let reached = false;
  for (let k = 0; k < 6 && !reached; k++) {
    await page.keyboard.press('Tab');
    reached = await page.evaluate(() => document.activeElement && document.activeElement.id === 'info-close');
  }
  check('Tab キーで閉じるボタンにフォーカスが移る', reached);
  await page.keyboard.press('Enter');
  const r = await waitFrames(page, async (pg) => { const s = await ix(pg); return { ok: s.selected === null, s }; }, 4);
  const after = await page.evaluate(() => ({ hidden: document.getElementById('info').hidden, live: document.getElementById('info-live').textContent }));
  check('閉じるボタンを Enter で押すと、選択が外れ、パネルが消え、読み上げの内容も空になる', r.ok && after.hidden && after.live === '', `選択 ${r.s.selected}、パネルの hidden ${after.hidden}、読み上げ "${after.live}"`);
  await page.evaluate(() => { if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); });
  // 次の検証のため、点 p を選択し直す
  await page.mouse.click(p.x, p.y);
  await waitFrames(page, async (pg) => ({ ok: (await ix(pg)).selected === p.i }));
}

/** キャンバスのポインタイベントを記録する（診断用）。 */
async function recordPointerEvents(page) {
  await page.evaluate(() => {
    if (window.__pe) { window.__pe.length = 0; return; }
    window.__pe = [];
    const c = document.querySelector('#app canvas');
    for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) {
      c.addEventListener(t, (e) => window.__pe.push(`${t}(button ${e.button}, buttons ${e.buttons})`));
    }
  });
}

async function testChordedButtons(page, view) {
  console.log('\n[左右のボタンを重ねて押す]');
  await setView(page, view.pos, view.look);
  await waitStill(page);
  const a = await findVisiblePoint(page);
  const b = a && await findVisiblePoint(page, { exclude: [a.i] });
  if (!a || !b) { check('ボタンの重なりの検証に使う点が見つかる', false); return; }
  await page.mouse.click(a.x, a.y);
  await waitFrames(page, async (pg) => ({ ok: (await ix(pg)).selected === a.i }));
  await recordPointerEvents(page);
  // b の上で、左を押したまま右を押し、左を先に離してから右を離す
  await page.mouse.move(b.x, b.y);
  await waitFrames(page, async (pg) => ({ ok: (await ix(pg)).hovered === b.i }));
  await page.mouse.down({ button: 'left' });
  await page.mouse.down({ button: 'right' });
  await page.mouse.up({ button: 'left' });
  await page.mouse.up({ button: 'right' });
  await frames(page, 4);
  const events = await page.evaluate(() => window.__pe.join(' '));
  const s = await ix(page);
  check('左を押したまま右を押し、左を先に離しても、選択が変わらない（右ボタンの pointerup をクリックにしない）', s.selected === a.i,
    `選択 ${s.selected}（期待 ${a.i}、押した点 ${b.i}）、イベント: ${events}`);
  // 右を先に離して、左を最後に離す順序
  await page.mouse.down({ button: 'left' });
  await page.mouse.down({ button: 'right' });
  await page.mouse.up({ button: 'right' });
  await page.mouse.up({ button: 'left' });
  await frames(page, 4);
  const s2 = await ix(page);
  check('左を押したまま右を重ねて、右を先に離しても、選択が変わらない', s2.selected === a.i, `選択 ${s2.selected}（期待 ${a.i}）`);
  // 続く左ボタンだけのクリックは 1 回で効く
  await page.mouse.click(b.x, b.y);
  const r = await waitFrames(page, async (pg) => { const t = await ix(pg); return { ok: t.selected === b.i, t }; });
  check('そのあとの左クリックは 1 回で効く', r.ok, `選択 ${r.t.selected}（期待 ${b.i}）`);
  await page.keyboard.press('Escape');
  await frames(page, 2);
}

async function testLostPointerCapture(page, view) {
  console.log('\n[押している最中に capture が外れる（O キー）]');
  // ブラウザは、capture の取得と解放の間にポインタイベントがないと、lostpointercapture を出さない。
  // (1) 押したあとに少し動かしてから O キーを押す（lostpointercapture が出る）
  // (2) 押した直後に O キーを押す（lostpointercapture が出ない。次の移動の buttons が 0 であることで、取りこぼしを拾う）
  for (const withMove of [true, false]) {
    const tag = withMove ? '押したあとに動かしてから' : '押した直後に';
    await setView(page, view.pos, view.look);
    await waitStill(page);
    const a = await findVisiblePoint(page);
    const c = a && await findVisiblePoint(page, { exclude: [a.i] });
    const d = c && await findVisiblePoint(page, { exclude: [a.i, c.i] });
    if (!a || !c || !d) { check('capture の検証に使う点が見つかる', false); return; }
    // 情報パネルを出すため、a を選択する
    await page.mouse.click(a.x, a.y);
    await waitFrames(page, async (pg) => ({ ok: (await ix(pg)).selected === a.i }));
    const box = await page.evaluate(() => { const r = document.getElementById('info').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await recordPointerEvents(page);
    // c の上で押し、押したまま O キーで俯瞰モードへ。要素（キャンバス）の外＝情報パネルの上で離す
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    if (withMove) { await page.mouse.move(c.x + 1, c.y); await frames(page, 1); }
    await page.keyboard.press('KeyO');
    await page.waitForFunction(() => window.__explorer.getState().mode === 'overview');
    await page.mouse.move(box.x, box.y, { steps: 4 });
    await page.mouse.up();
    await frames(page, 3);
    const events = await page.evaluate(() => window.__pe.join(' '));
    const s1 = await ix(page);
    check(`${tag} O キーを押し、パネルの上で離しても、選択は変わらない`, s1.selected === a.i, `選択 ${s1.selected}（期待 ${a.i}）`);
    const upOnCanvas = /pointerup/.test(events);
    check(`${tag} O キーを押すと、離した pointerup はキャンバスに届かない（取りこぼしの状況になっている）`, !upOnCanvas, events);
    if (withMove) check('capture が外れた通知（lostpointercapture）が届いている（押下を破棄する契機）', /lostpointercapture/.test(events), events);
    await page.keyboard.press('KeyO');
    await page.waitForFunction(() => window.__explorer.getState().mode === 'fly');
    await waitStill(page);
    // 次のクリックが 1 回で効く
    await page.mouse.click(d.x, d.y);
    const r = await waitFrames(page, async (pg) => { const t = await ix(pg); return { ok: t.selected === d.i, t }; });
    check(`${tag} O キーを押したあとの最初のクリックが 1 回で効く（押したままの状態が残らない）`, r.ok, `選択 ${r.t.selected}（期待 ${d.i}）`);
    await page.keyboard.press('Escape');
    await frames(page, 2);
  }
}

/** 点 B を選択中に点 A をダブルクリックすると選択が A に移る。点のない場所のダブルクリックは選択を解除して飛ばない。 */
async function testDoubleClickSelectionSpec(page, view) {
  console.log('\n[ダブルクリックと選択の変化（仕様）]');
  await setView(page, view.pos, view.look);
  await waitStill(page);
  const a = await findVisiblePoint(page);
  const b = a && await findVisiblePoint(page, { exclude: [a.i] });
  const empty = await findEmptySpot(page);
  if (!a || !b || !empty) { check('ダブルクリックの仕様の検証に使う点が見つかる', false); return; }
  // 点のない場所のダブルクリック: 1 回目で選択が解除され、飛ばない
  await page.mouse.click(b.x, b.y);
  await waitFrames(page, async (pg) => ({ ok: (await ix(pg)).selected === b.i }));
  const before = await state(page);
  await page.mouse.dblclick(empty.x, empty.y);
  const r = await waitFrames(page, async (pg) => { const t = await ix(pg); return { ok: t.selected === null, t }; }, 6);
  await frames(page, 6);
  const after = await state(page);
  const moved = len(sub(after.position, before.position)) + len(sub(after.direction, before.direction));
  check('点のない場所をダブルクリックすると、選択が解除され、飛ばない', r.ok && moved < 1e-9, `選択 ${r.t.selected}、カメラの変化 ${moved.toExponential(2)}`);
  // 点 B を選択中に点 A をダブルクリック: 選択は A に移り、A へ飛ぶ（doubleClickAndCheck が止まる位置と選択を確かめる）
  await page.mouse.click(b.x, b.y);
  await waitFrames(page, async (pg) => ({ ok: (await ix(pg)).selected === b.i }));
  await doubleClickAndCheck(page, a, '別の点を選択中のダブルクリック');
  await page.keyboard.press('Escape');
  await frames(page, 2);
}

async function testDeselect(page, p, empty) {
  console.log('\n[選択の解除]');
  if (empty) {
    await page.mouse.click(empty.x, empty.y);
    const r = await waitFrames(page, async (pg) => { const s = await ix(pg); return { ok: s.selected === null, s }; });
    const hidden = await page.evaluate(() => document.getElementById('info').hidden);
    check('点のない場所のクリックで選択が外れ、パネルが消える', r.ok && hidden, `選択 ${r.s.selected}`);
  }
  await page.mouse.click(p.x, p.y);
  await waitFrames(page, async (pg) => ({ ok: (await ix(pg)).selected === p.i }));
  await page.keyboard.press('Escape');
  const r = await waitFrames(page, async (pg) => { const s = await ix(pg); return { ok: s.selected === null, s }; }, 4);
  check('Esc で選択が外れる', r.ok, `選択 ${r.s.selected}`);
}

async function testDrag(page, view) {
  console.log('\n[ドラッグはクリックではない]');
  await setView(page, view.pos, view.look);
  await waitStill(page);
  const a = await findVisiblePoint(page);
  if (!a) { check('ドラッグの検証に使う点が見つかる', false); return; }
  await page.mouse.click(a.x, a.y);
  await waitFrames(page, async (pg) => ({ ok: (await ix(pg)).selected === a.i }));
  const s0 = await state(page);
  // (1) 点の上で押して、離れた位置で離す
  // (2) 点の上で押して、往復して元の位置で離す。回転は往復で打ち消し合うので、離す位置には押した点が見えている
  //     （離した位置に点があっても、クリックとして選び直さないことを確かめる）
  for (const [name, roundTrip] of [['離れた位置で離す', false], ['往復して元の点の上で離す', true]]) {
    await setView(page, view.pos, view.look);
    await waitStill(page);
    const b = roundTrip ? await findVisiblePoint(page, { exclude: [a.i] }) : a;
    if (!b) { check('往復のドラッグに使う点が見つかる', false); continue; }
    const path_ = roundTrip ? [[b.x - 120, b.y + 20], [b.x, b.y]] : [[b.x + 160, b.y + 30]];
    await page.mouse.move(b.x, b.y);
    await page.mouse.down();
    for (const [x, y] of path_) await page.mouse.move(x, y, { steps: 8 });
    await page.waitForTimeout(250); // ポインタを止めてから離す（離す直前の動きが速いと、回転の慣性が付くので）
    await page.mouse.up();
    await frames(page, 2);
    const hoverDuring = (await ix(page)).hovered;
    await waitStill(page);
    const target = path_[path_.length - 1];
    const under = await pickAt(page, target[0], target[1]);
    await frames(page, 4);
    const s = await ix(page);
    const meaningful = roundTrip ? under === b.i : true;
    check(`ドラッグ（${name}）で選択が変わらない`, s.selected === a.i && meaningful,
      `選択 ${s.selected}（期待 ${a.i}）、離した位置の点 ${under}${roundTrip ? `（押した点 ${b.i}）` : ''}、直後のホバー ${hoverDuring}`);
    if (!roundTrip) {
      const s1 = await state(page);
      check('ドラッグで視点は回っている', len(sub(s0.direction, s1.direction)) > 0.05, `向きの変化 ${len(sub(s0.direction, s1.direction)).toFixed(3)}`);
    }
  }
  await page.keyboard.press('Escape');
  await frames(page, 2);
}

async function testHighlightDoesNotChangePicking(page, view) {
  console.log('\n[強調表示とピッキング]');
  await setView(page, view.pos, view.look);
  await waitStill(page);
  const a = await findVisiblePoint(page);
  const b = a && await findVisiblePoint(page, { exclude: [a.i] });
  if (!a || !b) { check('強調表示の検証に使う点が見つかる', false); return; }
  const empty = await findEmptySpot(page);
  // 強調なし
  await page.keyboard.press('Escape');
  if (empty) await page.mouse.move(empty.x, empty.y);
  await waitFrames(page, async (pg) => { const s = await ix(pg); return { ok: s.hovered === null && s.selected === null }; });
  const sample = [[a.x, a.y], [b.x, b.y], [a.x + 3, a.y + 2], [b.x - 4, b.y + 1], [(a.x + b.x) / 2, (a.y + b.y) / 2]].map(([x, y]) => [Math.round(x), Math.round(y)]);
  const before = await page.evaluate(async (pts) => {
    const ex = window.__explorer;
    const img = await ex.picking.readIdImage();
    let h = 0; for (let i = 0; i < img.ids.length; i++) h = (h * 31 + img.ids[i] + 1) >>> 0;
    const picks = []; for (const [x, y] of pts) { const r = await ex.pick(x, y); picks.push(r ? [r.index, r.pixelDistance] : null); }
    const f = ex.picking.readFrame(); let fh = 0; for (let i = 0; i < f.rgba.length; i += 7) fh = (fh * 31 + f.rgba[i]) >>> 0;
    return { h, picks, fh };
  }, sample);
  // 選択（a）とホバー（b）
  await page.mouse.click(a.x, a.y);
  await waitFrames(page, async (pg) => ({ ok: (await ix(pg)).selected === a.i }));
  await page.mouse.move(b.x, b.y);
  const hv = await waitFrames(page, async (pg) => ({ ok: (await ix(pg)).hovered === b.i }));
  const after = await page.evaluate(async (pts) => {
    const ex = window.__explorer;
    const img = await ex.picking.readIdImage();
    let h = 0; for (let i = 0; i < img.ids.length; i++) h = (h * 31 + img.ids[i] + 1) >>> 0;
    const picks = []; for (const [x, y] of pts) { const r = await ex.pick(x, y); picks.push(r ? [r.index, r.pixelDistance] : null); }
    const f = ex.picking.readFrame(); let fh = 0; for (let i = 0; i < f.rgba.length; i += 7) fh = (fh * 31 + f.rgba[i]) >>> 0;
    return { h, picks, fh };
  }, sample);
  check('強調表示（選択とホバー）の有無で、全画面の番号の画像が変わらない', before.h === after.h && hv.ok, `ハッシュ ${before.h} / ${after.h}`);
  check('強調表示の有無で、pick の結果（点と吸着の距離）が変わらない', JSON.stringify(before.picks) === JSON.stringify(after.picks), JSON.stringify(after.picks));
  check('通常の描画には強調表示が出ている（描画が変わる）', before.fh !== after.fh);
  await page.keyboard.press('Escape');
  await frames(page, 2);
}

/** 点 p をダブルクリックして、移動後の状態を確かめる。 */
async function doubleClickAndCheck(page, p, title) {
  const dist = await page.evaluate((i) => window.__explorer.interaction.stopDistance(i), p.i);
  await page.mouse.dblclick(p.x, p.y);
  // 移動が始まるのを待ってから、止まるまで待つ
  const s0 = await state(page);
  await waitFrames(page, async (pg) => ({ ok: len(sub((await state(pg)).position, s0.position)) > 1e-6 }), 10);
  const s = await waitStill(page);
  const P = await page.evaluate((i) => { const a = window.__explorer.pointCloud.mesh.geometry.getAttribute('instancePosition'); return [a.getX(i), a.getY(i), a.getZ(i)]; }, p.i);
  const d = len(sub(s.position, P));
  check(`${title}: 止まった位置が、その点から決めた距離にある`, Math.abs(d - dist.distance) < 1e-4,
    `距離 ${d.toFixed(5)}、期待 ${dist.distance.toFixed(5)}（近傍の平均 ${dist.meanNeighborDistance?.toFixed(5)}、範囲 ${dist.minDistance.toFixed(4)}〜${dist.maxDistance.toFixed(4)}）`);
  const pr = await project(page, p.i);
  const off = Math.hypot(pr.clientX - width / 2, pr.clientY - height / 2);
  check(`${title}: 点が画面の中央に、数字が読める大きさで、近接フェードで消えずに見える`, off < 3 && pr.sizePx >= 31.5 && !pr.faded,
    `中央からのずれ ${off.toFixed(2)}px、大きさ ${pr.sizePx.toFixed(1)}px（ダブルクリック前 ${p.sizePx.toFixed(1)}px）、消えている ${pr.faded}`);
  const under = await pickAt(page, Math.round(width / 2), Math.round(height / 2));
  check(`${title}: 画面の中央で pick すると、その点が返る（ほかの点と見分けられる）`, under === p.i, `中央の点 ${under}`);
  const sel = await ix(page);
  check(`${title}: その点が選択されている`, sel.selected === p.i, `選択 ${sel.selected}`);
  return s;
}

async function testDoubleClick(page, view) {
  console.log('\n[ダブルクリックで飛ぶ（飛行モード）]');
  await setView(page, view.pos, view.look);
  await waitStill(page);
  const p = await findVisiblePoint(page, { minPx: 3 });
  if (!p) { check('ダブルクリックの検証に使う点が見つかる', false); return; }
  const s = await doubleClickAndCheck(page, p, '飛行モード');
  check('飛行モード: 移動後も飛行モード、係数は有限', s.mode === 'fly' && Number.isFinite(s.speedScale) && s.speedScale > 0, `mode ${s.mode}、係数 ${s.speedScale.toFixed(3)}`);
  await page.mouse.move(width / 2 + 200, height / 2 + 150);
  await frames(page, 3);
  await page.screenshot({ path: path.join(outDir, '3-flyto.png') });
  console.log(`  ダブルクリックで移動したあと → ${path.relative(root, path.join(outDir, '3-flyto.png'))}`);
}

async function testOverviewDoubleClick(page, view) {
  console.log('\n[ダブルクリックで飛ぶ（俯瞰モード）]');
  await page.keyboard.press('Escape');
  await page.keyboard.press('KeyO');
  await page.waitForFunction(() => window.__explorer.getState().mode === 'overview');
  await setView(page, view.pos, view.look);
  await waitStill(page);
  const p = await findVisiblePoint(page, { minPx: 3 });
  if (!p) { check('俯瞰モードの検証に使う点が見つかる', false); return; }
  const s = await doubleClickAndCheck(page, p, '俯瞰モード');
  check('俯瞰モード: ダブルクリックで飛行モードへ切り替わる', s.mode === 'fly', `mode ${s.mode}`);
  await page.screenshot({ path: path.join(outDir, '4-flyto-from-overview.png') });
}

// ---------- 慣性を止めるための押下 ----------

const cx = width / 2, cy = height / 2;
const angleBetween = (a, b) => {
  const c = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  return Math.atan2(Math.hypot(...c), a[0] * b[0] + a[1] * b[1] + a[2] * b[2]);
};

/** 横へ払って離し、慣性で回り始めたこと（getState().rotating）を確かめる。回り始めたら true。 */
async function flickUntilRotating(page, dx = 150) {
  await pointerGesture(page, flickPoints(cx, cy, dx, 0), 1);
  for (let k = 0; k < 6; k++) {
    if ((await state(page)).rotating) return true;
    await frames(page, 1);
  }
  return false;
}

/** 点 p をクリックして選択し、選択されるまで待つ。 */
async function selectByClick(page, p) {
  await page.mouse.click(p.x, p.y);
  return (await waitFrames(page, async (pg) => ({ ok: (await ix(pg)).selected === p.i }), 10)).ok;
}

/**
 * 慣性を止めるための押下を、飛行・俯瞰のどちらかで確かめる。`view` はそのモードで点が見える視点、`emptyView` は点が見えない視点。
 * - 点のない場所: 慣性が止まり、選択は変わらない。止まったあとの同じ場所のクリックは、通常どおり選択を解除する
 * - 別の点の上: 慣性が止まり、選択は変わらない。止まったあとの同じ場所のクリックは、その点を選択する
 * - 直後のクリック（150 ミリ秒後）はダブルクリックにならず、点へ飛ばない
 */
async function testStopPress(page, mode, view, emptyView, emptyCandidates, pointCandidates) {
  const name = mode === 'fly' ? '飛行モード' : '俯瞰モード';
  console.log(`\n[慣性を止めるための押下（${name}）]`);
  if (mode === 'overview') {
    await page.keyboard.press('KeyO');
    await page.waitForFunction(() => window.__explorer.getState().mode === 'overview');
  }
  const flick = mode === 'fly' ? 150 : 120;
  const begin = async (v) => { await setView(page, v.pos, v.look); await waitStill(page); };
  await begin(view);
  const A = await findVisiblePoint(page, { minPx: mode === 'fly' ? 6 : 3 });
  if (!A) { check(`${name}: 慣性を止める押下の検証に使う点が見つかる`, false); return; }
  // 選択して視点を戻す（選択は視点を変えても残る）
  const prepare = async (v) => {
    await begin(view);
    if (!(await selectByClick(page, A))) return false;
    if (v !== view) await begin(v);
    return flickUntilRotating(page, flick);
  };

  // ---- 点のない場所 ----
  let done = false;
  const emptyTried = [];
  for (const [px, py] of emptyCandidates) {
    if (!(await prepare(emptyView))) { check(`${name}: （前提）点を選択して、払って、慣性で回り始める`, false); return; }
    await sendPointer(page, [{ type: 'down', x: px, y: py, t: 0 }, { type: 'up', x: px, y: py, t: 40 }]);
    await frames(page, 4);
    const under = await pickAt(page, px, py);
    const st = await state(page);
    const sel = await ix(page);
    if (under !== null) { emptyTried.push(`(${px},${py})→点${under}`); continue; }
    const st2 = (await frames(page, 3), await state(page));
    check(`${name}: 回っている最中に、点のない場所で押して離すと、慣性が止まり、選択は変わらない`,
      !st.rotating && !st2.rotating && sel.selected === A.i && angleBetween(st.direction, st2.direction) < 1e-9,
      `rotating ${st.rotating}、選択 ${sel.selected}（元 ${A.i}）、押した位置 (${px},${py})`);
    await page.mouse.click(px, py);
    const r = await waitFrames(page, async (pg) => ({ ok: (await ix(pg)).selected === null }), 10);
    check(`${name}: 慣性が止まったあと、同じ場所をもう一度クリックすると、通常どおり選択が解除される`, r.ok, `選択 ${(await ix(page)).selected}`);
    done = true;
    break;
  }
  if (!done) check(`${name}: 点のない場所で押す検証ができる位置が見つかる`, false, emptyTried.join(' '));

  // ---- 別の点の上 ----
  done = false;
  const pointTried = [];
  for (const [px, py] of pointCandidates) {
    if (!(await prepare(view))) { check(`${name}: （前提）点を選択して、払って、慣性で回り始める`, false); return; }
    await sendPointer(page, [{ type: 'down', x: px, y: py, t: 0 }, { type: 'up', x: px, y: py, t: 40 }]);
    await frames(page, 4);
    const want = await pickAt(page, px, py); // 止まった視点で、押した位置にある点
    const st = await state(page);
    const sel = await ix(page);
    if (want === null || want === A.i) { pointTried.push(`(${px},${py})→${want}`); continue; }
    const st2 = (await frames(page, 3), await state(page));
    check(`${name}: 回っている最中に、別の点の上で押して離すと、慣性が止まり、選択は変わらない`,
      !st.rotating && !st2.rotating && sel.selected === A.i && angleBetween(st.direction, st2.direction) < 1e-9,
      `rotating ${st.rotating}、選択 ${sel.selected}（元 ${A.i}、押した位置の点 ${want}）`);
    await page.mouse.click(px, py);
    const r = await waitFrames(page, async (pg) => ({ ok: (await ix(pg)).selected === want }), 10);
    check(`${name}: 慣性が止まったあと、同じ場所をもう一度クリックすると、通常どおりその点が選択される`, r.ok, `選択 ${(await ix(page)).selected}（期待 ${want}）`);
    done = true;
    break;
  }
  if (!done) check(`${name}: 別の点の上で押す検証ができる位置が見つかる`, false, pointTried.join(' '));

  // ---- 直後のクリックは、ダブルクリックにならない ----
  done = false;
  for (const [px, py] of pointCandidates) {
    if (!(await prepare(view))) { check(`${name}: （前提）点を選択して、払って、慣性で回り始める`, false); return; }
    // 慣性を止める押下と、その 150 ミリ秒後・同じ位置のクリック（ダブルクリックの間隔・位置の内）
    await sendPointer(page, [
      { type: 'down', x: px, y: py, t: 0 }, { type: 'up', x: px, y: py, t: 40 },
      { type: 'down', x: px, y: py, t: 150 }, { type: 'up', x: px, y: py, t: 190 },
    ]);
    await frames(page, 3);
    const want = await pickAt(page, px, py);
    if (want === null || want === A.i) continue;
    const r = await waitFrames(page, async (pg) => ({ ok: (await ix(pg)).selected === want }), 10);
    const s0 = await state(page);
    await frames(page, 6); // 飛ぶなら、ここで動き出す（点へ飛ぶと 0.8 秒、飛行モードへの切り替えもある）
    const s1 = await state(page);
    const moved = len(sub(s1.position, s0.position)) + angleBetween(s0.direction, s1.direction);
    check(`${name}: 慣性を止めた押下の直後のクリックは、ダブルクリックにならず、点へ飛ばない（普通のクリックとしてその点を選択する）`,
      r.ok && s1.mode === mode && moved < 1e-9 && !s1.rotating, `選択 ${(await ix(page)).selected}（期待 ${want}）、モード ${s1.mode}、カメラの変化 ${moved.toExponential(2)}`);
    done = true;
    break;
  }
  if (!done) check(`${name}: ダブルクリックの検証ができる位置が見つかる`, false);

  // ---- 慣性が回っていないときは、同じ 2 回のクリックがダブルクリックになる（対照） ----
  await begin(view);
  const q = await findVisiblePoint(page, { minPx: mode === 'fly' ? 6 : 3 });
  if (q) {
    await sendPointer(page, [
      { type: 'down', x: q.x, y: q.y, t: 0 }, { type: 'up', x: q.x, y: q.y, t: 40 },
      { type: 'down', x: q.x, y: q.y, t: 150 }, { type: 'up', x: q.x, y: q.y, t: 190 },
    ]);
    const s0 = await state(page);
    const r = await waitFrames(page, async (pg) => { const s = await state(pg); return { ok: len(sub(s.position, s0.position)) > 1e-6 || s.mode !== mode }; }, 12);
    check(`${name}: （対照）慣性が回っていないときの同じ 2 回のクリックは、ダブルクリックとして点へ飛ぶ`, r.ok && (await ix(page)).selected === q.i, `選択 ${(await ix(page)).selected}（期待 ${q.i}）`);
    await waitStill(page);
  } else {
    check(`${name}: （対照）ダブルクリックに使う点が見つかる`, false);
  }
  await page.keyboard.press('Escape');
  if (mode === 'overview' && (await state(page)).mode === 'overview') {
    await page.keyboard.press('KeyO');
    await page.waitForFunction(() => window.__explorer.getState().mode === 'fly');
  }
  await frames(page, 2);
}

/**
 * 目印の上で始まった押下が慣性を止める経路。目印は、押したまま 4 ピクセルを超えて動かすと、押した位置からの pointerdown と
 * 現在位置の pointermove を canvas へ合成して渡す（その時点で慣性が回っていれば、この合成した押下が慣性を止める）。
 * 合成した押下は、点のクリックにならない。ソフトウェア描画では目印が毎フレーム大きく動くので、目印の位置を測ってから本物の
 * マウスで押すと外れる。そこで、1 回の評価の中で、目印の要素へポインタイベントを送る（目印のコードの経路は同じ）。
 */
async function testStopPressOnLabel(page, view) {
  console.log('\n[慣性を止めるための押下（目印の上から始まる経路）]');
  await setView(page, view.pos, view.look);
  await waitStill(page);
  const A = await findVisiblePoint(page, { minPx: 2 });
  if (!A) { check('目印の上の押下の検証に使う点が見つかる', false); return; }
  const selected = await selectByClick(page, A);
  const rotating = selected && await flickUntilRotating(page, 60);
  check('（前提）点を選択して、払って、慣性で回り始める', selected && rotating, `選択 ${(await ix(page)).selected}（期待 ${A.i}）`);
  if (!rotating) return;
  const r = await page.evaluate(() => {
    const ex = window.__explorer;
    const canvas = document.querySelector('#app canvas');
    const chip = [...document.querySelectorAll('.cluster-label')].find((el) => {
      const b = el.getBoundingClientRect();
      const x = b.x + b.width / 2, y = b.y + b.height / 2;
      return b.width > 0 && x > 40 && x < innerWidth - 80 && y > 40 && y < innerHeight - 40 &&
        document.elementFromPoint(x, y)?.closest('.cluster-label') === el;
    });
    if (!chip) return { error: '最前面に出ている目印がない' };
    const b = chip.getBoundingClientRect();
    const x = b.x + b.width / 2, y = b.y + b.height / 2;
    const init = { pointerId: 7, pointerType: 'mouse', isPrimary: true, bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y };
    const before = ex.getState().rotating;
    chip.dispatchEvent(new PointerEvent('pointerdown', { ...init, button: 0, buttons: 1 }));
    const afterDown = ex.getState().rotating; // 目印の押下は、動かすまで canvas へ渡らない
    chip.dispatchEvent(new PointerEvent('pointermove', { ...init, clientX: x + 12, button: -1, buttons: 1 })); // 閾値（4 ピクセル）を超える
    const afterMove = ex.getState().rotating; // 合成した押下が慣性を止める
    canvas.dispatchEvent(new PointerEvent('pointerup', { ...init, clientX: x + 12, button: 0, buttons: 0 }));
    return { before, afterDown, afterMove, cluster: chip.dataset.clusterId };
  });
  if (r.error) { check('目印の上から始まる押下を送れる', false, r.error); return; }
  check('目印から canvas へ合成された押下が、慣性を止める', r.before && !r.afterMove, `押す前 ${r.before}、目印の押下の直後 ${r.afterDown}、動かして合成したあと ${r.afterMove}（目印 ${r.cluster}）`);
  await waitFrames(page, async (pg) => ({ ok: !(await state(pg)).rotating }), 30); // 離したときの速さで、新しく慣性が付くことがある
  await frames(page, 4);
  const sel = await ix(page);
  check('その押下は、点のクリックにならない（選択は変わらない）・目印のクリックにもならない（飛ばない）', sel.selected === A.i && (await state(page)).mode === 'fly',
    `選択 ${sel.selected}（元 ${A.i}）`);
  await page.keyboard.press('Escape');
  await frames(page, 2);
}

async function main() {
  const dataDir = path.join(root, 'public', dataPath);
  const ds = loadDataset(dataDir);
  const { views } = computeViews(ds);
  const [overview, edge, inside] = views;
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < ds.count; i++) for (let k = 0; k < 3; k++) {
    mn[k] = Math.min(mn[k], ds.positions[3 * i + k]); mx[k] = Math.max(mx[k], ds.positions[3 * i + k]);
  }
  const center = mn.map((v, k) => (v + mx[k]) / 2);

  // クラスタ名の期待値はデータのファイルから直接求める
  const level = ds.manifest.clusters.levels[0];
  const cb = fs.readFileSync(path.join(dataDir, level.pointFile));
  const coarse = new Uint16Array(cb.buffer.slice(cb.byteOffset, cb.byteOffset + cb.byteLength));
  const expectCluster = (i) => (coarse[i] === ds.manifest.clusters.noise ? 'なし（ノイズ）' : level.clusters[coarse[i]].name);

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
    const page = await openPage(browser, base);
    await frames(page, 3);

    const r = await testHoverAndSelect(page, ds, edge, expectCluster);
    if (r) await testPanelA11y(page, ds, r.p, expectCluster);
    if (r) await testDeselect(page, r.p, r.empty);
    await testDrag(page, edge);
    await testChordedButtons(page, edge);
    await testLostPointerCapture(page, edge);
    await testHighlightDoesNotChangePicking(page, inside);
    await testDoubleClickSelectionSpec(page, edge);
    // 慣性を止めるための押下（飛行モードは視点を点のない外向きに置いて、点のない場所を作る）
    const outward = { pos: [0, 0, 3], look: [0, 0, 6] };
    await testStopPress(page, 'fly', inside, outward,
      [[cx + 60, cy + 40], [cx - 200, cy + 120], [cx + 250, cy - 100]],
      [[cx + 60, cy + 40], [cx - 120, cy + 60], [cx + 200, cy - 80], [cx - 60, cy - 100], [cx, cy + 120], [cx + 100, cy + 140]]);
    await testStopPress(page, 'overview', { pos: [1.4, 0.4, 1.5], look: center }, { pos: [1.4, 0.4, 1.5], look: center },
      [[100, 430], [1180, 430], [100, 330], [1180, 330], [100, 520]],
      [[cx + 60, cy + 40], [cx - 120, cy + 60], [cx + 100, cy - 80], [cx - 60, cy - 100], [cx, cy + 120]]);
    await testStopPressOnLabel(page, overview);
    await testDoubleClick(page, edge);
    await testOverviewDoubleClick(page, overview);
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
