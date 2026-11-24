#!/usr/bin/env node
/**
 * ホーム復帰（H キー）と起動時の視点の検証。ビルドしてプレビューサーバーを起動し、ヘッドレス Chromium へ
 * 実際のキー入力を送って確かめる。
 *
 *   node scripts/verify/home.cjs [--no-build] [--port 4320] [--out artifacts]
 *
 * - パラメータなしで開くとホームの視点から始まり、全点が画面内に投影される（横長・縦長の両方）
 * - 飛行モード・俯瞰モードのどちらでも、H でモードを変えずにホームの視点へ滑らかに戻る
 * - 移動中の W で中断する
 * - 真下を向く視点（?pos=0,2,0&look=0,0,0）で、O キーでモードを往復しても向きが跳ばない
 * ソフトウェア描画では 1 フレームが約 200 ミリ秒かかるので、待ち時間はフレーム数と状態の変化で決める。
 * 失敗があれば終了コード 1 で終わる。
 */
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { loadDataset, computeViews, waitForServer, startPreview, CHROMIUM_ARGS, sub, len, norm, expectedFlightDuration } = require('./lib.cjs');

const root = path.resolve(__dirname, '../..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const outDir = path.resolve(root, opt('out', 'artifacts'));
const port = Number(opt('port', '4320'));
const dataPath = 'data/mnist/';
const FOV = 60;
const MAX_PITCH = (89 * Math.PI) / 180;

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const angleBetween = (a, b) => Math.acos(Math.min(1, Math.max(-1, dot(a, b) / ((len(a) * len(b)) || 1))));
const maxAbsDiff = (a, b) => Math.max(...a.map((x, i) => Math.abs(x - b[i])));
const fmt = (v) => `(${v.map((x) => x.toFixed(4)).join(', ')})`;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const consoleErrors = [];
async function openPage(browser, base, query = '', viewport = { width: 1280, height: 800 }) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
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
const homeView = (page) => page.evaluate(() => window.__explorer.homeView());
const frames = (page, n) => page.evaluate((k) => window.__explorer.measureFrames(k), n);
const setView = (page, pos, look) => page.evaluate((v) => window.__explorer.setView(v), { pos, look });
const waitForMode = (page, mode) => page.waitForFunction((m) => window.__explorer.getState().mode === m, mode);

/** 描画のフレームごとに位置・向き・移動中かどうかを記録する。移動が終わる（または `limit` フレームに達する）まで。 */
function sampleFlight(page, limit = 150) {
  return page.evaluate((max) => new Promise((resolve) => {
    const samples = [];
    const tick = () => {
      const s = window.__explorer.getState();
      samples.push({ p: s.position, d: s.direction, homing: s.homing, mode: s.mode, flight: s.flight });
      if (!s.homing || samples.length >= max) resolve(samples);
      else requestAnimationFrame(tick);
    };
    tick();
  }), limit);
}

/**
 * 現在の視点（位置と向き。カメラは横傾きを持たない）から、各点が画面に入っているかを調べる。
 * 戻り値は、全点が画面内か、はみ出し方の最大値（正規化デバイス座標の最大絶対値）、最小の奥行き。
 */
function projectAll(ds, s, aspect) {
  const d = norm(s.direction);
  let right = cross(d, [0, 1, 0]);
  right = norm(right);
  const up = cross(right, d);
  const tanHalf = Math.tan((FOV * Math.PI) / 360);
  let extent = 0, minDepth = Infinity, outside = 0;
  for (let i = 0; i < ds.count; i++) {
    const v = sub([ds.positions[3 * i], ds.positions[3 * i + 1], ds.positions[3 * i + 2]], s.position);
    const depth = dot(v, d);
    minDepth = Math.min(minDepth, depth);
    const x = dot(v, right) / (depth * tanHalf * aspect);
    const y = dot(v, up) / (depth * tanHalf);
    const m = Math.max(Math.abs(x), Math.abs(y));
    extent = Math.max(extent, m);
    if (depth <= 0 || m > 1) outside++;
  }
  return { extent, minDepth, outside };
}

const smootherstep = (t) => { const x = Math.min(1, Math.max(0, t)); return x * x * x * (x * (x * 6 - 15) + 10); };

/**
 * ホームへの移動の所要時間（基準 1 秒を距離で伸縮した式）と、進み方（smootherstep のまま）を、フレームごとの状態から確かめる。
 * カメラは止まった状態から始める。`label` は表示用、`R` は点群の半径。
 */
function checkHomeTiming(label, s0, home, samples, R) {
  const flights = samples.filter((x) => x.flight);
  const e = sub(home.pos, s0.position);
  const dist = len(e);
  if (flights.length < 3) { check(`${label}: 移動中の状態（flight）が読める`, false, `${flights.length} フレーム`); return; }
  const wantMs = expectedFlightDuration(1000, dist, R);
  const got = flights[0].flight.durationMs;
  console.log(`  [実測] ${label}: 距離 ${dist.toFixed(3)}（点群の半径 ${R.toFixed(3)} の ${(dist / R).toFixed(2)} 倍）、所要時間 ${got.toFixed(0)}ms（基準 1000ms）、記録した移動のフレーム ${flights.length}`);
  check(`${label}: 所要時間が、基準 1 秒を距離で伸縮した式のとおり（0.8〜1.8 倍）`, flights[0].flight.kind === 'home' && Math.abs(got - wantMs) < 1, `${got.toFixed(2)}ms、期待 ${wantMs.toFixed(2)}ms`);
  let maxErr = 0;
  for (const x of flights) {
    const v = sub(x.p, s0.position);
    const f = (v[0] * e[0] + v[1] * e[1] + v[2] * e[2]) / (dist * dist);
    maxErr = Math.max(maxErr, Math.abs(f - smootherstep(x.flight.progress)));
  }
  check(`${label}: 位置の進みが smootherstep のとおり（フレームごと）`, maxErr < 1e-4, `誤差の最大 ${maxErr.toExponential(2)}`);
}

const pitchOf = (d) => Math.asin(Math.max(-1, Math.min(1, d[1])));
const dirOfView = (v) => norm(sub(v.look, v.pos));

async function testStart(browser, base, ds, size, name, shot) {
  console.log(`\n[起動時の視点: ${name} ${size.width}x${size.height}]`);
  const page = await openPage(browser, base, '', size);
  await frames(page, 3);
  const s = await state(page);
  const home = await homeView(page);
  const aspect = size.width / size.height;
  check(`${name}: パラメータなしで、ホームの視点から始まる（飛行モード）`,
    s.mode === 'fly' && maxAbsDiff(s.position, home.pos) < 1e-4 && maxAbsDiff(s.direction, dirOfView(home)) < 1e-5,
    `位置 ${fmt(s.position)}, 向き ${fmt(s.direction)}, ホーム ${fmt(home.pos)}`);
  const proj = projectAll(ds, s, aspect);
  check(`${name}: 全点が画面内に投影される`, proj.outside === 0 && proj.minDepth > 0, `はみ出す点 ${proj.outside}, 画面の端までの使用率 ${proj.extent.toFixed(3)}`);
  // 全点を含む球で距離を決めるので、細長い点群では球より小さく見える（横長の画面で縦の使用率は約 0.57）
  check(`${name}: 余白が極端でない（点群が画面の縦か横の半分以上を使う）`, proj.extent > 0.5, `使用率 ${proj.extent.toFixed(3)}`);
  const axes = ds.manifest.overview && ds.manifest.overview.axes;
  if (axes) {
    check(`${name}: 第3軸の方向から見ている`, Math.abs(dot(s.direction, axes[2])) > 0.999, `|向き・第3軸| ${Math.abs(dot(s.direction, axes[2])).toFixed(5)}`);
  }
  const hud = (await page.evaluate(() => document.getElementById('hud').innerText)).split('\n');
  check(`${name}: HUD の操作説明に H キーがある`, hud[2].includes('H 全体へ戻る'), JSON.stringify(hud[2]));
  if (shot) {
    await page.screenshot({ path: path.join(outDir, shot) });
    console.log(`スクリーンショット → artifacts/${shot}`);
  }
  await page.close();
}

async function testHomeFly(page, ds, views) {
  console.log('\n[飛行モードで H: クラスタの内部からホームへ]');
  const inside = views[2];
  await setView(page, inside.pos, inside.look);
  await frames(page, 3);
  const s0 = await state(page);
  const home = await homeView(page);
  check('クラスタの内部へ移動した（ホームから離れている）', len(sub(s0.position, home.pos)) > 1.5, `ホームまでの距離 ${len(sub(s0.position, home.pos)).toFixed(3)}`);
  check('自動調整が有効なまま（移動中も妨げないことの前提）', s0.autoSpeed.available && s0.autoSpeed.enabled);

  await page.keyboard.press('KeyH');
  const samples = await sampleFlight(page);
  const last = samples[samples.length - 1];
  check('H で移動が始まり、やがて終わる', samples.length >= 4 && samples[0].homing && !last.homing, `${samples.length} フレーム`);
  check('飛行モードのまま', samples.every((x) => x.mode === 'fly'));
  check('ホームの視点（位置と向き）へ着く', maxAbsDiff(last.p, home.pos) < 1e-4 && maxAbsDiff(last.d, dirOfView(home)) < 1e-5,
    `位置の差 ${maxAbsDiff(last.p, home.pos).toExponential(1)}, 向きの差 ${maxAbsDiff(last.d, dirOfView(home)).toExponential(1)}`);

  const pts = [s0.position, ...samples.map((x) => x.p)];
  const dirs = [s0.direction, ...samples.map((x) => x.d)];
  const total = len(sub(home.pos, s0.position));
  const steps = pts.slice(1).map((p, i) => len(sub(p, pts[i])));
  const dists = pts.map((p) => len(sub(p, home.pos)));
  check('途中の位置が滑らかに変わる（フレーム間の移動量が全距離の 30% 以下）', Math.max(...steps) < total * 0.3,
    `最大 ${(Math.max(...steps) / total * 100).toFixed(1)}%, 移動量 ${steps.map((x) => (x / total * 100).toFixed(0)).join(' ')}（%）`);
  check('ホームまでの距離が単調に縮む', dists.every((d, i) => i === 0 || d <= dists[i - 1] + 1e-6));
  const mid = dists.slice(1, -1);
  check('途中の位置をとる（出発点でもホームでもない位置が複数フレームある）', mid.filter((d) => d > 0.05 * total && d < 0.95 * total).length >= 3);
  const totalTurn = angleBetween(s0.direction, dirOfView(home));
  const turns = dirs.slice(1).map((d, i) => angleBetween(d, dirs[i]));
  check('向きも滑らかに変わる（フレーム間の回転が全回転量の 30% 以下）', totalTurn < 0.05 || Math.max(...turns) < totalTurn * 0.3,
    `全回転 ${totalTurn.toFixed(3)} rad, 最大 ${Math.max(...turns).toFixed(3)} rad`);
  const firstSteps = steps.slice(0, 2), lastSteps = steps.slice(-2);
  const peak = Math.max(...steps);
  check('始まりと終わりが緩やか（最初と最後のフレームの移動量が最大の半分以下）', steps[0] < peak * 0.5 && steps[steps.length - 1] < peak * 0.5,
    `最初 ${(firstSteps[0] / peak).toFixed(2)}, 最後 ${(lastSteps[lastSteps.length - 1] / peak).toFixed(2)}（最大に対する比）`);
  checkHomeTiming('飛行モードの H', s0, home, samples, ds.manifest.bounds.radius);
  const after = await state(page);
  check('着いたあと、速度の係数が有限の正の値（自動調整が壊れていない）', Number.isFinite(after.speedScale) && after.speedScale > 0, `係数 ${after.speedScale.toFixed(3)}`);
}

async function testHomeOverview(page, ds, views) {
  console.log('\n[俯瞰モードで H]');
  const edge = views[1];
  await page.keyboard.press('KeyO');
  await waitForMode(page, 'overview');
  await setView(page, edge.pos, edge.look);
  await frames(page, 3);
  const home = await homeView(page);
  const s0 = await state(page);
  check('俯瞰モードで、ホームから離れた位置にいる', s0.mode === 'overview' && len(sub(s0.position, home.pos)) > 1);
  await page.keyboard.press('KeyH');
  const samples = await sampleFlight(page);
  const last = samples[samples.length - 1];
  check('俯瞰モードのまま、ホームの視点へ戻る', last.mode === 'overview' && samples.every((x) => x.mode === 'overview') && !last.homing &&
    maxAbsDiff(last.p, home.pos) < 1e-4 && maxAbsDiff(last.d, dirOfView(home)) < 1e-5,
    `位置の差 ${maxAbsDiff(last.p, home.pos).toExponential(1)}, ${samples.length} フレーム`);
  checkHomeTiming('俯瞰モードの H', s0, home, samples, ds.manifest.bounds.radius);
  const total = len(sub(home.pos, s0.position));
  const pts = [s0.position, ...samples.map((x) => x.p)];
  const steps = pts.slice(1).map((p, i) => len(sub(p, pts[i])));
  check('俯瞰モードでも途中の位置が滑らか', Math.max(...steps) < total * 0.3, `最大 ${(Math.max(...steps) / total * 100).toFixed(1)}%`);
  // 戻ったあとは俯瞰の操作で回せる（回転の中心は点群の中心のまま）
  const o = await state(page);
  check('戻ったあとも俯瞰モードの回転の中心を保つ', o.pivot !== null);
  await page.keyboard.press('KeyO');
  await waitForMode(page, 'fly');
  await frames(page, 2);
  const f = await state(page);
  check('O で飛行モードへ戻しても、位置と向きが跳ばない', maxAbsDiff(f.position, o.position) < 1e-6 && maxAbsDiff(f.direction, o.direction) < 1e-5);
}

async function testInterrupt(page, views) {
  console.log('\n[移動中に W で中断]');
  const inside = views[2];
  await setView(page, inside.pos, inside.look);
  await frames(page, 3);
  const home = await homeView(page);
  const s0 = await state(page);
  await page.keyboard.press('KeyH');
  await frames(page, 2);
  const mid = await state(page);
  check('H の直後、移動中である（まだ途中）', mid.homing && len(sub(mid.position, s0.position)) > 0.01 && len(sub(mid.position, home.pos)) > 0.1,
    `出発点から ${len(sub(mid.position, s0.position)).toFixed(3)}, ホームまで ${len(sub(mid.position, home.pos)).toFixed(3)}`);
  await page.keyboard.down('KeyW');
  await page.waitForFunction(() => !window.__explorer.getState().homing);
  const cut = await state(page);
  check('W を押すと移動が中断される', !cut.homing);
  await frames(page, 6);
  await page.keyboard.up('KeyW');
  await frames(page, 6);
  const end = await state(page);
  check('中断後はホームへ向かわず、W で前進する（ホームへ着いていない）', len(sub(end.position, home.pos)) > 0.1 && len(sub(end.position, cut.position)) > 0.01,
    `中断位置から ${len(sub(end.position, cut.position)).toFixed(3)} 進み、ホームまで ${len(sub(end.position, home.pos)).toFixed(3)}`);
  check('中断後も飛行モード', end.mode === 'fly' && !end.homing);
}

async function testStraightDown(browser, base) {
  console.log('\n[真下を向く視点で、O キーの往復]');
  const page = await openPage(browser, base, '&pos=0,2,0&look=0,0,0');
  await frames(page, 3);
  const f0 = await state(page);
  check('?pos=0,2,0&look=0,0,0 から始まる（仰角は -89° に収まる）', f0.mode === 'fly' && maxAbsDiff(f0.position, [0, 2, 0]) < 1e-5 && Math.abs(pitchOf(f0.direction)) <= MAX_PITCH + 1e-9 && pitchOf(f0.direction) < -1.5,
    `位置 ${fmt(f0.position)}, 仰角 ${(pitchOf(f0.direction) * 180 / Math.PI).toFixed(3)}°`);
  await page.keyboard.press('KeyO');
  await waitForMode(page, 'overview');
  await frames(page, 2);
  const o0 = await state(page);
  check('O で俯瞰へ: 位置と向きが跳ばない', maxAbsDiff(o0.position, f0.position) < 1e-6 && maxAbsDiff(o0.direction, f0.direction) < 1e-6,
    `向きの差 ${maxAbsDiff(o0.direction, f0.direction).toExponential(1)}`);
  await page.keyboard.press('KeyO');
  await waitForMode(page, 'fly');
  await frames(page, 2);
  const f1 = await state(page);
  check('O で飛行へ戻る: 位置と向きが跳ばない', maxAbsDiff(f1.position, f0.position) < 1e-6 && maxAbsDiff(f1.direction, f0.direction) < 1e-6,
    `向きの差 ${maxAbsDiff(f1.direction, f0.direction).toExponential(1)}`);

  // 俯瞰モードの setView（camera.lookAt なら ±90° になる）で真上・真下を向かせる
  await page.keyboard.press('KeyO');
  await waitForMode(page, 'overview');
  for (const [pos, label] of [[[0, 2, 0], '真下'], [[0, -2, 0], '真上']]) {
    await setView(page, pos, [0, 0, 0]);
    await frames(page, 2);
    const o = await state(page);
    check(`俯瞰モードで${label}を向く視点を設定しても、仰角は ±89° に収まる`, Math.abs(pitchOf(o.direction)) <= MAX_PITCH + 1e-9 && Math.abs(pitchOf(o.direction)) > 1.5,
      `仰角 ${(pitchOf(o.direction) * 180 / Math.PI).toFixed(3)}°`);
    await page.keyboard.press('KeyO');
    await waitForMode(page, 'fly');
    await frames(page, 2);
    const f = await state(page);
    check(`${label}の視点から飛行モードへ戻しても、向きが跳ばない`, maxAbsDiff(f.direction, o.direction) < 1e-6 && maxAbsDiff(f.position, o.position) < 1e-6,
      `向きの差 ${maxAbsDiff(f.direction, o.direction).toExponential(1)}`);
    await page.keyboard.press('KeyO');
    await waitForMode(page, 'overview');
  }
  await page.close();
}

async function main() {
  const dataDir = path.join(root, 'public', dataPath);
  if (!fs.existsSync(path.join(dataDir, 'manifest.json'))) throw new Error(`データがありません: ${dataDir}`);
  const ds = loadDataset(dataDir);
  const { views } = computeViews(ds);

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
    await testStart(browser, base, ds, { width: 1280, height: 800 }, '横長', 'home-start.png');
    await testStart(browser, base, ds, { width: 600, height: 900 }, '縦長', 'home-start-portrait.png');

    const page = await openPage(browser, base);
    await frames(page, 3);
    await testHomeFly(page, ds, views);
    await testHomeOverview(page, ds, views);
    await page.keyboard.press('KeyO'); // 飛行モードへ（testHomeOverview の最後で飛行に戻っている）
    await waitForMode(page, 'overview');
    await page.keyboard.press('KeyO');
    await waitForMode(page, 'fly');
    await testInterrupt(page, views);
    await page.close();

    await testStraightDown(browser, base);
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
