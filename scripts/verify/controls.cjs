#!/usr/bin/env node
/**
 * カメラ操作の検証。ビルドしてプレビューサーバーを起動し、ヘッドレス Chromium へ実際のキー・マウス・
 * ホイールの入力を送って、飛行モードと俯瞰モードの動きを確かめる。
 *
 *   node scripts/verify/controls.cjs [--no-build] [--port 4318] [--out artifacts]
 *
 * ソフトウェア描画では 1 フレームが約 200 ミリ秒かかる。待ち時間は壁時計ではなくフレーム数で数え、
 * 移動量は「向き」と「動いたこと」で判定する。失敗があれば終了コード 1 で終わる。
 * 飛行でクラスタの内部へ進んだ位置と、俯瞰モードのスクリーンショットも保存する。
 * 移動量は速度の係数 1 を前提にするので、始めに T キーで速度の自動調整を無効にする。
 *
 * キーを離したあとの滑走（移動の慣性。加速の時定数 0.15 秒・滑走の時定数 0.5 秒）は、描画の速さに依らない値（離した時点の
 * 速さ × τr との比、止まる・止まらないの順序）で判定する。ブラウザの描画が 1 フレーム約 0.1〜0.4 秒かかっても、アプリの
 * 1 フレームは 0.1 秒で頭打ちになり、移動は解析解で進むので、比は変わらない。`--fast-clock` では 1 フレームが 1/60 秒になる。
 *
 * ドラッグを離したあとの回転の慣性（時定数 0.3 秒）は、離す直前の速さで決まる。ソフトウェア描画ではマウス
 * イベントが 1 つずつ数百ミリ秒かかって届くので、Playwright の `mouse.move(steps)` では速さが出ない。そこで、
 * 回転量を厳密に測る既存の検証は「止めてから離す」（離す前に 250 ミリ秒待つ）形にし、慣性の検証は CDP の
 * `Input.dispatchMouseEvent` へ、押す・動かす・離すの時刻（`timestamp`）を指定して一気に送る（ブラウザの入力の
 * 経路はそのままで、`event.timeStamp` が指定した時刻になる）。慣性の積分はフレームの経過時間（1 回 0.1 秒まで）で
 * 進むので、待ち時間は壁時計ではなくフレーム数と状態（`getState().rotating`）で数える。
 */
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const {
  loadDataset, computeViews, waitForServer, startPreview, CHROMIUM_ARGS, sub, len, norm, pointerGesture, flickPoints,
  simSecondsOf, sampleUntil: libSampleUntil, waitSim, waitFlightEnd,
} = require('./lib.cjs');

const root = path.resolve(__dirname, '../..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const outDir = path.resolve(root, opt('out', 'artifacts'));
const port = Number(opt('port', '4318'));
const dataPath = 'data/mnist/';
const width = 1280, height = 800;

// ---------- 小さな道具 ----------

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const cos = (a, b) => dot(a, b) / ((len(a) * len(b)) || 1);
const fmt = (v) => `(${v.map((x) => x.toFixed(4)).join(', ')})`;
const maxAbsDiff = (a, b) => Math.max(...a.map((x, i) => Math.abs(x - b[i])));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// `--fast-clock`: 描画の速い環境（60fps）を模擬する。ページの時計（performance.now と requestAnimationFrame に渡る時刻）を
// 描画 1 フレームごとに 1/60 秒だけ進めるので、アプリが 1 フレームで進める模擬の時間は、実際の描画が遅くても 1/60 秒になる。
const FAST_CLOCK = args.includes('--fast-clock');
const FAST_CLOCK_SCRIPT = () => {
  let t = performance.now(), seen = null;
  performance.now = () => t;
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => raf((real) => {
    if (real !== seen) { seen = real; t += 1000 / 60; } // 1 回の描画（同じ real の呼び出し）につき 1 度だけ進める
    cb(t);
  });
};

const consoleErrors = [];
async function openPage(browser, base, query = '', { reducedMotion = false } = {}) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  if (FAST_CLOCK) await page.addInitScript(FAST_CLOCK_SCRIPT);
  if (reducedMotion) await page.emulateMedia({ reducedMotion: 'reduce' });
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`[error] ${m.text()}`); });
  page.on('pageerror', (e) => consoleErrors.push(`[pageerror] ${e.message}`));
  page.on('requestfailed', (r) => consoleErrors.push(`[requestfailed] ${r.url()}`));
  await page.goto(`${base}?data=${dataPath}${query}`);
  await page.waitForFunction(() => window.__explorer && (window.__explorer.ready || window.__explorer.error), null, { timeout: 60000 });
  const err = await page.evaluate(() => window.__explorer.error);
  if (err) throw new Error(`アプリの起動に失敗: ${err}`);
  return page;
}

const state = (page) => page.evaluate(() => window.__explorer.getState());
const frames = (page, n) => page.evaluate((k) => window.__explorer.measureFrames(k), n);
const setView = (page, pos, look) => page.evaluate((v) => window.__explorer.setView(v), { pos, look });
const hudText = (page) => page.evaluate(() => document.getElementById('hud').innerText);

/** 描画が `n` フレーム進む間、キーを押し続けて離し、滑走が止まる（移動の慣性が消える）まで待つ。 */
async function holdKeys(page, keys, n) {
  for (const k of keys) await page.keyboard.down(k);
  await frames(page, n);
  for (const k of [...keys].reverse()) await page.keyboard.up(k);
  await waitGlideEnd(page);
}

/**
 * (x0,y0) から (x1,y1) までマウスの左ボタンでドラッグする。ポインタを止めて（250 ミリ秒待って）から離すので、
 * 離したあとに慣性は付かず、回転量はポインタの動きと一致する。
 */
async function drag(page, x0, y0, x1, y1) {
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x1, y1, { steps: 10 });
  await page.waitForTimeout(250);
  await page.mouse.up();
  await frames(page, 3);
}

/** キーを、模擬の時間で `seconds` 秒分（下限の見積もり）押し続けて離す。進む距離を、描画の速さによらず決めたいときに使う。 */
async function holdKeysFor(page, keys, seconds) {
  for (const k of keys) await page.keyboard.down(k);
  await waitSim(page, seconds);
  for (const k of [...keys].reverse()) await page.keyboard.up(k);
  await waitGlideEnd(page);
}

const yawOf = (d) => Math.atan2(-d[0], -d[2]);
const pitchOf = (d) => Math.asin(Math.max(-1, Math.min(1, d[1])));
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
// 同じ向きどうしでも誤差が出ないように、acos ではなく atan2(|外積|, 内積) で求める
const angleBetween = (a, b) => Math.atan2(len(cross(a, b)), dot(a, b));
// 慣性の最初の角速度の上限 4 rad/s と時定数 0.3 秒から決まる、慣性だけの総回転量の上限（RotationInertia の既定値）
const INERTIA_MAX_TOTAL = 4 * 0.3;

/** 状態に、ホバー中の点（hovered）と、ここまでに進めた模擬の時間の下限（simSeconds）を足して返す。 */
async function sampleOnce(page, simBefore) {
  const stats = await frames(page, 1);
  const s = await state(page);
  s.hovered = await page.evaluate(() => window.__explorer.interaction.getState().hovered);
  s.simSeconds = simBefore + simSecondsOf(stats);
  return s;
}

/**
 * 1 フレームずつ進めて状態を記録する。`until(s, samples)` が true になるか、ちょうど `n` 標本で終わる（標本の数を決めて記録したいとき）。
 */
async function sampleFrames(page, until, n = 80) {
  const samples = [];
  let sim = 0;
  for (let i = 0; i < n; i++) {
    const s = await sampleOnce(page, sim);
    sim = s.simSeconds;
    samples.push(s);
    if (until(s, samples)) break;
  }
  return samples;
}

/** `lib.cjs` の `sampleUntil` に、ホバー中の点（hovered）を足す。 */
const sampleUntil = (page, until, maxSimSeconds = 3) => libSampleUntil(page, until, maxSimSeconds, async (s) => {
  s.hovered = await page.evaluate(() => window.__explorer.interaction.getState().hovered);
});

/** 移動の慣性（キーを離したあとの滑走）が終わるまで待つ。滑走は最高速から約 1.75 秒で止まる。止まらなければ例外にする。 */
async function waitGlideEnd(page) {
  const s = await sampleUntil(page, (x) => !x.moveInertia.gliding, 6);
  if (s.timedOut) throw new Error('滑走が模擬の時間で 6 秒たっても止まらない');
}

/**
 * キーを離す。離す直前の状態を、同じ JS のタスクで読む（描画の途中で離しても、離す直前の位置が正確に分かる）。
 * 離したあと、Playwright のキーの状態もそろえる。
 */
async function releaseKey(page, code) {
  const s = await page.evaluate((c) => {
    const st = window.__explorer.getState();
    window.dispatchEvent(new KeyboardEvent('keyup', { code: c, key: c, bubbles: true }));
    return st;
  }, code);
  await page.keyboard.up(code);
  return s;
}

// ---------- 検証本体 ----------

async function testMovement(page, view) {
  console.log('\n[飛行モード: キー移動]');
  // 視線が水平から傾いた姿勢で調べる（W/S が上下方向の成分も持つことを確かめるため）
  const expectDirs = {
    KeyW: (d) => d,
    KeyS: (d) => d.map((x) => -x),
    KeyD: (d) => norm([-d[2], 0, d[0]]),
    KeyA: (d) => norm([d[2], 0, -d[0]]),
    KeyE: () => [0, 1, 0],
    KeyQ: () => [0, -1, 0],
  };
  const names = { KeyW: '前進', KeyS: '後退', KeyD: '右', KeyA: '左', KeyE: '上昇', KeyQ: '下降' };
  const dists = {};
  for (const key of Object.keys(expectDirs)) {
    await setView(page, view.pos, view.look);
    await frames(page, 2);
    const before = await state(page);
    await holdKeys(page, [key], 8);
    const after = await state(page);
    const delta = sub(after.position, before.position);
    const dist = len(delta);
    dists[key] = dist;
    const c = cos(delta, expectDirs[key](before.direction));
    check(`${key} (${names[key]}): 動いて、期待の向きに進む`, dist > 0.02 && c > 0.97, `移動量 ${dist.toFixed(4)}, 期待の向きとの cos ${c.toFixed(4)}`);
    check(`${key}: 視線の向きは変わらない`, maxAbsDiff(before.direction, after.direction) < 1e-6);
  }
  // Shift を押しても速さは変わらない（Shift+W は W と同じに進む）
  await setView(page, view.pos, view.look);
  await frames(page, 2);
  const b = await state(page);
  await holdKeys(page, ['ShiftLeft', 'KeyW'], 8);
  const a = await state(page);
  const withShift = sub(a.position, b.position);
  const shiftDist = len(withShift);
  check('Shift+W は W と同じ速さで進む', shiftDist > 0.02 && Math.abs(shiftDist / dists.KeyW - 1) < 0.15, `W ${dists.KeyW.toFixed(4)} → Shift+W ${shiftDist.toFixed(4)}（${(shiftDist / dists.KeyW).toFixed(2)} 倍）`);
  check('Shift+W は W と同じ向きに進む', cos(withShift, expectDirs.KeyW(b.direction)) > 0.97, `期待の向きとの cos ${cos(withShift, expectDirs.KeyW(b.direction)).toFixed(4)}`);
}

async function testDrag(page) {
  console.log('\n[飛行モード: 左ドラッグで視点回転]');
  const cx = width / 2, cy = height / 2;
  for (const [name, look] of [['-Z を向いた状態', [0, 0, -1]], ['+X を向いた状態', [1, 0, 0]]]) {
    await setView(page, [0, 0, 0], look);
    await frames(page, 2);
    const s0 = await state(page);
    await drag(page, cx, cy, cx + 150, cy);
    const s1 = await state(page);
    await drag(page, cx, cy, cx - 300, cy);
    const s2 = await state(page);
    const turn1 = cross(s0.direction, s1.direction)[1]; // 負で右へ回った（上から見て時計回り）
    const turn2 = cross(s1.direction, s2.direction)[1]; // 正で左へ回った
    const ang1 = Math.acos(Math.min(1, dot(s0.direction, s1.direction)));
    check(`右ドラッグで右を向く（${name}）`, turn1 < 0 && Math.abs(ang1 - 150 * 0.0025) < 0.01, `回転 ${ang1.toFixed(3)} rad（150px × 0.0025 = 0.375 の見込み）`);
    check(`左ドラッグで左を向く（${name}）`, turn2 > 0, `外積の y ${turn2.toFixed(4)}`);
    check(`ドラッグでは位置が動かない（${name}）`, maxAbsDiff(s0.position, s2.position) < 1e-9);
  }
  await setView(page, [0, 0, 0], [0, 0, -1]);
  await frames(page, 2);
  const p0 = await state(page);
  await drag(page, cx, cy, cx, cy + 100);
  const p1 = await state(page);
  await drag(page, cx, cy, cx, cy - 200);
  const p2 = await state(page);
  check('下ドラッグで下を向き、上ドラッグで上を向く', p1.direction[1] < p0.direction[1] - 0.1 && p2.direction[1] > p1.direction[1] + 0.1,
    `視線の y 成分 ${p0.direction[1].toFixed(3)} → ${p1.direction[1].toFixed(3)} → ${p2.direction[1].toFixed(3)}`);
}

async function testWheel(page) {
  console.log('\n[飛行モード: ホイールで速度]');
  await page.mouse.move(width / 2, height / 2);
  const s0 = (await state(page)).speed;
  await page.mouse.wheel(0, -100);
  await page.waitForTimeout(300);
  await page.mouse.wheel(0, -100);
  await frames(page, 2);
  const s1 = (await state(page)).speed;
  check('ホイールを上へ回すと速度が上がる（1 ノッチ ≈ 1.1 倍）', Math.abs(s1 / s0 - 1.21) < 0.03, `${s0.toFixed(4)} → ${s1.toFixed(4)}（${(s1 / s0).toFixed(3)} 倍）`);
  const hud1 = await hudText(page);
  check('HUD の飛行速度が反映される', hud1.includes(`飛行速度 ${s1.toPrecision(3)}`), JSON.stringify(hud1.split('\n')[1]));
  await page.mouse.wheel(0, 100);
  await page.waitForTimeout(300);
  await page.mouse.wheel(0, 100);
  await page.waitForTimeout(300);
  await page.mouse.wheel(0, 100);
  await frames(page, 2);
  const s2 = (await state(page)).speed;
  check('ホイールを下へ回すと速度が下がる（3 ノッチ ≈ 1.1 の 3 乗分の 1）', Math.abs(s2 / s1 - 1.1 ** -3) < 0.03, `${s1.toFixed(4)} → ${s2.toFixed(4)}（${(s2 / s1).toFixed(3)} 倍、見込み ${(1.1 ** -3).toFixed(3)}）`);
  const hud2 = await hudText(page);
  check('HUD の飛行速度が下がった値に更新される', hud2.includes(`飛行速度 ${s2.toPrecision(3)}`), JSON.stringify(hud2.split('\n')[1]));
}

async function testModes(page, view, centerOf) {
  console.log('\n[モード切り替え]');
  const cx = width / 2, cy = height / 2;
  // 点群の中心を向いていない姿勢（一般の場合）で切り替える
  await setView(page, view.pos, view.look);
  await frames(page, 3);
  const f0 = await state(page);
  check('始めは飛行モード', f0.mode === 'fly' && (await hudText(page)).includes('モード 飛行'));

  await page.keyboard.press('KeyO');
  await page.waitForFunction(() => window.__explorer.getState().mode === 'overview');
  await frames(page, 3);
  const o0 = await state(page);
  check('O で俯瞰モードへ。位置と向きが変わらない', maxAbsDiff(f0.position, o0.position) < 1e-6 && maxAbsDiff(f0.direction, o0.direction) < 1e-6,
    `位置の差 ${maxAbsDiff(f0.position, o0.position).toExponential(1)}, 向きの差 ${maxAbsDiff(f0.direction, o0.direction).toExponential(1)}`);
  check('俯瞰モードの回転の中心は点群の中心', o0.pivot && maxAbsDiff(o0.pivot, centerOf) < 1e-6, `pivot ${o0.pivot && fmt(o0.pivot)}`);
  const hudO = await hudText(page);
  check('HUD が俯瞰モードの表示になる', hudO.includes('モード 俯瞰') && hudO.includes('O 飛行モードへ'));

  // 俯瞰モードでは飛行の入力に反応しない
  await holdKeys(page, ['KeyW'], 6);
  const o1 = await state(page);
  check('俯瞰モードでは W を押しても動かない', maxAbsDiff(o0.position, o1.position) < 1e-9);
  await page.mouse.move(cx, cy);
  const speedBefore = o1.speed;
  await page.mouse.wheel(0, 100);
  await frames(page, 3);
  const o2 = await state(page);
  check('俯瞰モードのホイールは飛行速度を変えず、中心からの距離を変える', o2.speed === speedBefore && len(sub(o2.position, o2.pivot)) > len(sub(o1.position, o1.pivot)) + 0.01,
    `距離 ${len(sub(o1.position, o1.pivot)).toFixed(3)} → ${len(sub(o2.position, o2.pivot)).toFixed(3)}（下へ回すと離れる）`);
  await page.mouse.wheel(0, -100);
  await frames(page, 3);

  // ドラッグで点群の中心のまわりを回る
  const d0 = await state(page);
  await drag(page, cx, cy, cx + 150, cy - 60);
  const d1 = await state(page);
  const r0 = len(sub(d0.position, d0.pivot)), r1 = len(sub(d1.position, d1.pivot));
  const v0 = sub(d0.position, d0.pivot), v1 = sub(d1.position, d1.pivot);
  check('俯瞰モードのドラッグで中心のまわりを回る（中心までの距離が一定、位置は動く）', Math.abs(r0 - r1) < 1e-4 && len(sub(d1.position, d0.position)) > 0.05,
    `中心までの距離 ${r0.toFixed(4)} → ${r1.toFixed(4)}, 移動 ${len(sub(d1.position, d0.position)).toFixed(3)}`);
  check('右ドラッグでカメラは中心のまわりを左へ回る（点群が右へ回り込んで見える）', cross(v0, v1)[1] < 0 || Math.hypot(v0[0], v0[2]) < 1e-3);
  check('俯瞰モードのドラッグで視線の向きも一緒に回る', cos(d0.direction, d1.direction) < 0.999, `cos ${cos(d0.direction, d1.direction).toFixed(4)}`);
  await drag(page, cx, cy, cx, cy + 40);
  const d2 = await state(page);
  check('下ドラッグでカメラが上がる（見下ろす）', d2.position[1] > d1.position[1]);

  // 飛行モードへ戻る
  await page.keyboard.press('KeyO');
  await page.waitForFunction(() => window.__explorer.getState().mode === 'fly');
  await frames(page, 3);
  const f1 = await state(page);
  check('O で飛行モードへ戻る。位置と向きが変わらない', maxAbsDiff(d2.position, f1.position) < 1e-6 && maxAbsDiff(d2.direction, f1.direction) < 1e-5,
    `位置の差 ${maxAbsDiff(d2.position, f1.position).toExponential(1)}, 向きの差 ${maxAbsDiff(d2.direction, f1.direction).toExponential(1)}`);
  check('戻った後の HUD は飛行モード', (await hudText(page)).includes('モード 飛行'));
  await holdKeys(page, ['KeyW'], 6);
  await waitGlideEnd(page); // 移動の慣性が消えるまで待つ
  const f2 = await state(page);
  check('飛行モードに戻ると W で動く', len(sub(f2.position, f1.position)) > 0.02);
  await drag(page, cx, cy, cx + 100, cy);
  const f3 = await state(page);
  check('飛行モードに戻ると、ドラッグは位置を動かさず視線だけ回す', maxAbsDiff(f2.position, f3.position) < 1e-9 && cos(f2.direction, f3.direction) < 0.999);

  // 切り替えの瞬間に W を押し続けていても、あとで動き続けない
  await page.keyboard.down('KeyW');
  await frames(page, 3);
  await page.keyboard.press('KeyO');
  await frames(page, 2);
  await page.keyboard.up('KeyW');
  await page.keyboard.press('KeyO');
  await frames(page, 5);
  const k0 = await state(page);
  await frames(page, 5);
  const k1 = await state(page);
  check('W を押したままモードを切り替えても、キーが押しっぱなし扱いにならない', k0.mode === 'fly' && maxAbsDiff(k0.position, k1.position) < 1e-9);
}


// ---------- 移動の慣性（キーを離したあとの滑走） ----------

/** W を押して、最高速（基準速度 × 係数。時定数 0.15 秒の 10 倍以上の時間）に達するまで進める。 */
async function cruise(page, key = 'KeyW', seconds = 1.5) {
  await page.keyboard.down(key);
  await waitSim(page, seconds);
}

const progressAlong = (p0, p, dir) => dot(sub(p, p0), dir);

async function testGlide(page, view) {
  console.log('\n[飛行モード: キーを離したあとの滑走]');
  await setView(page, view.pos, view.look);
  await frames(page, 2);
  const st = await state(page);
  const tauA = st.moveInertia.accelTimeConstant, tauR = st.moveInertia.glideTimeConstant;
  check('移動の慣性の既定は、加速 0.15 秒・滑走 0.5 秒', tauA === 0.15 && tauR === 0.5 && st.moveInertia.gliding === false, JSON.stringify(st.moveInertia));

  // 離したあとも進み続け、やがて止まる。滑った距離は、離した時点の速さ × τr に見合う
  await cruise(page);
  const rel = await releaseKey(page, 'KeyW');
  const v0 = rel.effectiveSpeed; // 最高速に達しているので、離した時点の速さは 基準速度 × 係数
  const dir = rel.direction;
  const a = await sampleUntil(page, (x) => !x.moveInertia.gliding, 4);
  const last = a[a.length - 1];
  const progress = a.map((x) => progressAlong(rel.position, x.position, dir));
  const glided = len(sub(last.position, rel.position));
  // 止まるまでの総距離は v0·τr·(1 − 0.03)（速さが基準速度 × 係数 × 0.03 を下回ったところで止まる）
  const ratio = glided / (v0 * tauR);
  const growing = progress.filter((x, i) => x > (i ? progress[i - 1] : 0) + 1e-6).length;
  check('W を離したあとも、位置が進み続ける（滑走中は gliding が true）', a[0].moveInertia.gliding && growing >= 2 && progress.every((x, i) => i === 0 || x >= progress[i - 1] - 1e-9),
    `進んだ標本 ${growing}/${a.length}、離してからの移動（視線方向） ${progress.map((x) => x.toFixed(3)).join(' ')}`);
  check('やがて止まる（gliding が false になり、そのあと位置が変わらない）', !a.timedOut && !last.moveInertia.gliding && (await staysStillPos(page)),
    `${a.length} 標本、模擬の時間 ${last.simSeconds.toFixed(2)} 秒以上`);
  check('滑った距離が、離した時点の速さ × τr に見合う（0.93〜1.0 倍。止まる閾値の 3% を引いた 0.97 倍の見込み）',
    ratio > 0.93 && ratio < 1.0 + 1e-6, `滑った距離 ${glided.toFixed(4)}、速さ ${v0.toFixed(4)} × τr ${tauR} = ${(v0 * tauR).toFixed(4)}（${ratio.toFixed(3)} 倍）`);
  check('滑る向きは、離した時点の進行方向', cos(sub(last.position, rel.position), dir) > 0.999, `cos ${cos(sub(last.position, rel.position), dir).toFixed(5)}`);
  check('滑走の間、視線の向きは変わらない', a.every((x) => angleBetween(x.direction, rel.direction) < 1e-6));

  // 逆向きのキーで、狙って止める: 加速の時定数 τa で止まるので、滑走よりずっと手前で止まる（行き過ぎは約 0.31·v·τa）
  await setView(page, view.pos, view.look);
  await frames(page, 2);
  await cruise(page);
  const rev = await page.evaluate(() => {
    const st = window.__explorer.getState();
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', key: 'KeyW', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyS', key: 'KeyS', bubbles: true, cancelable: true }));
    return st;
  });
  await page.keyboard.up('KeyW');
  const b = await sampleUntil(page, (x) => progressAlong(rev.position, x.position, rev.direction) < -0.02, 3);
  const peak = Math.max(0, ...b.map((x) => progressAlong(rev.position, x.position, rev.direction)));
  const lastB = b[b.length - 1];
  const turnedBack = progressAlong(rev.position, lastB.position, rev.direction);
  await releaseKey(page, 'KeyS');
  await waitGlideEnd(page);
  check('逆向きのキー（S）を押すと、滑走よりずっと手前で止まり、そのまま戻り始める',
    !b.timedOut && peak < 0.25 * rev.effectiveSpeed * tauR && turnedBack < -0.02,
    `前へ進んだ最大 ${peak.toFixed(4)}（離すだけの滑走なら ${(0.97 * rev.effectiveSpeed * tauR).toFixed(4)}。見込み ${(0.307 * rev.effectiveSpeed * tauA).toFixed(4)} 以下）、戻った量 ${turnedBack.toFixed(4)}`);

  // キーを離している間に別のキーを押すと、滑走は終わって、そのキーの向きへ進む
  await setView(page, view.pos, view.look);
  await frames(page, 2);
  await cruise(page);
  await releaseKey(page, 'KeyW');
  await frames(page, 1);
  const g0 = await state(page);
  await page.keyboard.down('KeyE');
  await waitSim(page, 1);
  const g1 = await releaseKey(page, 'KeyE');
  check('滑走中に別のキー（E）を押すと、滑走は終わって上へ進む', g0.moveInertia.gliding && !g1.moveInertia.gliding && g1.position[1] > g0.position[1] + 0.05,
    `y ${g0.position[1].toFixed(3)} → ${g1.position[1].toFixed(3)}`);
  await waitGlideEnd(page);
}

/** 位置が `n` フレームのあいだ変わらないか（滑走が止まったあと）。 */
async function staysStillPos(page, n = 3) {
  const a = await state(page);
  await frames(page, n);
  const b = await state(page);
  return len(sub(a.position, b.position)) < 1e-12 && !b.moveInertia.gliding;
}

// ---------- 回転の慣性 ----------

/** 向きの列（先頭を含む）の、ヨーの変化（右へ回ると正）。 */
const yawSteps = (dirs) => dirs.slice(1).map((d, i) => wrapPi(yawOf(dirs[i]) - yawOf(d)));

async function settle(page, maxSimSeconds = 3) {
  return sampleUntil(page, (s) => !s.rotating, maxSimSeconds);
}

/** 慣性が止まったあと、`n` フレーム進めても向きと位置が変わらないか。 */
async function staysStill(page, n = 3) {
  const a = await state(page);
  await frames(page, n);
  const b = await state(page);
  return angleBetween(a.direction, b.direction) < 1e-9 && len(sub(a.position, b.position)) < 1e-9 && !b.rotating;
}

async function testInertiaFly(page, inside) {
  console.log('\n[飛行モード: ドラッグの慣性]');
  const cx = width / 2, cy = height / 2;
  const level = async () => { await setView(page, [0, 0, 0], [0, 0, -1]); await frames(page, 2); };

  // 動かしながら離す: 離したあとも同じ向きへ回り続け、やがて止まる
  await level();
  const s0 = await state(page);
  await pointerGesture(page, flickPoints(cx, cy, 150, 0), 1);
  const a = await sampleUntil(page, (s) => !s.rotating);
  const dirs = [s0.direction, ...a.map((s) => s.direction)];
  const steps = yawSteps(dirs);
  const last = a[a.length - 1];
  const total = wrapPi(yawOf(s0.direction) - yawOf(last.direction));
  // 1 回の標本（measureFrames(1)）は、ソフトウェア描画では複数フレーム（約 0.4 秒）にあたるので、慣性は数標本で終わる
  const afterRelease = steps.slice(1).filter((d) => d > 1e-4).length;
  check('動かしながら離すと、離したあとも回り続ける（rotating が true で、向きが同じ向きへ変わり続ける）',
    a.some((s) => s.rotating) && afterRelease >= 2 && steps.every((d) => d > -1e-9),
    `回転のあった標本 ${afterRelease}、1 フレームごとの回転量 ${steps.map((d) => d.toFixed(3)).join(' ')}`);
  check('やがて止まる（rotating が false になり、そのあと向きが変わらない）', !last.rotating && !a.timedOut && (await staysStill(page)), `${a.length} 標本、模擬の時間 ${last.simSeconds.toFixed(2)} 秒以上`);
  // ドラッグ 150px = 0.375 rad。離す直前の速さ ≈ 940 px/s = 2.3 rad/s、時定数 0.3 秒 → 慣性の総回転量 ≈ 0.7 rad
  check('慣性の総回転量が、離す直前の速さと時定数から見込める範囲に入る', total > 0.375 + 0.4 && total < 0.375 + INERTIA_MAX_TOTAL, `総回転 ${total.toFixed(3)} rad（ドラッグ 0.375 + 慣性 ${(total - 0.375).toFixed(3)}、見込み ≈ 0.7）`);
  check('慣性では位置が動かない', len(sub(s0.position, last.position)) < 1e-9);
  await level();
  await waitSim(page, 0.4); // HUD の視点の表示は（模擬の時間で）約 0.25 秒ごとに書き換わる
  const hudBefore = (await hudText(page)).split('\n').pop();
  await pointerGesture(page, flickPoints(cx, cy, 150, 0), 1);
  await waitSim(page, 0.4);
  const midState = await state(page);
  const hudDuring = (await hudText(page)).split('\n').pop();
  await settle(page);
  check('慣性の間も HUD の視点の表示（?pos=…&look=…）が更新される', midState.rotating && hudDuring !== hudBefore, `${hudBefore} → ${hudDuring}`);

  // 最後の pointermove のあとに位置が変わって離す: その動きも離す直前の速さに入る（慣性が強くなる）。
  // 遅く動かしたあと、最後の 16 ミリ秒で 80 ピクセル動いたところで離す。位置を離した所に含めないと、遅いままの慣性になる
  const slowThenRelease = async (releaseDx) => {
    await level();
    const b0 = await state(page);
    const slow = [{ x: cx, y: cy, t: 0 }, { x: cx + 10, y: cy, t: 100 }];
    await pointerGesture(page, slow, 16, { x: cx + releaseDx, y: cy, t: 116 });
    const q = await sampleUntil(page, (x) => !x.rotating);
    const total = wrapPi(yawOf(b0.direction) - yawOf(q[q.length - 1].direction));
    return { total, rotated: q.some((x) => x.rotating) };
  };
  const slowSame = await slowThenRelease(10);
  const slowFar = await slowThenRelease(90);
  check('最後の pointermove のあとに動いて離した位置も、離す直前の速さに入る（その分、慣性が強くなる）',
    slowFar.rotated && slowFar.total > 90 * 0.0025 * 0.9 && slowFar.total - 90 * 0.0025 > 3 * Math.max(0.01, slowSame.total - 10 * 0.0025),
    `離した位置が最後の移動と同じ: 総回転 ${slowSame.total.toFixed(3)} rad（ドラッグ ${(10 * 0.0025).toFixed(3)}）、80 ピクセル先で離す: ${slowFar.total.toFixed(3)} rad（ドラッグ ${(90 * 0.0025).toFixed(3)}）`);

  // ポインタを止めてから離す: 慣性が付かない（狙った向きで止められる）
  await level();
  const t0 = await state(page);
  await pointerGesture(page, flickPoints(cx, cy, 150, 0), 300);
  const b = await sampleFrames(page, () => false, 4);
  const tb = wrapPi(yawOf(t0.direction) - yawOf(b[b.length - 1].direction));
  check('ポインタを止めてから離すと、慣性は付かない（離したあとに向きが変わらない）',
    b.every((s) => !s.rotating) && Math.abs(tb - 0.375) < 0.005 && angleBetween(b[0].direction, b[b.length - 1].direction) < 1e-9, `回転 ${tb.toFixed(4)} rad（ドラッグだけなら 0.375）`);

  // 動かさずに押して離す（クリック）: 慣性が付かない
  await level();
  const c0 = await state(page);
  await pointerGesture(page, [{ x: cx, y: cy, t: 0 }], 30);
  const c = await sampleFrames(page, () => false, 3);
  check('動かさずに押して離したクリックでは、慣性が付かず、向きも変わらない', c.every((x) => !x.rotating) && angleBetween(c0.direction, c[c.length - 1].direction) < 1e-9);
  // 数ピクセルの揺れ（押した位置から 4 ピクセル以内）も同じ
  await level();
  const j0 = await state(page);
  await pointerGesture(page, [{ x: cx, y: cy, t: 0 }, { x: cx + 2, y: cy + 1, t: 10 }, { x: cx + 3, y: cy + 1, t: 20 }], 1);
  const j = await sampleFrames(page, () => false, 3);
  check('数ピクセルの揺れで離したクリックでも、慣性は付かない', j.every((x) => !x.rotating) && angleBetween(j0.direction, j[j.length - 1].direction) < 0.02);

  // 慣性の間にポインタを押すと止まる
  await level();
  await pointerGesture(page, flickPoints(cx, cy, 150, 0), 1);
  const p0 = await sampleFrames(page, (x) => x.rotating, 4);
  check('（前提）慣性で回っている', p0[p0.length - 1].rotating);
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await frames(page, 1);
  const pd = await state(page);
  await frames(page, 3);
  const pe = await state(page);
  check('慣性の間にポインタを押すと止まる（rotating が false になり、向きが変わらない）', !pd.rotating && !pe.rotating && angleBetween(pd.direction, pe.direction) < 1e-9);
  await page.mouse.up();
  await frames(page, 2);
  const pu = await state(page);
  check('そのまま離しても（動かさないクリック）、慣性は付かない', !pu.rotating && angleBetween(pe.direction, pu.direction) < 1e-9);

  // 慣性の間に W を押すと、回りながら進む。W を押している間は、慣性が止まるまで 1 フレームずつ記録する
  await level();
  await pointerGesture(page, flickPoints(cx, cy, 150, 0), 1);
  await sampleFrames(page, (x) => x.rotating, 4);
  const w1 = await state(page); // W を押した時点（位置と視線の基準）
  await page.keyboard.down('KeyW');
  const w = await sampleUntil(page, (x, all) => all.length >= 3 && !x.rotating);
  await page.keyboard.up('KeyW');
  const w2 = w[w.length - 1];
  const turned = wrapPi(yawOf(w1.direction) - yawOf(w2.direction));
  check('慣性の間に W を押すと、W では止まらず、回りながら進む', !w.timedOut && w.some((x) => x.rotating) && turned > 0.02 && len(sub(w2.position, w1.position)) > 0.02,
    `回転 ${turned.toFixed(3)} rad、移動 ${len(sub(w2.position, w1.position)).toFixed(3)}`);
  // 進む向きは、W を押した時点の視線 d0 に固定されず、毎フレームの視線に沿って曲がる。描画の速さ（1 フレームで進む模擬の時間は
  // min(0.1, 実時間)）によって、押すまでの減衰も、押している間に回る量も変わるので、絶対値ではなく、フレームごとの比で判定する。
  //   turned = 視線が d0 から回った量、bent = 変位（W を押した時点の位置から）の向きが d0 から曲がった量。
  // 視線は水平のまま回るので、変位は d0 と今の視線のあいだの向きになり、bent ≤ turned。速度は目標へ時定数 0.12 秒で近づくので、
  // 曲がりは視線より少し遅れ、bent / turned は 1 フレーム目が 1、そのあと刻みを細かくするほど小さく（極限で約 0.4）、
  // 視線が止まると 1 へ向かう。d0 のまま進み続ける実装では bent / turned が 0。押した直後の向きで固定する実装は、比が小さくなり、
  // フレームが進んでも bent が伸びない。そこで、比の範囲に加えて、最初のフレームから最後のフレームまでの bent の増え方が、
  // turned の増え方に見合う（0.2 倍より大きい）ことも確かめる。
  const rows = w.map((x) => {
    const disp = sub(x.position, w1.position);
    return { moved: len(disp), turned: angleBetween(w1.direction, x.direction), bent: angleBetween(w1.direction, disp), toGaze: angleBetween(x.direction, disp) };
  }).filter((q) => q.moved > 1e-3 && q.turned > 1e-3);
  // 標本が足りないときは、配列を読む前に FAIL として報告する（rows[0] などの参照で例外にしない）
  const enough = rows.length >= 2;
  const rf = enough ? rows[0] : null, rl = enough ? rows[rows.length - 1] : null;
  const rowText = rows.map((q) => `${q.turned.toFixed(3)} → ${q.bent.toFixed(3)} (${(q.bent / q.turned).toFixed(2)})`).join(', ');
  if (!enough) {
    check('進む向きは、W を押した時点の視線ではなく、回っていく視線に沿って曲がる（毎フレーム、変位の向きの曲がりが、視線が回った量に見合う）', false,
      `判定に使える標本が ${rows.length} 件（2 件以上が必要）。記録した標本 ${w.length} 件、模擬の時間 ${w[w.length - 1].simSeconds.toFixed(2)} 秒以上${w.timedOut ? '（上限に達した）' : ''}`);
    check('慣性が止まったあと、進む向きは、W を押した時点の視線より、いまの視線に近い', false, '標本がない');
  } else {
    const ratios = rows.map((q) => q.bent / q.turned);
    const dTurned = rl.turned - rf.turned, dBent = rl.bent - rf.bent;
    check('進む向きは、W を押した時点の視線ではなく、回っていく視線に沿って曲がる（毎フレーム、変位の向きの曲がりが、視線が回った量に見合う）',
      ratios.every((q) => q > 0.2 && q < 1 + 1e-6) && dBent > 0.2 * dTurned,
      `押した時点からの 視線の回転 → 変位の向きの曲がり（比）: ${rowText}（比は 0.2 より大きく 1 以下）。最初から最後までの増え方 視線 ${dTurned.toFixed(3)} → 曲がり ${dBent.toFixed(3)}（曲がりは視線の 0.2 倍より大きい）`);
    check('慣性が止まったあと、進む向きは、W を押した時点の視線より、いまの視線に近い',
      !w2.rotating && rl.toGaze < rl.bent,
      `いまの視線とのなす角 ${rl.toGaze.toFixed(3)} rad < 押した時点の視線とのなす角 ${rl.bent.toFixed(3)} rad`);
  }
  await settle(page);
  await waitGlideEnd(page); // 移動の慣性が消えるまで待つ

  // ピッチの制限: 慣性の間も ±89° で止まる
  for (const [name, y0, dy, sign] of [['上', 600, -400, 1], ['下', 200, 400, -1]]) {
    await level();
    await pointerGesture(page, flickPoints(cx + 200, y0, 0, dy, 100), 1);
    const q = await settle(page);
    const pitches = q.map((x) => pitchOf(x.direction));
    const maxAbs = Math.max(...pitches.map(Math.abs));
    const finalPitch = pitches[pitches.length - 1];
    const limit = (89 * Math.PI) / 180;
    check(`${name}へ強く払っても、ピッチは ±89° に収まり、端で止まる`, maxAbs <= limit + 1e-6 && Math.abs(finalPitch - sign * limit) < 1e-3 && !q[q.length - 1].rotating && (await staysStill(page)),
      `最大 |ピッチ| ${(maxAbs * 180 / Math.PI).toFixed(3)}°、最後 ${(finalPitch * 180 / Math.PI).toFixed(3)}°`);
  }

  // 止める操作: モード切り替え（O）・ホーム（H）・視点の直接設定・フォーカスの喪失
  const flickAndWait = async () => {
    await level();
    await pointerGesture(page, flickPoints(cx, cy, 150, 0), 1);
    await sampleFrames(page, (x) => x.rotating, 4);
  };
  await flickAndWait();
  await page.keyboard.press('KeyO');
  await page.waitForFunction(() => window.__explorer.getState().mode === 'overview');
  await frames(page, 1);
  const m0 = await state(page);
  await frames(page, 3);
  const m1 = await state(page);
  check('慣性の間に O でモードを切り替えると、慣性は止まる（切り替えのあとに回らない）', m0.mode === 'overview' && !m0.rotating && !m1.rotating && angleBetween(m0.direction, m1.direction) < 1e-9 && len(sub(m0.position, m1.position)) < 1e-9);
  await page.keyboard.press('KeyO');
  await page.waitForFunction(() => window.__explorer.getState().mode === 'fly');
  await frames(page, 2);

  await flickAndWait();
  const home = await page.evaluate(() => window.__explorer.homeView());
  await page.keyboard.press('KeyH');
  await frames(page, 1);
  const h0 = await state(page);
  check('慣性の間に H を押すと、ホームへの移動が始まり、慣性は止まる', h0.homing && !h0.rotating);
  const hl = await waitFlightEnd(page); // 移動の完了は、状態（flight・homing）と模擬の時間で待つ
  check('ホームへ着いたあとも、慣性は残らない（向きはホームの向き）', !hl.homing && !hl.rotating && angleBetween(hl.direction, norm(sub(home.look, home.pos))) < 1e-3 && len(sub(hl.position, home.pos)) < 1e-3);

  await flickAndWait();
  await setView(page, [0.05, 0.02, 0.01], [0.05, 0.02, -1]);
  await frames(page, 1);
  const v0 = await state(page);
  await frames(page, 3);
  const v1 = await state(page);
  check('慣性の間に視点が直接設定されると、慣性は止まる', !v0.rotating && !v1.rotating && angleBetween(v0.direction, [0, 0, -1]) < 1e-3 && angleBetween(v0.direction, v1.direction) < 1e-9);

  await flickAndWait();
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await frames(page, 1);
  const f0 = await state(page);
  await frames(page, 3);
  const f1 = await state(page);
  check('慣性の間にウィンドウがフォーカスを失うと、慣性は止まる', !f0.rotating && !f1.rotating && angleBetween(f0.direction, f1.direction) < 1e-9);

  // ホバー: 慣性で回っている間は止まり、止まると再開する（カーソルの位置は動かさない）
  console.log('\n[慣性とホバー]');
  let hoverOk = false, detail = '候補の位置が見つからない';
  for (const y0 of [cy, cy - 120, cy + 120, cy - 220]) {
    await setView(page, inside.pos, inside.look);
    await frames(page, 2);
    await pointerGesture(page, flickPoints(cx - 75, y0, 150, 0), 1);
    const q = await sampleUntil(page, (x) => !x.rotating);
    await frames(page, 2);
    const rotatingSamples = q.slice(1).filter((x) => x.rotating);
    const hoverDuring = rotatingSamples.map((x) => x.hovered);
    // 止まったあとのカーソルの位置（離した位置）に見える点
    const want = await page.evaluate(([x, y]) => window.__explorer.pick(x, y).then((r) => (r ? r.index : null)), [cx + 75, y0]);
    if (want === null) { detail = `位置 y=${y0} に点がない`; continue; }
    const h = await waitFrames(page, async () => ({ ok: (await page.evaluate(() => window.__explorer.interaction.getState().hovered)) === want }), 6);
    hoverOk = rotatingSamples.length > 0 && hoverDuring.every((x) => x === null) && h.ok;
    detail = `慣性の間のホバー [${hoverDuring.join(',')}]、止まったあと ${want} へ戻るまで ${h.frames} フレーム`;
    break;
  }
  check('慣性で回っている間はホバーが止まり、止まるとカーソルの下の点へ再開する', hoverOk, detail);
  await setView(page, [0, 0, 0], [0, 0, -1]);
  await frames(page, 2);
}

async function waitFrames(page, fn, max = 8) {
  let r = { ok: false };
  for (let i = 1; i <= max; i++) {
    await frames(page, 1);
    r = await fn(page);
    if (r.ok) return { ok: true, frames: i, ...r };
  }
  return { ...r, ok: false, frames: max };
}

async function testInertiaOverview(page, center) {
  console.log('\n[俯瞰モード: ドラッグの慣性]');
  const cx = width / 2, cy = height / 2;
  await page.keyboard.press('KeyO');
  await page.waitForFunction(() => window.__explorer.getState().mode === 'overview');
  const place = async () => { await setView(page, [1.4, 0.4, 1.5], center); await frames(page, 2); };
  const azimuth = (st) => Math.atan2(st.position[0] - st.pivot[0], st.position[2] - st.pivot[2]);
  const dist = (st) => len(sub(st.position, st.pivot));

  await place();
  const s0 = await state(page);
  await pointerGesture(page, flickPoints(cx, cy, 120, 0), 1);
  const a = await sampleUntil(page, (s) => !s.rotating);
  const az = [azimuth(s0), ...a.map(azimuth)];
  const steps = az.slice(1).map((v, i) => wrapPi(v - az[i]));
  const last = a[a.length - 1];
  // 1 回の標本（measureFrames(1)）は、ソフトウェア描画では複数フレーム（約 0.4 秒）にあたるので、慣性は数標本で終わる
  const afterRelease = steps.slice(1).filter((d) => Math.abs(d) > 1e-4).length;
  check('俯瞰モード: 離したあとも中心のまわりを同じ向きへ回り続け、やがて止まる',
    a.some((s) => s.rotating) && afterRelease >= 2 && steps.every((d) => d < 1e-9) && !last.rotating && !a.timedOut && (await staysStill(page)),
    `回転のあった標本 ${afterRelease}、1 フレームごとの回転量 ${steps.map((d) => d.toFixed(3)).join(' ')}`);
  check('俯瞰モード: 慣性の間も中心までの距離は変わらない', [s0, ...a].every((s) => Math.abs(dist(s) - dist(s0)) < 1e-4), `距離 ${dist(s0).toFixed(4)} → ${dist(last).toFixed(4)}`);
  check('俯瞰モード: 慣性の総回転量が見込める範囲に入る（ドラッグ 0.6 rad に、慣性が加わる）', Math.abs(wrapPi(azimuth(last) - azimuth(s0))) > 0.6 + 0.3, `総回転 ${Math.abs(wrapPi(azimuth(last) - azimuth(s0))).toFixed(3)} rad`);

  await place();
  const w0 = await state(page);
  await pointerGesture(page, [{ x: cx, y: cy, t: 0 }, { x: cx + 10, y: cy, t: 100 }], 16, { x: cx + 90, y: cy, t: 116 });
  const w = await sampleUntil(page, (x) => !x.rotating);
  const wl = w[w.length - 1];
  const wTotal = Math.abs(wrapPi(azimuth(wl) - azimuth(w0)));
  check('俯瞰モード: 最後の pointermove のあとに動いて離した位置も、離す直前の速さに入る（ドラッグだけより大きく回る）',
    w.some((x) => x.rotating) && wTotal > 90 * 0.005 + 0.15, `総回転 ${wTotal.toFixed(3)} rad（ドラッグだけなら ${(90 * 0.005).toFixed(3)}）`);

  await place();
  const t0 = await state(page);
  await pointerGesture(page, flickPoints(cx, cy, 120, 0), 300);
  const b = await sampleFrames(page, () => false, 4);
  check('俯瞰モード: ポインタを止めてから離すと、慣性は付かない', b.every((s) => !s.rotating) && Math.abs(Math.abs(wrapPi(azimuth(b[b.length - 1]) - azimuth(t0))) - 0.6) < 0.01 && angleBetween(b[0].direction, b[b.length - 1].direction) < 1e-9);

  await place();
  await pointerGesture(page, flickPoints(cx, cy, 120, 0), 1);
  await sampleFrames(page, (x) => x.rotating, 4);
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await frames(page, 1);
  const pd = await state(page);
  await frames(page, 3);
  const pe = await state(page);
  await page.mouse.up();
  check('俯瞰モード: 慣性の間にポインタを押すと止まる', !pd.rotating && !pe.rotating && angleBetween(pd.direction, pe.direction) < 1e-9 && len(sub(pd.position, pe.position)) < 1e-9);
  await frames(page, 2);

  // 仰角の制限
  for (const [name, y0, dy] of [['上', 600, -400], ['下', 200, 400]]) {
    await place();
    await pointerGesture(page, flickPoints(cx + 200, y0, 0, dy, 100), 1);
    const q = await settle(page);
    const limit = (89 * Math.PI) / 180;
    const maxAbs = Math.max(...q.map((x) => Math.abs(pitchOf(x.direction))));
    check(`俯瞰モード: ${name}へ強く払っても、仰角は ±89° に収まり、中心までの距離を保ち、端で止まる`,
      maxAbs <= limit + 1e-6 && q.every((x) => Math.abs(dist(x) - dist(s0)) < 1e-4) && !q[q.length - 1].rotating && (await staysStill(page)), `最大 |仰角| ${(maxAbs * 180 / Math.PI).toFixed(3)}°`);
  }

  // 飛行モードへ戻っても、向きが跳ばず、慣性は残らない
  await place();
  await pointerGesture(page, flickPoints(cx, cy, 120, 0), 1);
  await sampleFrames(page, (x) => x.rotating, 3);
  await page.keyboard.press('KeyO');
  await page.waitForFunction(() => window.__explorer.getState().mode === 'fly');
  await frames(page, 1);
  const r0 = await state(page);
  await frames(page, 3);
  const r1 = await state(page);
  check('俯瞰モードの慣性の間に O で飛行モードへ切り替えると、慣性は止まる', !r0.rotating && !r1.rotating && angleBetween(r0.direction, r1.direction) < 1e-9 && len(sub(r0.position, r1.position)) < 1e-9);
}

async function testInertiaReducedMotion(browser, base) {
  console.log('\n[「視差効果を減らす」設定]');
  const page = await openPage(browser, base, '', { reducedMotion: true });
  await frames(page, 2);
  const cx = width / 2, cy = height / 2;
  const matches = await page.evaluate(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  check('（前提）ブラウザが prefers-reduced-motion: reduce を報告する', matches === true);
  await testReducedMotionGlide(page);
  for (const mode of ['fly', 'overview']) {
    if (mode === 'overview') {
      await page.keyboard.press('KeyO');
      await page.waitForFunction(() => window.__explorer.getState().mode === 'overview');
    }
    await setView(page, mode === 'fly' ? [0, 0, 0] : [1.4, 0.4, 1.5], mode === 'fly' ? [0, 0, -1] : [0, 0, 0]);
    await frames(page, 2);
    const s0 = await state(page);
    await pointerGesture(page, flickPoints(cx, cy, 150, 0), 1);
    const a = await sampleFrames(page, () => false, 4);
    const moved = angleBetween(s0.direction, a[0].direction);
    check(`「視差効果を減らす」では、${mode === 'fly' ? '飛行' : '俯瞰'}モードでも既定で慣性が付かない（ドラッグの回転だけで、離したあとに回らない）`,
      a.every((s) => !s.rotating) && moved > 0.1 && angleBetween(a[0].direction, a[a.length - 1].direction) < 1e-9, `ドラッグでの回転 ${moved.toFixed(3)} rad`);
  }
  await page.close();
}

/** 「視差効果を減らす」設定では、移動の慣性の時定数がどちらも 0.12 秒（いまと同じ、キーを離すとすぐ止まる動き）になる。 */
async function testReducedMotionGlide(page) {
  await page.keyboard.press('KeyT'); // 距離の見込みを係数 1 で出すため、速度の自動調整を止める
  await frames(page, 2);
  await setView(page, [0, 0, 0], [0, 0, -1]);
  await frames(page, 2);
  const st = await state(page);
  check('「視差効果を減らす」では、移動の時定数が加速・滑走とも 0.12 秒', st.moveInertia.accelTimeConstant === 0.12 && st.moveInertia.glideTimeConstant === 0.12 && st.speedScale === 1, JSON.stringify(st.moveInertia));
  await cruise(page);
  const rel = await releaseKey(page, 'KeyW');
  const a = await sampleUntil(page, (x) => !x.moveInertia.gliding, 3);
  const last = a[a.length - 1];
  const ratio = len(sub(last.position, rel.position)) / (rel.effectiveSpeed * 0.12);
  check('「視差効果を減らす」では、W を離すとすぐ止まる（滑る距離は 離した時点の速さ × 0.12 秒 の 0.93〜1.0 倍）',
    !a.timedOut && ratio > 0.93 && ratio < 1 + 1e-6, `滑った距離 ${len(sub(last.position, rel.position)).toFixed(4)}（${ratio.toFixed(3)} 倍）、模擬の時間 ${last.simSeconds.toFixed(2)} 秒以上で停止`);
}

async function testUrl(browser, base) {
  console.log('\n[URL パラメータ]');
  const pos = [-0.5, 0.3, -0.7], look = [-0.33, 0.21, -0.44];
  const page = await openPage(browser, base, `&pos=${pos.join(',')}&look=${look.join(',')}`);
  await frames(page, 2);
  const s = await state(page);
  const want = norm(sub(look, pos));
  check('?pos=…&look=… の視点から始まる', maxAbsDiff(s.position, pos) < 1e-5 && maxAbsDiff(s.direction, want) < 1e-5 && s.mode === 'fly',
    `位置 ${fmt(s.position)}, 向き ${fmt(s.direction)}`);
  const hud = (await hudText(page)).split('\n').pop();
  check('HUD の最終行に現在の視点が URL パラメータで出る', hud.startsWith('?pos=-0.5,0.3,-0.7&look='), JSON.stringify(hud));
  await page.close();

  const def = await openPage(browser, base);
  await frames(def, 2);
  const ds = await state(def);
  // 既定の視点は、点群全体が画面に収まるホームの視点（詳細は home.cjs で検証する）
  const home = await def.evaluate(() => window.__explorer.homeView());
  check('パラメータなしではホームの視点（点群の中心を向き、全体が収まる位置）から始まる',
    maxAbsDiff(ds.position, home.pos) < 1e-4 && maxAbsDiff(ds.direction, norm(sub(home.look, home.pos))) < 1e-5 && len(sub(home.pos, home.look)) > 2,
    `位置 ${fmt(ds.position)}, 向き ${fmt(ds.direction)}`);
  await def.close();
}

async function main() {
  const dataDir = path.join(root, 'public', dataPath);
  if (!fs.existsSync(path.join(dataDir, 'manifest.json'))) throw new Error(`データがありません: ${dataDir}`);
  const ds = loadDataset(dataDir);
  const { info, views } = computeViews(ds);
  const [edge, inside] = [views[1], views[2]];
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < ds.count; i++) for (let k = 0; k < 3; k++) {
    mn[k] = Math.min(mn[k], ds.positions[3 * i + k]); mx[k] = Math.max(mx[k], ds.positions[3 * i + k]);
  }
  const center = mn.map((v, k) => (v + mx[k]) / 2);

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

    // 移動量・速度の検証は係数 1 を前提にしているので、速度の自動調整を T キーで無効にしておく
    // （自動調整そのものは autospeed.cjs で検証する）
    await page.keyboard.press('KeyT');
    await frames(page, 2);
    const auto = (await state(page)).autoSpeed;
    check('T キーで速度の自動調整を無効にする（以降の検証の前提）', auto.available && !auto.enabled && (await state(page)).speedScale === 1, JSON.stringify(auto));

    await testMovement(page, inside);
    await testDrag(page);
    await testWheel(page);
    await testGlide(page, inside);
    await testModes(page, edge, center);
    await testInertiaFly(page, inside);
    await testInertiaOverview(page, center);

    // 飛行でクラスタの内部へ進み、スクリーンショットを撮る
    console.log('\n[クラスタへの飛行]');
    const L = info.clusterCenter;
    await setView(page, edge.pos, edge.look);
    await frames(page, 3);
    const s0 = await state(page);
    await holdKeysFor(page, ['KeyW'], 0.4); // 縁からクラスタの内部まで届く距離を、描画の速さによらず進むため、フレーム数ではなく模擬の時間（0.4 秒分）で押す。離したあとの滑走（約 0.2）も加わって、中心の近くで止まる（長く押すと、中心を通り過ぎて反対側へ出る）
    const s1 = await state(page);
    const d0 = len(sub(s0.position, L)), d1 = len(sub(s1.position, L));
    await page.screenshot({ path: path.join(outDir, 'controls-fly-inside.png') });
    check('縁から W で進み、クラスタの内部（中心から r90 以内）へ入る', d1 < d0 - 0.1 && d1 < info.r90, `クラスタ中心までの距離 ${d0.toFixed(3)} → ${d1.toFixed(3)}（r50 ${info.r50}, r90 ${info.r90}）→ artifacts/controls-fly-inside.png`);

    await page.keyboard.press('KeyO');
    await page.waitForFunction(() => window.__explorer.getState().mode === 'overview');
    await setView(page, [1.4, 0.9, 1.5], center); // 俯瞰の見え方を撮るため、外側から全体を見る
    await frames(page, 3);
    await page.screenshot({ path: path.join(outDir, 'controls-overview.png') });
    console.log('俯瞰モードのスクリーンショット → artifacts/controls-overview.png');
    await page.close();

    await testInertiaReducedMotion(browser, base);
    await testUrl(browser, base);

    check('コンソールエラーがない', consoleErrors.length === 0, consoleErrors.join(' | '));
  } finally {
    if (browser) await browser.close();
    stop();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 件が成功`);
  if (failed.length) console.log(`失敗:\n  ${failed.map((r) => r.name).join('\n  ')}`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exit(1); });
