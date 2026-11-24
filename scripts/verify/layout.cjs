#!/usr/bin/env node
/**
 * 画面の上部の配置（左上に作品タイトルとカメラのモード、右上にデータセットの選択欄・UMAP の再計算のパネル・情報パネル）を確かめる。
 *
 *   node scripts/verify/layout.cjs [--no-build] [--port 4360] [--out artifacts]
 *
 * - 左上にタイトルとモード名が出て、起動時のモードと一致する
 * - O キー、モード名のクリック、点のダブルクリック（俯瞰から飛行へ自動で切り替わる）のそれぞれで、表示が追従する。読み上げにも知らせる
 * - キーボード（Tab と Enter・Space・矢印）でモードを切り替えられ、aria-checked にいまの選択が出る。
 *   切り替えのボタンにフォーカスがある間に WASD・矢印を押しても、カメラは動かず、二重の動作も起きない
 * - 1280×800、1280×480、360×740 の各ビューポートで、左上の要素・選択欄の行・UMAP のパネル（開いた状態）・情報パネル（点を選択した状態）・
 *   ミニマップ・HUD（と現在地）の矩形が、互いに重ならず、ビューポートの中に収まる
 * - コンソールエラーがない
 * 失敗があれば終了コード 1 で終わる。スクリーンショットを artifacts/layout-*.png に保存する。
 */
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { loadDataset, computeViews, waitForServer, startPreview, CHROMIUM_ARGS, sub, len } = require('./lib.cjs');

const root = path.resolve(__dirname, '../..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const port = Number(opt('port', '4360'));
const outDir = path.resolve(root, opt('out', 'artifacts'));

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
}

const consoleErrors = [];
/** 点が大きく見える視点（MNIST のクラスタの縁。点のダブルクリックに使う） */
const EDGE_VIEW = computeViews(loadDataset(path.join(root, 'public/data/mnist'))).views.find((v) => v.name === '2-edge');

async function openPage(browser, base, { width, height, query = '', reducedMotion = 'no-preference' }) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1, reducedMotion });
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`[error] ${m.text()}`); });
  page.on('pageerror', (e) => consoleErrors.push(`[pageerror] ${e.message}`));
  page.on('requestfailed', (r) => consoleErrors.push(`[requestfailed] ${r.url()}`));
  await page.goto(`${base}${query ? `?${query}` : ''}`);
  await page.waitForFunction(() => window.__explorer && (window.__explorer.ready || window.__explorer.error), null, { timeout: 120000 });
  const err = await page.evaluate(() => window.__explorer.error);
  if (err) throw new Error(`アプリの起動に失敗: ${err}`);
  await frames(page, 3);
  return page;
}

const frames = (page, n) => page.evaluate((k) => new Promise((resolve) => {
  let i = 0;
  const step = () => (++i >= k ? resolve() : requestAnimationFrame(step));
  requestAnimationFrame(step);
}), n);

const camera = (page) => page.evaluate(() => window.__explorer.getState());

/** 左上の表示の状態（表示・ボタンの aria-checked・強調の色・読み上げ）。 */
const titleState = (page) => page.evaluate(() => {
  const root = document.getElementById('title-mode');
  const group = document.getElementById('mode-switch');
  const btn = (m) => group.querySelector(`button[data-mode="${m}"]`);
  const style = (m) => { const s = getComputedStyle(btn(m)); return { color: s.color, border: s.borderBottomColor, bg: s.backgroundColor }; };
  const r = root.getBoundingClientRect();
  return {
    title: document.getElementById('app-title').textContent.trim(),
    rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
    role: group.getAttribute('role'),
    label: group.getAttribute('aria-label'),
    radios: [...group.querySelectorAll('[role="radio"]')].map((b) => ({ mode: b.dataset.mode, text: b.innerText.replace(/\s+/g, ' ').trim(), checked: b.getAttribute('aria-checked') })),
    keyHint: document.getElementById('mode-key-hint').innerText,
    style: { overview: style('overview'), fly: style('fly') },
    live: document.getElementById('mode-live').textContent,
    debug: window.__explorer.modeSwitch.getState(),
    hud: document.getElementById('hud').innerText,
    active: document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.mode ?? null : null,
  };
});

/** 表示がモード `mode` を示しているか（aria-checked・検証用の状態・強調の色）。 */
function shows(t, mode) {
  const other = mode === 'fly' ? 'overview' : 'fly';
  const checked = t.radios.filter((r) => r.checked === 'true').map((r) => r.mode);
  return checked.length === 1 && checked[0] === mode && t.debug.mode === mode && t.debug.checked.join() === mode
    && t.style[mode].color === 'rgb(255, 194, 51)' && t.style[other].color !== t.style[mode].color;
}

async function waitMode(page, mode, maxFrames = 60) {
  for (let i = 0; i < maxFrames; i++) {
    if ((await camera(page)).mode === mode) break;
    await frames(page, 1);
  }
  await frames(page, 2);
  await page.waitForTimeout(350); // 強調の色の移り変わり（0.25 秒）が終わるまで
}

/** 画面に見えていて、キャンバスが一番上にあり、投影した中心で pick するとその点が返る点（大きく見えるものから）。 */
async function findVisiblePoint(page, minPx = 6) {
  return page.evaluate(async (minPx) => {
    const ex = window.__explorer;
    const canvas = document.querySelector('#app canvas');
    const cands = [];
    for (let i = 0; i < ex.picking.count; i++) {
      const p = ex.picking.project(i);
      if (p.depth <= 0 || p.faded || p.sizePx < minPx) continue;
      const x = Math.round(p.clientX), y = Math.round(p.clientY);
      if (x < 40 || y < 40 || x > innerWidth - 40 || y > innerHeight - 40) continue;
      cands.push({ i, x, y, sizePx: p.sizePx });
    }
    cands.sort((a, b) => b.sizePx - a.sizePx);
    for (const c of cands.slice(0, 200)) {
      if (document.elementFromPoint(c.x, c.y) !== canvas) continue;
      const r = await ex.pick(c.x, c.y);
      if (r && r.index === c.i && r.pixelDistance === 0) return c;
    }
    return null;
  }, minPx);
}

// ---------- 左上の表示と、モードの切り替え ----------

async function testTitleAndMode(browser, base) {
  console.log('\n[左上のタイトルとモード名]');
  const page = await openPage(browser, base, { width: 1280, height: 800 });
  const s0 = await camera(page);
  const t0 = await titleState(page);
  check('左上に作品タイトル「3D UMAP Explorer」が出る', t0.title === '3D UMAP Explorer' && t0.rect.left < 40 && t0.rect.top < 40, JSON.stringify(t0.rect));
  check('モードの表示は「カメラのモード」の 2 択（radiogroup と radio が 2 つ）', t0.role === 'radiogroup' && t0.label === 'カメラのモード' && t0.radios.length === 2
    && t0.radios[0].text.startsWith('俯瞰') && t0.radios[1].text.startsWith('飛行'), JSON.stringify(t0.radios));
  check('それぞれのモードに短い説明が添えてある', t0.radios.every((r) => r.text.length > 4), t0.radios.map((r) => r.text).join(' | '));
  check('O キーで切り替わることを示すキーの表示がある', /O/.test(t0.keyHint), JSON.stringify(t0.keyHint));
  check(`起動時のモード（${s0.mode}）と表示が一致し、いまのモードだけが強調される`, shows(t0, s0.mode), JSON.stringify({ radios: t0.radios, style: t0.style }));
  check('起動時には読み上げに知らせない', t0.live === '', JSON.stringify(t0.live));
  check('HUD にはモード名の表記がない（左上へ移した）。飛行速度と操作説明は残る', !/モード (飛行|俯瞰)/.test(t0.hud) && /飛行速度/.test(t0.hud) && /O 俯瞰モードへ/.test(t0.hud), JSON.stringify(t0.hud.split('\n').slice(0, 3)));
  await page.screenshot({ path: path.join(outDir, 'layout-start.png') });

  // O キー
  await page.keyboard.press('KeyO');
  await waitMode(page, 'overview');
  const t1 = await titleState(page);
  check('O キーで俯瞰モードへ。表示が追従する', (await camera(page)).mode === 'overview' && shows(t1, 'overview'), JSON.stringify(t1.debug));
  check('切り替わったことを読み上げに知らせる', t1.live === 'カメラのモード: 俯瞰（外から回して眺める）', JSON.stringify(t1.live));
  check('HUD の操作説明は俯瞰モードのもの', /O 飛行モードへ/.test(t1.hud) && !/モード 俯瞰/.test(t1.hud));
  await page.screenshot({ path: path.join(outDir, 'layout-overview.png') });
  await page.keyboard.press('KeyO');
  await waitMode(page, 'fly');
  const t2 = await titleState(page);
  check('もう一度 O キーで飛行モードへ。表示と読み上げが追従する', shows(t2, 'fly') && t2.live === 'カメラのモード: 飛行（中へ入って飛ぶ）', JSON.stringify({ d: t2.debug, live: t2.live }));

  // クリック
  await page.click('#mode-switch button[data-mode="overview"]');
  await waitMode(page, 'overview');
  const t3 = await titleState(page);
  check('「俯瞰」をクリックすると俯瞰モードへ。表示が追従する', (await camera(page)).mode === 'overview' && shows(t3, 'overview'), JSON.stringify(t3.debug));
  check('クリックのあとはボタンにフォーカスを残さない（移動キーがすぐに効く）', t3.active === null, `フォーカス ${t3.active}`);
  await page.click('#mode-switch button[data-mode="overview"]');
  await frames(page, 3);
  check('選択中の「俯瞰」をもう一度クリックしても、俯瞰のまま', (await camera(page)).mode === 'overview' && shows(await titleState(page), 'overview'));
  await page.click('#mode-switch button[data-mode="fly"]');
  await waitMode(page, 'fly');
  const c0 = await camera(page);
  check('「飛行」をクリックすると飛行モードへ。表示が追従する', c0.mode === 'fly' && shows(await titleState(page), 'fly'));
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(400);
  await page.keyboard.up('KeyW');
  await frames(page, 3);
  check('クリックで飛行モードにしたあと、すぐに W で前へ進む', len(sub((await camera(page)).position, c0.position)) > 1e-3);

  // 点のダブルクリック（俯瞰 → 飛行の自動の切り替え）
  await page.evaluate((v) => window.__explorer.setView({ pos: v.pos, look: v.look }), EDGE_VIEW);
  await frames(page, 3);
  await page.keyboard.press('KeyO');
  await waitMode(page, 'overview');
  check('前提: 俯瞰モードで、表示も俯瞰', shows(await titleState(page), 'overview'));
  const p = await findVisiblePoint(page, 6);
  check('前提: ダブルクリックできる点が見つかる', !!p, JSON.stringify(p));
  if (p) {
    await page.mouse.dblclick(p.x, p.y);
    await waitMode(page, 'fly', 120);
    const t4 = await titleState(page);
    check('点のダブルクリックで飛行モードへ自動で切り替わり、表示が追従する', (await camera(page)).mode === 'fly' && shows(t4, 'fly') && t4.live === 'カメラのモード: 飛行（中へ入って飛ぶ）', JSON.stringify(t4.debug));
    await page.waitForFunction(() => !window.__explorer.getState().homing, null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }
  await page.close();
}

async function testKeyboard(browser, base) {
  console.log('\n[キーボードでの切り替え]');
  const page = await openPage(browser, base, { width: 1280, height: 800 });
  check('前提: 起動時は飛行モード', (await camera(page)).mode === 'fly');
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('Tab');
  const f1 = await page.evaluate(() => {
    const a = document.activeElement;
    const s = getComputedStyle(a);
    return { mode: a.dataset?.mode ?? null, role: a.getAttribute('role'), checked: a.getAttribute('aria-checked'), outline: s.outlineStyle, outlineWidth: s.outlineWidth, focusVisible: a.matches(':focus-visible') };
  });
  check('Tab で最初に「俯瞰」のボタンへフォーカスが移り、フォーカスの枠が見える', f1.mode === 'overview' && f1.role === 'radio' && f1.focusVisible && f1.outline !== 'none' && f1.outlineWidth !== '0px', JSON.stringify(f1));
  await page.keyboard.press('Enter');
  await waitMode(page, 'overview');
  const t1 = await titleState(page);
  check('Enter で俯瞰モードへ。aria-checked にいまの選択が出る。フォーカスはボタンに残る', (await camera(page)).mode === 'overview' && shows(t1, 'overview') && t1.active === 'overview', JSON.stringify(t1.radios));
  await page.keyboard.press('Tab');
  check('Tab で「飛行」のボタンへ移る', (await titleState(page)).active === 'fly');
  await page.keyboard.press('Space');
  await waitMode(page, 'fly');
  const t2 = await titleState(page);
  check('Space で飛行モードへ。aria-checked にいまの選択が出る', (await camera(page)).mode === 'fly' && shows(t2, 'fly') && t2.radios.find((r) => r.mode === 'fly').checked === 'true', JSON.stringify(t2.radios));

  // フォーカスがある間の移動キー（飛行モード）
  const before = await camera(page);
  for (const key of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyE', 'KeyQ']) {
    await page.keyboard.down(key);
    await page.waitForTimeout(120);
    await page.keyboard.up(key);
  }
  await frames(page, 4);
  const after = await camera(page);
  const t3 = await titleState(page);
  check('ボタンにフォーカスがある間は、WASD・E・Q でカメラが動かず、モードも変わらない', len(sub(after.position, before.position)) < 1e-9 && after.mode === 'fly' && shows(t3, 'fly') && t3.active === 'fly',
    `移動 ${len(sub(after.position, before.position)).toExponential(2)}、モード ${after.mode}、フォーカス ${t3.active}`);
  // 矢印キー: 選択を移すだけで、カメラは動かない（二重に働かない）
  await page.keyboard.down('ArrowLeft');
  await page.waitForTimeout(250);
  await page.keyboard.up('ArrowLeft');
  await waitMode(page, 'overview');
  const a1 = await camera(page);
  const t4 = await titleState(page);
  check('矢印キー（←）は選択を「俯瞰」へ移すだけで、カメラは動かない', a1.mode === 'overview' && shows(t4, 'overview') && t4.active === 'overview' && len(sub(a1.position, after.position)) < 1e-9,
    `モード ${a1.mode}、フォーカス ${t4.active}、移動 ${len(sub(a1.position, after.position)).toExponential(2)}`);
  await page.keyboard.press('ArrowRight');
  await waitMode(page, 'fly');
  const a2 = await camera(page);
  check('矢印キー（→）で「飛行」へ戻る。カメラは動かない', a2.mode === 'fly' && shows(await titleState(page), 'fly') && len(sub(a2.position, a1.position)) < 1e-9);
  // フォーカスを外すと、移動キーはいつもどおり働く
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(400);
  await page.keyboard.up('KeyW');
  await frames(page, 3);
  check('フォーカスを外すと、W で前へ進む', len(sub((await camera(page)).position, a2.position)) > 1e-3);
  await page.close();

  // 「動きを減らす」では、切り替えの色の移り変わりを付けない
  const pr = await openPage(browser, base, { width: 1280, height: 800, reducedMotion: 'reduce' });
  const durReduce = await pr.evaluate(() => getComputedStyle(document.querySelector('#mode-switch .mode-option')).transitionDuration);
  await pr.close();
  const pn = await openPage(browser, base, { width: 1280, height: 800 });
  const durNormal = await pn.evaluate(() => getComputedStyle(document.querySelector('#mode-switch .mode-option')).transitionDuration);
  await pn.close();
  check('切り替えの色の移り変わりは控えめで、「動きを減らす」では付けない', /^0\.[1-4]\d*s/.test(durNormal) && durReduce.split(',').every((d) => parseFloat(d) === 0), `通常 ${durNormal}、動きを減らす ${durReduce}`);
}

// ---------- 各ビューポートでの配置 ----------

const LAYOUT_IDS = ['title-mode', 'dataset-switcher', 'umap-panel', 'info', 'minimap', 'hud', 'cluster-location'];

async function testViewport(browser, base, { width, height, query = '', name }) {
  console.log(`\n[${width}×${height}${query ? `（${query}）` : ''}: 配置]`);
  const page = await openPage(browser, base, { width, height, query });
  await page.evaluate(() => window.__explorer.interaction.select(123));
  await page.evaluate(() => window.__explorer.umap.open());
  await page.waitForFunction(() => !document.getElementById('umap-panel').hidden && !document.getElementById('info').hidden, null, { timeout: 60000 });
  await page.waitForFunction(() => { const s = window.__explorer.neighbors.getState(); return !s || s.list?.kind !== 'loading'; }, null, { timeout: 60000 }).catch(() => {});
  await frames(page, 8);
  const r = await page.evaluate((ids) => {
    const out = {};
    for (const id of ids) {
      const el = document.getElementById(id);
      if (!el || el.hidden) { out[id] = null; continue; }
      const b = el.getBoundingClientRect();
      out[id] = b.width > 0 && b.height > 0 ? { left: b.left, top: b.top, right: b.right, bottom: b.bottom } : null;
    }
    const panels = document.getElementById('top-panels');
    return { rects: out, vw: innerWidth, vh: innerHeight, panelsScroll: panels.scrollTop };
  }, LAYOUT_IDS);
  const fmt = (b) => b && `${Math.round(b.left)},${Math.round(b.top)}–${Math.round(b.right)},${Math.round(b.bottom)}`;
  console.log('     ', Object.entries(r.rects).map(([k, b]) => `${k} ${fmt(b)}`).join(' / '));
  const required = ['title-mode', 'dataset-switcher', 'umap-panel', 'info', 'minimap', 'hud'];
  check(`${name}: 左上の要素・選択欄・UMAP のパネル・情報パネル・ミニマップ・HUD がすべて出ている`, required.every((id) => r.rects[id]), required.filter((id) => !r.rects[id]).join(','));
  const present = Object.entries(r.rects).filter(([, b]) => b);
  const outside = present.filter(([, b]) => b.left < -0.5 || b.top < -0.5 || b.right > r.vw + 0.5 || b.bottom > r.vh + 0.5).map(([k]) => k);
  check(`${name}: どれもビューポートの中に収まる`, outside.length === 0, outside.join(','));
  const overlaps = [];
  for (let i = 0; i < present.length; i++) for (let j = i + 1; j < present.length; j++) {
    const [ka, a] = present[i], [kb, b] = present[j];
    if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) overlaps.push(`${ka}×${kb}`);
  }
  check(`${name}: 互いに重ならない`, overlaps.length === 0, overlaps.join(', '));
  const t = r.rects['title-mode'], sw = r.rects['dataset-switcher'];
  check(`${name}: タイトルとモードは左上、選択欄は右上`, t && sw && t.left < 20 && t.top < 20 && sw.right > r.vw - 20 && sw.top < (width < 720 ? t.bottom + 20 : 20), `${fmt(t)} / ${fmt(sw)}`);
  const um = r.rects['umap-panel'], inf = r.rects.info;
  check(`${name}: UMAP のパネルと情報パネルは、どちらも読める高さで出ている（それぞれの中でスクロールする）。並びのスクロールはない`, um && inf && um.bottom - um.top >= 80 && inf.bottom - inf.top >= 100 && r.panelsScroll === 0,
    `UMAP ${um && Math.round(um.bottom - um.top)}px、情報 ${inf && Math.round(inf.bottom - inf.top)}px、並びのスクロール ${r.panelsScroll}`);
  // パネルの中の操作: UMAP の「計算」ボタンと、情報パネルの閉じるボタンが、その位置で一番上にある（クリックできる）
  const hit = await page.evaluate(() => ['umap-run', 'info-close', 'umap-close'].map((id) => {
    const el = document.getElementById(id);
    el.scrollIntoView({ block: 'nearest' });
    const b = el.getBoundingClientRect();
    const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return [id, !!top && (top === el || el.contains(top))];
  }));
  check(`${name}: パネルの中のボタン（計算・閉じる）が、その位置で操作できる`, hit.every(([, ok]) => ok), JSON.stringify(hit));
  await page.evaluate(() => { for (const id of ['umap-panel', 'info']) document.getElementById(id).scrollTop = 0; });
  await frames(page, 2);
  await page.screenshot({ path: path.join(outDir, `layout-${name}.png`) });
  console.log(`      スクリーンショット → artifacts/layout-${name}.png`);
  // 選択だけ（UMAP のパネルを閉じた状態）のスクリーンショット
  await page.evaluate(() => window.__explorer.umap.close());
  await frames(page, 4);
  await page.screenshot({ path: path.join(outDir, `layout-${name}-selected.png`) });
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
    await testTitleAndMode(browser, base);
    await testKeyboard(browser, base);
    await testViewport(browser, base, { width: 1280, height: 800, query: 'data=word2vec-10k', name: '1280x800-word2vec' });
    await testViewport(browser, base, { width: 1280, height: 800, name: '1280x800' });
    await testViewport(browser, base, { width: 1280, height: 480, name: '1280x480' });
    await testViewport(browser, base, { width: 360, height: 740, name: '360x740' });
  } finally {
    if (browser) await browser.close();
    stop();
  }
  check('コンソールエラーがない', consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' | '));
  console.log(failures ? `\n失敗 ${failures} 件` : '\nすべて OK');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
