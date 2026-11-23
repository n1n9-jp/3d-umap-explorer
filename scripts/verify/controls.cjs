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
 */
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { loadDataset, computeViews, waitForServer, startPreview, CHROMIUM_ARGS, sub, len, norm } = require('./lib.cjs');

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

const consoleErrors = [];
async function openPage(browser, base, query = '') {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
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

/** 描画が `n` フレーム進む間、キーを押し続けて離し、動きが落ち着くまで少し待つ。 */
async function holdKeys(page, keys, n) {
  for (const k of keys) await page.keyboard.down(k);
  await frames(page, n);
  for (const k of [...keys].reverse()) await page.keyboard.up(k);
  await frames(page, 4);
}

/** (x0,y0) から (x1,y1) までマウスの左ボタンでドラッグする。 */
async function drag(page, x0, y0, x1, y1) {
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x1, y1, { steps: 10 });
  await page.mouse.up();
  await frames(page, 3);
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
    check(`右ドラッグで右を向く（${name}）`, turn1 < 0 && ang1 > 0.3 && ang1 < 0.45, `回転 ${ang1.toFixed(3)} rad（150px × 0.0025 = 0.375 の見込み）`);
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
  check('ホイールを下へ回すと速度が下がる', s2 < s1 * 0.8, `${s1.toFixed(4)} → ${s2.toFixed(4)}`);
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
  await frames(page, 8); // 慣性が消えるまで待つ
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
    await testModes(page, edge, center);

    // 飛行でクラスタの内部へ進み、スクリーンショットを撮る
    console.log('\n[クラスタへの飛行]');
    const L = info.clusterCenter;
    await setView(page, edge.pos, edge.look);
    await frames(page, 3);
    const s0 = await state(page);
    await holdKeys(page, ['KeyW'], 9); // 速度が既定 0.45（旧 0.15 の 3 倍）なので、旧 28 フレームと同じ距離になる 9 フレーム
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
