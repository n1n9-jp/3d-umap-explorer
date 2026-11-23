#!/usr/bin/env node
/**
 * 深度の精度（カメラのクリップ面）をヘッドレス Chromium で検証する。
 *
 *   node scripts/verify/depth.cjs [--data data/mnist/] [--no-build] [--steps 8] [--step 0.0002] [--out artifacts/depth]
 *
 * 視点（ホーム・俯瞰・クラスタの内部）ごとに、カメラを視線方向へわずかずつ（既定 0.0002 ずつ 8 回）動かし、
 * 各位置で次の3通りのクリップ面で描いた画像を比べる。クリップ面は x・y の投影を変えないので、
 * 同じ位置で画像が違えば、その画素は深度の分解能による前後の判定の違いである。
 *   - fixed: 変更前の固定値（近接 0.0005、遠方 12）
 *   - auto: カメラの位置と bounds から決める値（src/render/clip.ts。アプリが使う値）
 *   - ref: 参照（近接を球の手前の表面の 0.95 倍、遠方を奥の表面の 1.02 倍。深度の分解能が最も細かい）
 * ref との違いが前後の誤り、連続する位置の間で fixed だけに出る違いがちらつきの目安になる。
 * 各位置のスクリーンショット（fixed と auto）を --out に保存する。
 *
 * 失敗の条件：auto と ref の違いが、どの視点・位置でも画面の 0.01% を超える。コンソールエラーがある。
 */
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { loadDataset, computeViews, waitForServer, startPreview, CHROMIUM_ARGS, sub, add, mul, norm } = require('./lib.cjs');

const root = path.resolve(__dirname, '../..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const dataPath = opt('data', 'data/mnist/').replace(/\/?$/, '/');
const outDir = path.resolve(root, opt('out', 'artifacts/depth'));
const steps = Number(opt('steps', '8'));
const stepLen = Number(opt('step', '0.0002'));
const port = Number(opt('port', '4321'));
const width = Number(opt('width', '1280')), height = Number(opt('height', '800'));

async function main() {
  const dataDir = path.join(root, 'public', dataPath);
  const ds = loadDataset(dataDir);
  const { views } = computeViews(ds);
  const bounds = ds.manifest.bounds;
  if (!args.includes('--no-build')) execSync('npm run build', { cwd: root, stdio: 'inherit' });
  fs.mkdirSync(outDir, { recursive: true });

  const { base, stop } = startPreview(root, port);
  let browser;
  const consoleErrors = [];
  const failures = [];
  try {
    await waitForServer(base);
    browser = await chromium.launch({ args: CHROMIUM_ARGS });
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => consoleErrors.push(e.message));
    await page.goto(`${base}?${new URLSearchParams({ data: dataPath })}`);
    await page.waitForFunction(() => window.__explorer && (window.__explorer.ready || window.__explorer.error), null, { timeout: 60000 });

    const home = await page.evaluate(() => window.__explorer.homeView());
    const targets = [
      { name: 'home', label: 'ホーム（全体が見える位置）', pos: home.pos, look: home.look },
      { name: 'overview', label: '俯瞰（screenshot.cjs の視点）', pos: views[0].pos, look: views[0].look },
      { name: 'inside', label: 'クラスタの内部', pos: views[2].pos, look: views[2].look },
    ];

    const summary = [];
    for (const t of targets) {
      const dir = norm(sub(t.look, t.pos));
      const d = Math.hypot(...sub(t.pos, bounds.center));
      const outside = Math.max(0, d - bounds.radius);
      const ref = outside > 0.01
        ? { near: 0.95 * outside, far: (d + bounds.radius) * 1.02 }
        : { near: 0.0005, far: (d + bounds.radius) * 1.02 };
      const rows = [];
      for (let k = 0; k < steps; k++) {
        const pos = add(t.pos, mul(dir, k * stepLen));
        const look = add(t.look, mul(dir, k * stepLen));
        const r = await page.evaluate(({ pos, look, ref, k }) => {
          const ex = window.__explorer;
          ex.setView({ pos, look });
          const frame = (planes) => { ex.clip.override(planes); const f = ex.picking.readFrame(); return { f, clip: ex.clip.get() }; };
          const fixed = frame({ near: 0.0005, far: 12 });
          const refF = frame(ref);
          const auto = frame(null);
          const diff = (a, b) => {
            let n = 0;
            for (let i = 0; i < a.length; i += 4) {
              if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 6) n++;
            }
            return n;
          };
          const prev = window.__depthPrev;
          const out = {
            pixels: fixed.f.width * fixed.f.height,
            autoClip: auto.clip,
            fixedVsRef: diff(fixed.f.rgba, refF.f.rgba),
            autoVsRef: diff(auto.f.rgba, refF.f.rgba),
            fixedSeq: prev && k > 0 ? diff(fixed.f.rgba, prev.fixed) : null,
            autoSeq: prev && k > 0 ? diff(auto.f.rgba, prev.auto) : null,
            refSeq: prev && k > 0 ? diff(refF.f.rgba, prev.ref) : null,
          };
          window.__depthPrev = { fixed: fixed.f.rgba, auto: auto.f.rgba, ref: refF.f.rgba };
          return out;
        }, { pos, look, ref, k });
        // スクリーンショット（アプリの描画ループが描いた画面）：fixed と auto
        for (const [kind, planes] of [['fixed', { near: 0.0005, far: 12 }], ['auto', null]]) {
          await page.evaluate((p) => window.__explorer.clip.override(p), planes);
          await page.evaluate(() => window.__explorer.measureFrames(2));
          await page.screenshot({ path: path.join(outDir, `${t.name}-${kind}-${k}.png`) });
        }
        rows.push(r);
      }
      await page.evaluate(() => window.__explorer.clip.override(null));
      const pct = (n) => (n === null ? '-' : `${n}（${(100 * n / rows[0].pixels).toFixed(3)}%）`);
      console.log(`\n${t.label}: pos=${t.pos.join(',')} 中心までの距離 ${d.toFixed(3)}`);
      console.log(`  auto のクリップ面 near ${rows[0].autoClip.near.toFixed(4)} far ${rows[0].autoClip.far.toFixed(3)} / ref near ${ref.near.toFixed(4)} far ${ref.far.toFixed(3)}`);
      console.log('  位置 | fixed と ref の差 | auto と ref の差 | 前の位置との差 fixed / auto / ref');
      rows.forEach((r, k) => console.log(`  ${k} | ${pct(r.fixedVsRef)} | ${pct(r.autoVsRef)} | ${pct(r.fixedSeq)} / ${pct(r.autoSeq)} / ${pct(r.refSeq)}`));
      const maxAuto = Math.max(...rows.map((r) => r.autoVsRef));
      if (maxAuto > rows[0].pixels * 1e-4) failures.push(`${t.label}: auto と ref の差が ${maxAuto} 画素`);
      summary.push({ ...t, distance: d, ref, rows });
    }
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ summary, consoleErrors }, null, 2));
    if (consoleErrors.length) failures.push(`コンソールエラー ${consoleErrors.length} 件:\n${consoleErrors.join('\n')}`);
    console.log(failures.length ? `\n失敗:\n${failures.join('\n')}` : '\n失敗: なし');
    process.exitCode = failures.length ? 1 : 0;
  } finally {
    if (browser) await browser.close();
    stop();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
