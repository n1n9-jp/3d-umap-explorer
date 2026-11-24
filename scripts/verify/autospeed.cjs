#!/usr/bin/env node
/**
 * 速度の自動調整の検証。ビルドしてプレビューサーバーを起動し、ヘッドレス Chromium で、点群の外から
 * 密なクラスタの中心へ向かって W を押し続け、フレームごとの位置・係数・実際の速度を記録して確かめる。
 *
 *   node scripts/verify/autospeed.cjs [--no-build] [--port 4319] [--out artifacts]
 *
 * 目標のクラスタは、manifest の粗い階層のクラスタのうち、medoid（`center`）のまわりが最も密なもの。
 * その medoid から点群の中心と反対の向き（外向き）へ、周囲に点がない位置まで下がったところから出発する。
 * ソフトウェア描画では 1 フレームが約 200 ミリ秒かかり、アプリの経過時間は 1 フレーム 0.1 秒で頭打ちになる。
 * 速度や変化率は、アプリと同じ経過時間（rAF の時刻の差を 0.1 秒で頭打ち）で割って求める。
 * 失敗があれば終了コード 1 で終わる。記録は artifacts/autospeed.json にも保存する。
 */
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { loadDataset, waitForServer, startPreview, CHROMIUM_ARGS, sub, add, mul, len, norm, waitReorient } = require('./lib.cjs');

const root = path.resolve(__dirname, '../..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const outDir = path.resolve(root, opt('out', 'artifacts'));
const port = Number(opt('port', '4319'));
const dataPath = 'data/mnist/';
const width = 1280, height = 800;

// アプリの設定（src/app/autoSpeed.ts の AUTO_SPEED_DEFAULTS と、main.ts の dt の上限）
const DEFAULT_SPEED = 0.45; // ホイールで変えていないときの飛行速度（src/controls/FlyMotion.ts の既定。Shift の加速はない）
const MAX_SCALE = 4;
const REFERENCE_MULTIPLIER = 6; // 係数 1 の距離 = 6 × knnDistP50
const LOOKAHEAD_SECONDS = 0.3;
const DECEL_MAX_RATE = 6; // 係数の自然対数が 1 秒あたりに下がる速さの上限
const ACCEL_MAX_RATE = 1.2; // 同じく上がる速さの上限
const MAX_DT = 0.1;
// 目安: 密なクラスタの内部で、実速度が 1 秒あたり点の間隔の 6〜12 倍
// （係数の式は変えず、既定の速度を 0.15 から 0.45 の 3 倍にしたので、以前の 2〜4 倍の 3 倍。実測は約 7.2〜7.5 倍）
const SPACING_RATIO = [6, 12];

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// ---------- データ側の計算（総当たり。1 万点なら数秒） ----------

function neighbors(ds, q, k) {
  const { positions: P, count } = ds;
  const best = []; // [距離, 添字] の昇順
  for (let i = 0; i < count; i++) {
    const d = Math.hypot(P[3 * i] - q[0], P[3 * i + 1] - q[1], P[3 * i + 2] - q[2]);
    if (best.length < k || d < best[best.length - 1][0]) {
      best.push([d, i]);
      best.sort((a, b) => a[0] - b[0]);
      if (best.length > k) best.pop();
    }
  }
  return best;
}

const meanDist = (ds, q, k) => neighbors(ds, q, k).reduce((a, b) => a + b[0], 0) / k;

/** 各点の最近傍距離（隣の点までの距離）。格子ハッシュで近いセルだけを見る。 */
function nearestNeighborDistances(ds) {
  const { positions: P, count } = ds;
  const cell = 0.02, key = (x, y, z) => `${x},${y},${z}`, ci = (v) => Math.floor(v / cell);
  const grid = new Map();
  for (let i = 0; i < count; i++) {
    const k = key(ci(P[3 * i]), ci(P[3 * i + 1]), ci(P[3 * i + 2]));
    let a = grid.get(k); if (!a) grid.set(k, (a = [])); a.push(i);
  }
  const out = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const x = P[3 * i], y = P[3 * i + 1], z = P[3 * i + 2];
    let best = Infinity;
    for (let r = 1; r <= 64 && !(best <= (r - 1) * cell); r *= 2) {
      best = Infinity;
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
        const a = grid.get(key(ci(x) + dx, ci(y) + dy, ci(z) + dz)); if (!a) continue;
        for (const j of a) {
          if (j === i) continue;
          const d = Math.hypot(P[3 * j] - x, P[3 * j + 1] - y, P[3 * j + 2] - z);
          if (d < best) best = d;
        }
      }
    }
    out[i] = best;
  }
  return out;
}

/** 位置 q の「周囲の点の間隔」: q に近い 8 点それぞれの、隣の点までの距離の平均。 */
const localSpacing = (ds, nn, q) => { const nb = neighbors(ds, q, 8); return nb.reduce((a, [, i]) => a + nn[i], 0) / nb.length; };

/** 目標のクラスタと出発点を決める。 */
function planFlight(ds) {
  const { manifest } = ds;
  const k = manifest.density.k;
  const saturation = MAX_SCALE * REFERENCE_MULTIPLIER * manifest.density.knnDistP50; // 係数が上限になる距離
  const clusters = manifest.clusters.levels[0].clusters;
  const scored = clusters.map((c) => ({ c, d: meanDist(ds, c.center, k) })).sort((a, b) => a.d - b.d);
  const target = scored[0].c;
  const C = target.center;
  const out = norm(sub(C, manifest.bounds.center));
  // 外向きに下がり、点群の外接球の外で、最も近い点までの距離が、飽和距離に「上限の実速度（既定の速度 × 上限の係数）で
  // 進行方向の先を見る距離」の 3 倍を足した値を超える位置から出発する（進行方向の先を見ても、しばらくは係数が上限のままになる）
  const lookahead = DEFAULT_SPEED * MAX_SCALE * LOOKAHEAD_SECONDS;
  const farEnough = saturation + 3 * lookahead;
  let r = target.radius;
  while (len(sub(add(C, mul(out, r)), manifest.bounds.center)) < manifest.bounds.radius || neighbors(ds, add(C, mul(out, r)), 1)[0][0] < farEnough) r += 0.02;
  return { target, centerDensity: scored[0].d, start: add(C, mul(out, r)), startDistance: r, saturation };
}

// ---------- ブラウザ ----------

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
const frames = (page, n) => page.evaluate((k) => window.__explorer.measureFrames(k), n);
const setView = (page, pos, look) => page.evaluate((v) => window.__explorer.setView(v), { pos, look });
const hudLine = async (page) => (await page.evaluate(() => document.getElementById('hud').innerText)).split('\n')[1];

/**
 * 毎フレーム（アプリの更新の後）getState() を記録する。`stopWithin` 以内にクラスタの中心へ近づくか、
 * `maxFrames` フレームで止める。
 */
function record(page, { center, stopWithin, maxFrames }) {
  return page.evaluate(({ center, stopWithin, maxFrames }) => new Promise((resolve) => {
    const rows = [];
    const step = (t) => {
      const s = window.__explorer.getState();
      rows.push({ t, s });
      const d = Math.hypot(s.position[0] - center[0], s.position[1] - center[1], s.position[2] - center[2]);
      if (rows.length >= maxFrames || d < stopWithin) resolve(rows);
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }), { center, stopWithin, maxFrames });
}

// ---------- 本体 ----------

const f = (x, n = 4) => (x === null || x === undefined ? '-' : Number(x).toFixed(n));
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };

async function main() {
  const dataDir = path.join(root, 'public', dataPath);
  const ds = loadDataset(dataDir);
  if (!ds.manifest.density || !ds.manifest.clusters || !ds.manifest.bounds) throw new Error('manifest に density・clusters・bounds が必要です');
  const plan = planFlight(ds);
  const { target, start } = plan;
  const C = target.center;
  const nn = nearestNeighborDistances(ds);
  console.log(`目標のクラスタ: 「${target.name}」（id ${target.id}、${target.size} 点、medoid のまわりの 8 近傍平均 ${f(plan.centerDensity)}、半径 ${f(target.radius, 3)}）`);
  console.log(`出発点: medoid から外向きに ${f(plan.startDistance, 3)}（${start.map((v) => v.toFixed(3)).join(', ')}）、飽和距離 ${f(plan.saturation)}`);

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

    const s0 = await state(page);
    check('始めは自動調整が使えて、有効', s0.autoSpeed.available && s0.autoSpeed.enabled, JSON.stringify(s0.autoSpeed));
    check('HUD に自動調整と実速度が出る', /自動調整 入 {2}実速度 /.test(await hudLine(page)), JSON.stringify(await hudLine(page)));

    // ---- 点群の外からクラスタの中心へ ----
    console.log('\n[点群の外からクラスタの中心へ W を押し続ける]');
    await page.mouse.move(width / 2, height / 2);
    await setView(page, start, C);
    await frames(page, 3);
    const speed0 = (await state(page)).speed;
    const rec = record(page, { center: C, stopWithin: 0.01, maxFrames: 240 });
    await page.keyboard.down('KeyW');
    const raw = await rec;
    await page.keyboard.up('KeyW');
    await frames(page, 8);

    const rows = [];
    for (let i = 1; i < raw.length; i++) {
      const dt = Math.min(MAX_DT, (raw[i].t - raw[i - 1].t) / 1000);
      const s = raw[i].s, p = raw[i - 1].s;
      const moved = len(sub(s.position, p.position));
      rows.push({
        frame: i, dt, distC: len(sub(s.position, C)), outside: len(sub(s.position, ds.manifest.bounds.center)) > ds.manifest.bounds.radius,
        distance: s.autoSpeed.distance, scale: s.autoSpeed.scale, speedScale: s.speedScale, speed: s.speed, effective: s.effectiveSpeed,
        measured: moved / dt, dlog: Math.log(s.autoSpeed.scale / p.autoSpeed.scale) / dt, position: s.position,
      });
    }
    for (const r of rows) {
      r.spacing = localSpacing(ds, nn, r.position);
      r.ratio = r.measured / r.spacing;
      r.nearest = neighbors(ds, r.position, 1)[0][0];
      // 何もない空間: 最も近い点が、飽和距離に、進行方向の先を見る距離（実速度 × 0.3 秒）を足したより遠い
      r.empty = r.nearest > plan.saturation + r.effective * LOOKAHEAD_SECONDS;
    }
    fs.writeFileSync(path.join(outDir, 'autospeed.json'), JSON.stringify({ plan, rows }, null, 1));

    // 表（位置はクラスタの中心＝medoid からの距離）
    console.log(`\n記録 ${rows.length} フレーム（アプリの経過時間 ${f(rows.reduce((a, r) => a + r.dt, 0), 2)} 秒）→ artifacts/autospeed.json`);
    console.log('frame  中心からの距離  採用した距離  係数    実速度(speed×scale)  測った速度  点の間隔  速度/間隔');
    const stride = Math.max(1, Math.ceil(rows.length / 60));
    rows.forEach((r, i) => {
      if (i % stride !== 0 && i !== rows.length - 1) return;
      const note = r.empty ? '  （何もない空間）' : r.outside ? '  （点群の外接球の外）' : r.distC <= target.radius * 0.5 ? '  （内部）' : r.distC <= target.radius ? '  （縁の内側）' : '';
      console.log(`${String(r.frame).padStart(5)}  ${f(r.distC).padStart(13)}  ${f(r.distance).padStart(12)}  ${f(r.scale, 3).padStart(6)}  ${f(r.effective).padStart(19)}  ${f(r.measured).padStart(10)}  ${f(r.spacing).padStart(8)}  ${f(r.ratio, 2).padStart(9)}${note}`);
    });
    console.log('');

    const outsideRows = rows.filter((r) => r.empty);
    const innerRadius = target.radius * 0.5;
    const insideRows = rows.filter((r) => r.distC <= innerRadius);
    const last = rows[rows.length - 1];
    check('クラスタの中心まで進む', last.distC < 0.03, `最後の位置は中心から ${f(last.distC)}（${rows.length} フレーム）`);
    check('点群の外の何もない空間では係数が上限（4）', outsideRows.length >= 3 && Math.min(...outsideRows.map((r) => r.scale)) >= MAX_SCALE * 0.999,
      `何もない空間 ${outsideRows.length} フレームで係数 ${f(Math.min(...outsideRows.map((r) => r.scale)), 3)}〜${f(Math.max(...outsideRows.map((r) => r.scale)), 3)}`);
    check('クラスタの内部（中心から半径の半分以内）では係数が小さい（上限の 1/10 以下）', insideRows.length > 0 && Math.max(...insideRows.map((r) => r.scale)) <= MAX_SCALE / 10,
      `内部 ${insideRows.length} フレームで係数 ${f(Math.min(...insideRows.map((r) => r.scale)), 3)}〜${f(Math.max(...insideRows.map((r) => r.scale)), 3)}`);

    const firstDrop = rows.find((r) => r.scale < 0.9 * MAX_SCALE);
    const atEdge = rows.find((r) => r.distC <= target.radius);
    check('クラスタの縁へ着く前に減速が始まる（係数が上限の 9 割を切るのは縁より外）', firstDrop && firstDrop.distC > target.radius,
      firstDrop ? `係数が下がり始めた位置は中心から ${f(firstDrop.distC)}（縁は ${f(target.radius)}）` : '係数が下がらない');
    check('縁に着いた時点で、係数はすでに上限の半分以下', atEdge && atEdge.scale <= MAX_SCALE / 2, atEdge ? `縁での係数 ${f(atEdge.scale, 3)}` : '縁に着かない');

    const maxDown = Math.max(0, ...rows.map((r) => -r.dlog));
    const maxUp = Math.max(0, ...rows.map((r) => r.dlog));
    const maxStep = Math.max(...rows.map((r) => Math.abs(r.dlog * r.dt)));
    check('係数の変化が滑らか（対数の変化の速さが、下げは 6/秒・上げは 1.2/秒以内）', maxDown <= DECEL_MAX_RATE * 1.001 && maxUp <= ACCEL_MAX_RATE * 1.001,
      `下げ 最大 ${f(maxDown, 3)}/秒、上げ 最大 ${f(maxUp, 3)}/秒、1 フレームの変化 最大 ×${f(Math.exp(maxStep), 3)}`);
    check('実際に設定された係数（speedScale）は自動調整の係数と一致する', rows.every((r) => r.speedScale === r.scale));

    // 内部で落ち着いてから（係数の変化が 1 秒あたり 0.5 以内）の速度と点の間隔
    const settled = insideRows.filter((r) => Math.abs(r.dlog) < 0.5);
    const ratios = settled.map((r) => r.ratio);
    const med = median(ratios);
    check(`クラスタの内部で、実速度が 1 秒あたり点の間隔の ${SPACING_RATIO[0]}〜${SPACING_RATIO[1]} 倍（中央値）`, settled.length > 0 && med >= SPACING_RATIO[0] && med <= SPACING_RATIO[1],
      `${settled.length} フレームで 中央値 ${f(med, 2)} 倍（${f(Math.min(...ratios), 2)}〜${f(Math.max(...ratios), 2)}）、実速度 ${f(median(settled.map((r) => r.measured)))}、点の間隔 ${f(median(settled.map((r) => r.spacing)))}`);
    check('飛行中、ホイールで決めた speed は変わらない', rows.every((r) => r.speed === speed0), `speed ${speed0}`);

    // ---- T キーで切り替え ----
    console.log('\n[T キーで無効・有効]');
    // 速度が 3 倍で、中心へ着いたあとは慣性で行き過ぎて位置が定まらないので、クラスタの中心の手前 0.1 から中心を向いて始める
    await setView(page, add(C, mul(norm(sub(start, C)), 0.1)), C);
    await frames(page, 10);
    const before = await state(page);
    await page.keyboard.press('KeyT');
    await frames(page, 3);
    const off = await state(page);
    check('T で無効になり、係数（speedScale）が 1 になる', !off.autoSpeed.enabled && off.speedScale === 1 && off.effectiveSpeed === off.speed,
      `有効 ${before.autoSpeed.enabled} → ${off.autoSpeed.enabled}、speedScale ${f(before.speedScale, 3)} → ${off.speedScale}`);
    check('無効のとき HUD に「自動調整 切」と実速度＝飛行速度が出る', (await hudLine(page)).includes(`自動調整 切  実速度 ${off.speed.toPrecision(3)}`), JSON.stringify(await hudLine(page)));
    const p0 = off.position;
    // 速度が 3 倍（係数 1 で 0.45 単位/秒）なので、以前の 6 フレームでは中心を通り越して外へ出る。1 フレームだけ進める
    await page.keyboard.down('KeyW');
    await frames(page, 1);
    const moving = await state(page);
    await page.keyboard.up('KeyW');
    check('無効のあいだは、クラスタの内部でも動いている間 speedScale が 1 のまま', moving.speedScale === 1 && len(sub(moving.position, p0)) > 0.02,
      `移動 ${f(len(sub(moving.position, p0)))}`);
    await frames(page, 6);
    // 無効のままのフレームを数フレーム記録してから T を押す（有効にした直後の 1 フレーム目の変化も測る）
    const recOn = record(page, { center: C, stopWithin: -1, maxFrames: 16 });
    await frames(page, 2);
    await page.keyboard.press('KeyT');
    const onRows = await recOn;
    const on2 = onRows[onRows.length - 1].s;
    const refDist = REFERENCE_MULTIPLIER * ds.manifest.density.knnDistP50;
    const want = Math.min(MAX_SCALE, Math.max(0.05, on2.autoSpeed.distance / refDist));
    const offCount = onRows.findIndex((r) => r.s.autoSpeed.enabled);
    const seq = onRows.slice(Math.max(0, offCount - 1)).map((r) => r.s.speedScale); // 先頭は無効の最後のフレーム（係数 1）
    let maxDropRate = 0;
    for (let i = 1; i < onRows.length; i++) {
      const dt = Math.min(MAX_DT, (onRows[i].t - onRows[i - 1].t) / 1000);
      maxDropRate = Math.max(maxDropRate, Math.log(onRows[i - 1].s.speedScale / onRows[i].s.speedScale) / dt);
    }
    check('T で有効に戻ると、係数 1 から滑らかに（跳ばずに）下がり、その位置の目標の係数に落ち着く',
      offCount >= 1 && seq[0] === 1 && on2.autoSpeed.enabled && seq.length >= 4 && seq.every((v, i) => i === 0 || v <= seq[i - 1]) && maxDropRate <= DECEL_MAX_RATE * 1.001 && Math.abs(Math.log(on2.speedScale / want)) < 0.01 && want < 0.9,
      `係数 ${seq.slice(0, 7).map((v) => f(v, 3)).join(' → ')} … ${f(on2.speedScale, 3)}（目標 ${f(want, 3)}、下げの速さ 最大 ${f(maxDropRate, 2)}/秒）`);
    check('有効に戻ると HUD が「自動調整 入」', (await hudLine(page)).includes('自動調整 入'), JSON.stringify(await hudLine(page)));

    // ---- ホイールで決めた speed と係数は独立 ----
    console.log('\n[ホイールと係数]');
    await frames(page, 10);
    const w0 = await state(page);
    await page.mouse.wheel(0, -100);
    await frames(page, 3);
    const w1 = await state(page);
    check('ホイールで speed が変わり（1.1 倍）、止まっている間の係数は変わらない',
      Math.abs(w1.speed / w0.speed - 1.1) < 0.01 && Math.abs(w1.speedScale / w0.speedScale - 1) < 0.01,
      `speed ${f(w0.speed)} → ${f(w1.speed)}、係数 ${f(w0.speedScale, 4)} → ${f(w1.speedScale, 4)}`);
    check('実速度は speed × speedScale', Math.abs(w1.effectiveSpeed - w1.speed * w1.speedScale) < 1e-12);
    check('自動調整の前後で speed は T キーでも変わらない', off.speed === before.speed && on2.speed === before.speed);
    await page.mouse.wheel(0, 100);
    await frames(page, 3);

    // ---- 俯瞰モードでは働かない ----
    console.log('\n[俯瞰モード]');
    await page.keyboard.press('KeyO');
    await page.waitForFunction(() => window.__explorer.getState().mode === 'overview');
    await waitReorient(page); // 点群の中心への向き直し（0.5 秒）が終わるまで待つ
    await frames(page, 2);
    const o0 = await state(page);
    await page.mouse.wheel(0, 300); // 中心から離れる（カメラはクラスタの外へ出る）
    await frames(page, 6);
    const o1 = await state(page);
    check('俯瞰モードでカメラが動いても、係数と採用した距離は変わらない', len(sub(o1.position, o0.position)) > 0.05 && o1.autoSpeed.scale === o0.autoSpeed.scale && o1.autoSpeed.distance === o0.autoSpeed.distance,
      `移動 ${f(len(sub(o1.position, o0.position)))}、係数 ${f(o0.autoSpeed.scale, 4)} → ${f(o1.autoSpeed.scale, 4)}`);
    check('俯瞰モードの HUD は自動調整の入切だけを出す', /自動調整 入$/.test(await hudLine(page)), JSON.stringify(await hudLine(page)));
    await page.keyboard.press('KeyO');
    await page.waitForFunction(() => window.__explorer.getState().mode === 'fly');
    await frames(page, 3);
    const back = await state(page);
    check('飛行モードへ戻ると、その位置の係数で働く', back.autoSpeed.enabled && back.speedScale === back.autoSpeed.scale && back.autoSpeed.distance !== o1.autoSpeed.distance,
      `係数 ${f(back.speedScale, 3)}、採用した距離 ${f(back.autoSpeed.distance)}`);
    await page.close();

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
