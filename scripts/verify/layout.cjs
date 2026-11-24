#!/usr/bin/env node
/**
 * 画面の上部の配置（左上に作品タイトルとカメラのモード、右上にデータセットの選択欄・UMAP の再計算のパネル・情報パネル）を確かめる。
 *
 *   node scripts/verify/layout.cjs [--no-build] [--port 4360] [--out artifacts]
 *
 * - 左上にタイトルとモード名が出て、起動時のモードと一致する
 * - O キー、モード名のクリック、点のダブルクリック（俯瞰から飛行へ自動で切り替わる）のそれぞれで、表示が追従する。読み上げにも知らせる
 * - キーボード（Tab と Enter・Space・矢印）でモードを切り替えられ、aria-checked にいまの選択が出る。
 *   Tab の順に入るのは選択中のボタンだけ（tabindex 0。もう一方は -1）で、Tab で止まるのは 1 回。矢印キーで選択が移り、tabindex が入れ替わる。
 *   切り替えのボタンにフォーカスがある間に WASD・矢印を押しても、カメラは動かず、二重の動作も起きない
 * - データセットの切り替えに失敗して前のデータで表示を作り直したあと（俯瞰モードの最中でも）、左上の表示が実際のカメラのモードと一致する
 * - 1280×800、1280×480、360×740 の各ビューポートで、左上の要素・選択欄の行・UMAP のパネル（開いた状態）・情報パネル（点を選択した状態）・
 *   ミニマップ・HUD（と現在地）の矩形が、互いに重ならず、ビューポートの中に収まる
 * - 幅 900px と 1100px で、パネルを開いた状態の上部の高さ（--top-bar-height）が、60 フレームの間に変化しない
 * - 左下の HUD は、要約（飛行速度と自動調整）と、開閉できる詳細（データセット・操作説明・視点）に分かれる。
 *   幅 1280 では開いた状態で始まり（詳細の文面は従来どおり）、幅 360 では畳んだ状態（高さ 60px 以下、点群の見える範囲が画面の高さの 40% 以上）で始まる。
 *   ボタンと ? キーで開閉でき（aria-expanded が追従、入力欄の中では働かない）、開いたときは画面の高さの 45% 以下で、中がスクロールする。
 *   開閉のあとも、現在地の表示・上部の配置・単語の文字が避ける矩形が HUD に追従する。利用者の選択は、画面の幅が変わっても保つ
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
    radios: [...group.querySelectorAll('[role="radio"]')].map((b) => ({ mode: b.dataset.mode, text: b.innerText.replace(/\s+/g, ' ').trim(), checked: b.getAttribute('aria-checked'), tabindex: b.getAttribute('tabindex') })),
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
  const tabbable = t.radios.filter((r) => r.tabindex === '0').map((r) => r.mode);
  return checked.length === 1 && checked[0] === mode && t.debug.mode === mode && t.debug.checked.join() === mode
    && tabbable.length === 1 && tabbable[0] === mode && t.radios.find((r) => r.mode === other).tabindex === '-1' && t.debug.tabStops.join() === mode
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
  const t00 = await titleState(page);
  check('Tab の順に入るのは選択中の「飛行」だけ（tabindex 0）。「俯瞰」は外れている（-1）', shows(t00, 'fly') && t00.radios.map((r) => `${r.mode}:${r.tabindex}`).join() === 'overview:-1,fly:0', JSON.stringify(t00.radios));
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('Tab');
  const f1 = await page.evaluate(() => {
    const a = document.activeElement;
    const s = getComputedStyle(a);
    return { mode: a.dataset?.mode ?? null, role: a.getAttribute('role'), checked: a.getAttribute('aria-checked'), outline: s.outlineStyle, outlineWidth: s.outlineWidth, focusVisible: a.matches(':focus-visible') };
  });
  check('Tab で最初に、選択中の「飛行」のボタンへフォーカスが移り、フォーカスの枠が見える', f1.mode === 'fly' && f1.role === 'radio' && f1.checked === 'true' && f1.focusVisible && f1.outline !== 'none' && f1.outlineWidth !== '0px', JSON.stringify(f1));
  // Tab で切り替えのボタンに止まるのは 1 回だけ（ラジオグループの作法）。Tab を押し続け、同じ要素へ戻るまでの 1 周で、切り替えのボタンに止まった回数を数える
  const lap = [];
  const seen = new Set();
  for (let k = 0; k < 120; k++) {
    await page.keyboard.press('Tab');
    const e = await page.evaluate(() => {
      const a = document.activeElement;
      return { key: a ? [...document.querySelectorAll('*')].indexOf(a) : -1, mode: a?.dataset?.mode ?? null };
    });
    if (seen.has(e.key)) break;
    seen.add(e.key);
    lap.push(e);
  }
  const stopped = lap.filter((e) => e.mode).map((e) => e.mode);
  check('Tab で切り替えのボタンに止まるのは 1 回だけ（選択中のボタン）', lap.length >= 3 && lap.length < 120 && stopped.length === 1 && stopped[0] === 'fly', `1 周 ${lap.length} 要素のうち、止まった回数 ${stopped.length}（${stopped.join(',')}）`);
  await page.evaluate(() => document.activeElement?.blur());
  // 矢印キー: 選択が移り、tabindex が入れ替わる（フォーカスも新しい選択へ移る）
  await page.focus('#mode-switch button[data-mode="fly"]');
  await page.keyboard.press('ArrowLeft');
  await waitMode(page, 'overview');
  const k1 = await titleState(page);
  check('矢印キー（←）で選択が「俯瞰」へ移り、tabindex が入れ替わる（俯瞰 0・飛行 -1）。フォーカスも移る',
    (await camera(page)).mode === 'overview' && shows(k1, 'overview') && k1.radios.map((r) => `${r.mode}:${r.tabindex}`).join() === 'overview:0,fly:-1' && k1.active === 'overview', JSON.stringify(k1.radios));
  await page.keyboard.press('ArrowRight');
  await waitMode(page, 'fly');
  const k2 = await titleState(page);
  check('矢印キー（→）で選択が「飛行」へ戻り、tabindex も戻る（俯瞰 -1・飛行 0）', (await camera(page)).mode === 'fly' && shows(k2, 'fly') && k2.radios.map((r) => `${r.mode}:${r.tabindex}`).join() === 'overview:-1,fly:0' && k2.active === 'fly', JSON.stringify(k2.radios));
  await page.evaluate(() => document.activeElement?.blur());
  // Enter・Space（Tab の順から外れているボタンも、フォーカスがあれば押せる）
  await page.focus('#mode-switch button[data-mode="overview"]');
  await page.keyboard.press('Enter');
  await waitMode(page, 'overview');
  const t1 = await titleState(page);
  check('Enter で俯瞰モードへ。aria-checked にいまの選択が出る。フォーカスはボタンに残る', (await camera(page)).mode === 'overview' && shows(t1, 'overview') && t1.active === 'overview', JSON.stringify(t1.radios));
  await page.focus('#mode-switch button[data-mode="fly"]');
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

// ---------- 表示の作り直しに失敗したあとのモードの表示 ----------

async function testFailedSwitch(browser, base) {
  console.log('\n[データセットの切り替えに失敗したあとの、左上のモードの表示]');
  const page = await openPage(browser, base, { width: 1280, height: 800 });
  await page.keyboard.press('KeyO');
  await waitMode(page, 'overview');
  check('前提: 俯瞰モードで、表示も俯瞰', (await camera(page)).mode === 'overview' && shows(await titleState(page), 'overview'));
  const gen = (await page.evaluate(() => window.__explorer.dataset.getState())).generation;
  await page.evaluate(() => { window.__explorer.faults.view = 1; });
  // 失敗の直後（次のフレームの前）の、左上の表示と実際のモード。HUD は 0.25 秒ごとにも更新されるので、直後に読まないと、失敗の処理が表示を合わせたのか、定期の更新で合ったのかが区別できない
  const { r, justAfter } = await page.evaluate(async () => {
    const ex = window.__explorer;
    const r = await ex.dataset.switchTo('word2vec-10k');
    return { r, justAfter: { shown: ex.modeSwitch.getState().mode, actual: ex.getState().mode } };
  });
  await frames(page, 3);
  await page.waitForTimeout(350); // 強調の色の移り変わり（0.25 秒）が終わるまで
  const d = await page.evaluate(() => window.__explorer.dataset.getState());
  check('前提: 表示の生成を失敗させると、エラーを報告し、前のデータ（MNIST）の表示を保つ', !r.ok && d.current?.id === 'mnist' && d.generation === gen, JSON.stringify({ r, current: d.current }));
  check('失敗の直後（次のフレームの前）に、左上の表示が、作り直した表示の実際のモードに追従している', justAfter.shown === justAfter.actual, JSON.stringify(justAfter));
  const cam = await camera(page);
  const t = await titleState(page);
  check(`作り直した表示のモード（${cam.mode}）と、左上の表示（aria-checked・強調・tabindex）が一致する`, shows(t, cam.mode), JSON.stringify({ camera: cam.mode, debug: t.debug, radios: t.radios }));
  check('HUD の操作説明も、作り直した表示のモードのもの', cam.mode === 'fly' ? /O 俯瞰モードへ/.test(t.hud) : /O 飛行モードへ/.test(t.hud), JSON.stringify(t.hud.split('\n').slice(0, 3)));
  // そのあとの O キーでも、表示が追従する
  const next = cam.mode === 'fly' ? 'overview' : 'fly';
  await page.keyboard.press('KeyO');
  await waitMode(page, next);
  check('そのあとの O キーでの切り替えにも、表示が追従する', (await camera(page)).mode === next && shows(await titleState(page), next));
  await page.close();
}

// ---------- 上部の高さが落ち着くこと ----------

async function testTopBarStable(browser, base, width, height) {
  console.log(`\n[${width}×${height}: パネルを開いた状態で、上部の高さ（--top-bar-height）が変化しない]`);
  const page = await openPage(browser, base, { width, height, query: 'data=word2vec-10k' });
  await page.evaluate(() => window.__explorer.interaction.select(123));
  await page.evaluate(() => window.__explorer.umap.open());
  await page.waitForFunction(() => !document.getElementById('umap-panel').hidden && !document.getElementById('info').hidden, null, { timeout: 60000 });
  await page.waitForFunction(() => { const s = window.__explorer.neighbors.getState(); return !s || s.list?.kind !== 'loading'; }, null, { timeout: 60000 }).catch(() => {});
  await frames(page, 8);
  const rec = await page.evaluate(() => new Promise((resolve) => {
    const out = [];
    const bar = document.getElementById('top-bar');
    const panels = document.getElementById('top-panels');
    const step = () => {
      out.push({ h: bar.style.getPropertyValue('--top-bar-height'), scroll: panels.scrollHeight > panels.clientHeight + 0.5 });
      if (out.length >= 60) resolve(out); else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }));
  const values = [...new Set(rec.map((x) => x.h))];
  check(`${width}×${height}: 60 フレームの間、--top-bar-height が変化しない`, values.length === 1 && /^\d+px$/.test(values[0]), `値 ${values.join(' → ')}（並びのスクロール ${[...new Set(rec.map((x) => x.scroll))].join('/')}）`);
  await page.close();
}

// ---------- 各ビューポートでの配置 ----------

const LAYOUT_IDS = ['title-mode', 'dataset-switcher', 'umap-panel', 'info', 'minimap', 'hud', 'cluster-location'];

async function testViewport(browser, base, { width, height, query = '', name, hudOpen = false }) {
  console.log(`\n[${width}×${height}${query ? `（${query}）` : ''}${hudOpen ? '、HUD を開く' : ''}: 配置]`);
  const page = await openPage(browser, base, { width, height, query });
  if (hudOpen) await page.evaluate(() => window.__explorer.hud.setExpanded(true));
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


// ---------- 左下の HUD（要約と、開閉できる詳細）----------

/** HUD まわりの、いまの状態と矩形。 */
const readHudLayout = (page) => page.evaluate(() => {
  const rect = (id) => {
    const el = document.getElementById(id);
    if (!el || el.hidden) return null;
    const b = el.getBoundingClientRect();
    return b.width > 0 && b.height > 0 ? { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height } : null;
  };
  const detail = document.getElementById('hud-detail');
  const dstyle = getComputedStyle(detail);
  const topUi = ['title-mode', 'dataset-switcher', 'umap-panel', 'info'].map(rect).filter(Boolean);
  return {
    vw: innerWidth, vh: innerHeight,
    state: window.__explorer.hud.getState(),
    aria: document.getElementById('hud-toggle').getAttribute('aria-expanded'),
    controls: document.getElementById('hud-toggle').getAttribute('aria-controls'),
    detailHidden: detail.hidden, detailDisplay: dstyle.display, detailOverflowY: dstyle.overflowY, detailPointer: dstyle.pointerEvents,
    detailScroll: { top: detail.scrollTop, height: detail.scrollHeight, client: detail.clientHeight },
    hud: rect('hud'), loc: rect('cluster-location'), bar: rect('hud-bar'), topBar: rect('top-bar'), minimap: rect('minimap'),
    locVar: document.getElementById('cluster-location').style.getPropertyValue('--hud-height'),
    visibleText: document.getElementById('hud').innerText,
    focus: document.activeElement ? document.activeElement.id || document.activeElement.tagName : null,
    topUiBottom: Math.max(0, ...topUi.map((r) => r.bottom)),
  };
});

const overlapsRect = (a, b) => !!a && !!b && a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;

/** 開閉のあと、現在地の表示・上部の配置・HUD の高さの変数が HUD に追従しているか。 */
function checkHudFollow(name, h) {
  const hh = h.hud ? h.hud.height : 0;
  check(`${name}: 現在地の表示が出ていて、HUD と重ならず、HUD の上にある`, !!h.loc && !overlapsRect(h.loc, h.hud) && h.loc.bottom <= h.hud.top + 0.5,
    `現在地 ${h.loc && Math.round(h.loc.top)}–${h.loc && Math.round(h.loc.bottom)}、HUD の上端 ${h.hud && Math.round(h.hud.top)}`);
  check(`${name}: 現在地の表示の --hud-height が、HUD の高さ（${hh.toFixed(1)}px）に追従する`, Math.abs(parseFloat(h.locVar) - Math.round(hh)) <= 1, `--hud-height ${h.locVar}`);
  check(`${name}: 上部の領域（右上の列）が、HUD と現在地の上に収まる（TopLayout が追従する）`, !!h.topBar && h.topBar.bottom <= Math.min(h.hud.top, h.loc ? h.loc.top : Infinity) + 0.5,
    `上部の下端 ${h.topBar && Math.round(h.topBar.bottom)}、HUD の上端 ${h.hud && Math.round(h.hud.top)}、現在地の上端 ${h.loc && Math.round(h.loc.top)}`);
}

/** 現在地の表示が出る視点（クラスタの縁）へ移す。 */
async function showLocation(page) {
  await page.evaluate((v) => window.__explorer.setView({ pos: v.pos, look: v.look }), EDGE_VIEW);
  await page.waitForFunction(() => !document.getElementById('cluster-location').hidden, null, { timeout: 20000 }).catch(() => {});
  await frames(page, 4);
}

async function testHudWide(browser, base) {
  console.log('\n[HUD: 幅 1280×800（開いた状態で始まる）]');
  const page = await openPage(browser, base, { width: 1280, height: 800 });
  const h0 = await readHudLayout(page);
  const d = h0.state.detail;
  check('幅 1280 では、詳細を開いた状態で始まる（利用者の操作はまだない）。aria-expanded も開', h0.state.expanded && !h0.state.userChosen && h0.aria === 'true' && !h0.detailHidden && h0.controls === 'hud-detail', JSON.stringify({ e: h0.state.expanded, u: h0.state.userChosen, aria: h0.aria }));
  check('詳細の文面は従来と同じ（データセットの名前・点の数・点の大きさ、操作説明、視点の URL パラメータ）',
    /^MNIST.+ {2}10,000 点 {2}点の大きさ 0\.00400（\[ \] で変更）$/.test(d[0])
    && d[1] === 'WASD 前後左右 / E Q 上下 / ドラッグ 視点 / ホイール 速度 / T 速度の自動調整 / H 全体へ戻る / O 俯瞰モードへ / L 目印の表示 / N 元のデータで近い点 / M ミニマップ'
    && /^\?pos=-?[\d.]+,-?[\d.]+,-?[\d.]+&look=-?[\d.]+,-?[\d.]+,-?[\d.]+$/.test(d[2]), JSON.stringify(d));
  const lines = h0.visibleText.split('\n').filter((x) => x.trim());
  const at = (t) => lines.findIndex((x) => x === t);
  check('画面に見える文面は、要約・データセット・操作説明・視点の順で、最終行は視点（ボタンの名前を除く）', lines.some((x) => x === h0.state.summary) && at(d[0]) > at(h0.state.summary) && at(d[1]) === at(d[0]) + 1 && at(d[2]) === lines.length - 1 && lines[0].startsWith('操作説明'), JSON.stringify(lines.slice(0, 2)));
  check('要約は飛行速度と自動調整の状態（1 行）', /^飛行速度 \d\.\d+ {2}自動調整 入 {2}実速度 \d/.test(h0.state.summary) && !h0.state.summary.includes('\n'), JSON.stringify(h0.state.summary));
  check('通知はない（通知の行は出ていない）', h0.state.notice === null && !(await page.evaluate(() => !document.getElementById('hud-notice').hidden)));
  await page.screenshot({ path: path.join(outDir, 'layout-1280x800-hud-open.png') });

  // ボタンで畳む。文面は DOM に残る
  await page.click('#hud-toggle');
  await frames(page, 3);
  const h1 = await readHudLayout(page);
  check('ボタンで畳める。aria-expanded が閉に変わり、詳細は表示されない（要素と文面は DOM に残る）', !h1.state.expanded && h1.state.userChosen && h1.aria === 'false' && h1.detailHidden && h1.detailDisplay === 'none'
    && h1.state.detail.join('|') === d.join('|') && !h1.visibleText.includes('O 俯瞰モードへ'), JSON.stringify({ e: h1.state.expanded, aria: h1.aria, display: h1.detailDisplay }));
  check('畳むと HUD が低くなる。要約は見えたまま', h1.hud.height < h0.hud.height / 2 && h1.visibleText.includes(h1.state.summary), `${Math.round(h0.hud.height)}px → ${Math.round(h1.hud.height)}px`);
  check('マウスで押したあとは、ボタンにフォーカスを残さない（移動キーがすぐに効く）', h1.focus !== 'hud-toggle', `フォーカス ${h1.focus}`);
  // ? キー（Shift + /）
  await page.keyboard.press('Shift+Slash');
  await frames(page, 3);
  const h2 = await readHudLayout(page);
  check('? キー（Shift + /）で開く。aria-expanded が追従する', h2.state.expanded && h2.aria === 'true' && !h2.detailHidden && h2.visibleText.includes('O 俯瞰モードへ'), JSON.stringify({ e: h2.state.expanded, aria: h2.aria }));
  await page.keyboard.press('Slash'); // 修飾キーなしの / では働かない
  await frames(page, 2);
  check('修飾キーなしの / では開閉しない', (await readHudLayout(page)).state.expanded === true);
  await page.focus('#dataset-select');
  await page.keyboard.press('Shift+Slash'); // 入力欄（select）の中では働かない
  await frames(page, 2);
  check('入力欄（データセットの選択欄）にフォーカスがあるときは、? キーで開閉しない', (await readHudLayout(page)).state.expanded === true);
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press('Shift+Slash');
  await frames(page, 2);
  const h3 = await readHudLayout(page);
  check('? キーでもう一度押すと畳む', !h3.state.expanded && h3.aria === 'false');
  // ? の文字のキーイベントで開閉する（配列によって、? を打つ物理キーは違う）
  const press = (init) => page.evaluate((i) => window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...i })), init);
  await page.keyboard.press('?'); // US の配列: Shift + / で key が ?
  await frames(page, 2);
  check('? の文字のキー（Playwright の「?」）で開く', (await readHudLayout(page)).state.expanded === true);
  await press({ key: '_', code: 'Slash', shiftKey: true }); // ドイツ語の配列で Slash の位置のキーを Shift と押す
  await frames(page, 2);
  check('ドイツ語の配列で Slash の位置のキー（key は _）を Shift と押しても開閉しない', (await readHudLayout(page)).state.expanded === true);
  await press({ key: '?', code: 'Minus', shiftKey: true }); // ドイツ語の配列の ?
  await frames(page, 2);
  check('ドイツ語の配列の ?（Shift + Minus の位置で key が ?）で畳む', (await readHudLayout(page)).state.expanded === false);
  await press({ key: '?', code: 'KeyM', shiftKey: true }); // フランス語の配列の ?
  await frames(page, 2);
  check('フランス語の配列の ?（Shift + KeyM の位置で key が ?）で開く', (await readHudLayout(page)).state.expanded === true);
  await press({ key: '?', code: 'Slash', shiftKey: true, ctrlKey: true });
  await frames(page, 2);
  check('Ctrl を伴う ? では開閉しない', (await readHudLayout(page)).state.expanded === true);
  // 視点の行だけが変わっても、操作説明の行（と項目）の要素は作り直されない
  await page.evaluate(() => {
    const rows = [...document.getElementById('hud-detail').children];
    window.__hudRows = rows;
    window.__hudItems = [...rows[1].children];
    window.__hudViewText = rows[2].textContent;
  });
  const cam = await page.evaluate(() => window.__explorer.getState());
  await page.evaluate((c) => window.__explorer.setView({ pos: [c.position[0] + 0.3, c.position[1], c.position[2]], look: c.lookAt }), cam);
  await page.waitForFunction(() => document.getElementById('hud-detail').children[2].textContent !== window.__hudViewText, null, { timeout: 20000 }).catch(() => {});
  const keep = await page.evaluate(() => {
    const rows = [...document.getElementById('hud-detail').children];
    return {
      viewChanged: rows[2].textContent !== window.__hudViewText,
      rowsSame: rows.length === window.__hudRows.length && rows.every((r, i) => r === window.__hudRows[i]),
      itemsSame: rows[1].children.length === window.__hudItems.length && [...rows[1].children].every((c, i) => c === window.__hudItems[i]),
    };
  });
  check('カメラを動かして視点の行が変わっても、詳細の行と操作説明の項目の要素は同じまま', keep.viewChanged && keep.rowsSame && keep.itemsSame, JSON.stringify(keep));
  await page.keyboard.press('?'); // 畳んだ状態に戻す（このあとの確認は、畳んだ状態から始まる）
  await frames(page, 2);
  // 検証用の入口
  await page.evaluate(() => window.__explorer.hud.toggle());
  await frames(page, 2);
  check('検証用の入口（__explorer.hud）で、状態を読み、切り替えられる', (await readHudLayout(page)).state.expanded === true);
  await page.evaluate(() => window.__explorer.hud.setExpanded(false));
  await frames(page, 2);
  check('__explorer.hud.setExpanded(false) で畳める', (await readHudLayout(page)).aria === 'false');
  // 利用者が選んだあとは、画面の幅が変わっても選択を保つ（既定なら幅 360 は畳む）
  await page.evaluate(() => window.__explorer.hud.setExpanded(true));
  await page.setViewportSize({ width: 360, height: 740 });
  await frames(page, 4);
  const h4 = await readHudLayout(page);
  check('利用者が開いたあとは、幅が 360 に変わっても開いたまま（利用者の選択を優先）', h4.state.expanded && h4.state.userChosen && h4.aria === 'true' && !h4.detailHidden, JSON.stringify({ e: h4.state.expanded, vw: h4.vw }));
  await page.close();
}

async function testHudNarrow(browser, base) {
  console.log('\n[HUD: 幅 360×740（畳んだ状態で始まる）]');
  const page = await openPage(browser, base, { width: 360, height: 740 });
  const h0 = await readHudLayout(page);
  check('幅 360 では、詳細を畳んだ状態で始まる（利用者の操作はまだない）。aria-expanded も閉', !h0.state.expanded && !h0.state.userChosen && h0.aria === 'false' && h0.detailHidden && h0.detailDisplay === 'none', JSON.stringify({ e: h0.state.expanded, aria: h0.aria }));
  check('畳んだ HUD の高さが 60px 以下', h0.hud.height <= 60, `${h0.hud.height.toFixed(1)}px`);
  const cloud = h0.hud.top - h0.topUiBottom;
  check('点群の描かれる範囲（上部の UI の下端から HUD の上端）が、画面の高さの 40% 以上', cloud >= h0.vh * 0.4, `${Math.round(h0.topUiBottom)}〜${Math.round(h0.hud.top)} = ${Math.round(cloud)}px（${(cloud / h0.vh * 100).toFixed(1)}%）`);
  check('要約（飛行速度・自動調整・実速度）は畳んでいても読める。詳細は画面に出ない', /飛行速度/.test(h0.visibleText) && /自動調整 入/.test(h0.visibleText) && /実速度/.test(h0.visibleText) && !h0.visibleText.includes('WASD') && !h0.visibleText.includes('?pos='), JSON.stringify(h0.visibleText));
  check('畳んでいても、詳細の文面を検証用の入口から読める（要素は DOM に残る）', h0.state.detail.length === 3 && h0.state.detail[1].includes('H 全体へ戻る') && h0.state.detail[2].startsWith('?pos='), JSON.stringify(h0.state.detail.map((x) => x.slice(0, 30))));
  const btn = await page.evaluate(() => { const b = document.getElementById('hud-toggle'); const r = b.getBoundingClientRect(); return { text: b.innerText.replace(/\s+/g, ' ').trim(), title: b.title, w: r.width, h: r.height }; });
  check('開閉のボタンに「操作説明」の名前と ? のキーの表示がある', /^操作説明 \?/.test(btn.text) && btn.w > 40 && btn.h >= 16, JSON.stringify(btn));
  await showLocation(page);
  const hl = await readHudLayout(page);
  checkHudFollow('360×740（畳んだ状態）', hl);
  await page.screenshot({ path: path.join(outDir, 'layout-360x740-hud-collapsed.png') });

  // ボタンで開く
  await page.click('#hud-toggle');
  await frames(page, 4);
  const h1 = await readHudLayout(page);
  check('ボタンで開ける。aria-expanded が開に変わり、詳細（操作説明）が見える', h1.state.expanded && h1.aria === 'true' && !h1.detailHidden && h1.visibleText.includes('O 俯瞰モードへ') && h1.visibleText.includes('?pos='), JSON.stringify({ e: h1.state.expanded, aria: h1.aria }));
  check('開いた HUD の高さが、画面の高さの 45% 以下', h1.hud.height <= h1.vh * 0.45 + 0.5, `${h1.hud.height.toFixed(1)}px / ${(h1.vh * 0.45).toFixed(0)}px`);
  check('開いたとき、詳細は HUD の中でスクロールできる設定（overflow-y: auto。マウスの操作を受ける）', h1.detailOverflowY === 'auto' && h1.detailPointer === 'auto', JSON.stringify({ o: h1.detailOverflowY, p: h1.detailPointer }));
  checkHudFollow('360×740（開いた状態）', h1);
  const cloud1 = h1.hud.top - h1.topUiBottom;
  console.log(`      開いたとき: HUD ${Math.round(h1.hud.height)}px、点群の見える範囲 ${Math.round(cloud1)}px（${(cloud1 / h1.vh * 100).toFixed(1)}%）`);
  await page.screenshot({ path: path.join(outDir, 'layout-360x740-hud-open.png') });

  // ? キーで畳む → もう一度開く。そのたびに追従する
  await page.keyboard.press('Shift+Slash');
  await frames(page, 4);
  const h2 = await readHudLayout(page);
  check('? キーで畳める。aria-expanded が閉に変わる', !h2.state.expanded && h2.aria === 'false' && h2.hud.height <= 60, `${h2.hud.height.toFixed(1)}px`);
  checkHudFollow('360×740（? キーで畳んだあと）', h2);
  await page.keyboard.press('Shift+Slash');
  await frames(page, 4);
  const h3 = await readHudLayout(page);
  check('? キーで開ける', h3.state.expanded && h3.aria === 'true');
  checkHudFollow('360×740（? キーで開いたあと）', h3);
  await page.close();

  // 利用者が操作するまでは、画面の幅の既定に従う
  const wide = await openPage(browser, base, { width: 1280, height: 800 });
  await wide.setViewportSize({ width: 360, height: 740 });
  await frames(wide, 4);
  const w1 = await readHudLayout(wide);
  check('利用者が操作するまでは、画面の幅が 360 に変わると畳む', !w1.state.expanded && !w1.state.userChosen && w1.aria === 'false', JSON.stringify({ e: w1.state.expanded }));
  await wide.setViewportSize({ width: 720, height: 740 });
  await frames(wide, 4);
  check('幅が 720px になると開く（720px 以上が既定で開く）', (await readHudLayout(wide)).state.expanded === true);
  await wide.setViewportSize({ width: 719, height: 740 });
  await frames(wide, 4);
  check('幅が 719px では畳む', (await readHudLayout(wide)).state.expanded === false);
  await wide.close();
}

async function testHudScroll(browser, base) {
  console.log('\n[HUD: 縦の短い狭い画面（360×400）で開く]');
  const page = await openPage(browser, base, { width: 360, height: 400 });
  await page.keyboard.press('Shift+Slash');
  await frames(page, 4);
  const h = await readHudLayout(page);
  check('開いた HUD の高さが、画面の高さの 45% 以下（詳細の高さの上限）', h.state.expanded && h.hud.height <= h.vh * 0.45 + 0.5, `${h.hud.height.toFixed(1)}px / ${(h.vh * 0.45).toFixed(0)}px`);
  check('詳細が上限を超える分は、HUD の中でスクロールできる（内容が見えている高さより長い）', h.detailScroll.height > h.detailScroll.client + 1, JSON.stringify(h.detailScroll));
  const before = await page.evaluate(() => ({ speed: window.__explorer.getState().speed, barTop: document.getElementById('hud-bar').getBoundingClientRect().top }));
  const box = await page.evaluate(() => { const r = document.getElementById('hud-detail').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.move(box.x, box.y);
  await page.mouse.wheel(0, 80);
  await frames(page, 4);
  const after = await page.evaluate(() => ({ top: document.getElementById('hud-detail').scrollTop, speed: window.__explorer.getState().speed, barTop: document.getElementById('hud-bar').getBoundingClientRect().top }));
  check('詳細の上でホイールを回すと詳細がスクロールし（飛行速度は変わらず）、要約の行は動かない', after.top > 0 && after.speed === before.speed && Math.abs(after.barTop - before.barTop) < 0.5, JSON.stringify({ before, after }));
  await page.screenshot({ path: path.join(outDir, 'layout-360x400-hud-open.png') });
  await page.close();
}

async function testHudWords(browser, base) {
  console.log('\n[HUD: 単語の文字が避ける矩形（word2vec、360×740）]');
  const page = await openPage(browser, base, { width: 360, height: 740, query: 'data=word2vec-10k' });
  const obstacle = (hud) => page.evaluate((hud) => {
    const st = window.__explorer.words.getState();
    if (!st) return null;
    const r = document.getElementById('hud').getBoundingClientRect();
    return { hud: { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height },
      found: st.obstacles.some((o) => Math.abs(o.x - (r.left + r.width / 2)) < 1.5 && Math.abs(o.y - (r.top + r.height / 2)) < 1.5 && Math.abs(o.width - r.width) < 1.5 && Math.abs(o.height - r.height) < 1.5) };
  }, hud);
  await frames(page, 6);
  const a = await obstacle();
  check('畳んだ状態: 単語の文字が避ける矩形に、HUD の矩形が入っている', a && a.found, JSON.stringify(a));
  await page.keyboard.press('Shift+Slash');
  await frames(page, 6);
  const b = await obstacle();
  check('開いた状態: 避ける矩形が、開いた HUD の矩形に追従する', b && b.found && b.hud.height > (a ? a.hud.height : 0) * 2, JSON.stringify(b));
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
    await testFailedSwitch(browser, base);
    await testViewport(browser, base, { width: 1280, height: 800, query: 'data=word2vec-10k', name: '1280x800-word2vec' });
    await testViewport(browser, base, { width: 1280, height: 800, name: '1280x800' });
    await testViewport(browser, base, { width: 1280, height: 480, name: '1280x480' });
    await testViewport(browser, base, { width: 360, height: 740, name: '360x740' });
    for (const [w, h] of [[900, 700], [1100, 700], [900, 420], [1100, 420]]) await testTopBarStable(browser, base, w, h);
    await testViewport(browser, base, { width: 360, height: 740, name: '360x740-hud-open', hudOpen: true });
    await testHudWide(browser, base);
    await testHudNarrow(browser, base);
    await testHudScroll(browser, base);
    await testHudWords(browser, base);
  } finally {
    if (browser) await browser.close();
    stop();
  }
  check('コンソールエラーがない', consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' | '));
  console.log(failures ? `\n失敗 ${failures} 件` : '\nすべて OK');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
