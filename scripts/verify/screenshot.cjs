#!/usr/bin/env node
/**
 * ビルドしてプレビューサーバーを起動し、ヘッドレス Chromium で4つの視点のスクリーンショットを撮る。
 *
 *   node scripts/verify/screenshot.cjs [--data data/mnist/] [--no-build] [--size 0.004] [--out artifacts]
 *
 * 視点（俯瞰・クラスタの縁・内部・さらに深い位置）は、データから密な領域を計算して決める。
 * フレーム時間の実測値とコンソールエラーの有無を出力し、エラーがあれば終了コード 1 で終わる。
 */
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { loadDataset, computeViews, waitForServer, startPreview, CHROMIUM_ARGS } = require('./lib.cjs');

const root = path.resolve(__dirname, '../..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const dataPath = opt('data', 'data/mnist/').replace(/\/?$/, '/');
const outDir = path.resolve(root, opt('out', 'artifacts'));
const sizeParam = opt('size', null);
const port = Number(opt('port', '4317'));
const width = Number(opt('width', '1280')), height = Number(opt('height', '800'));

async function main() {
  const dataDir = path.join(root, 'public', dataPath);
  if (!fs.existsSync(path.join(dataDir, 'manifest.json'))) throw new Error(`データがありません: ${dataDir}`);
  const ds = loadDataset(dataDir);
  const { info, views } = computeViews(ds);
  console.log('データ:', ds.manifest.name, `${ds.count} 点`);
  console.log('密な領域:', JSON.stringify(info));

  if (!args.includes('--no-build')) {
    console.log('ビルド中…');
    execSync('npm run build', { cwd: root, stdio: 'inherit' });
  }
  fs.mkdirSync(outDir, { recursive: true });

  const { base, stop } = startPreview(root, port);
  let browser;
  const consoleErrors = [];
  const consoleWarnings = [];
  try {
    await waitForServer(base);
    browser = await chromium.launch({ args: CHROMIUM_ARGS });
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(`[error] ${m.text()}`);
      else if (m.type() === 'warning') consoleWarnings.push(m.text());
    });
    page.on('pageerror', (e) => consoleErrors.push(`[pageerror] ${e.message}`));
    page.on('requestfailed', (r) => consoleErrors.push(`[requestfailed] ${r.url()}`));

    const q = new URLSearchParams({ data: dataPath });
    if (sizeParam) q.set('size', sizeParam);
    await page.goto(`${base}?${q}`);
    await page.waitForFunction(() => window.__explorer && (window.__explorer.ready || window.__explorer.error), null, { timeout: 60000 });
    const err = await page.evaluate(() => window.__explorer.error);
    if (err) throw new Error(`アプリの起動に失敗: ${err}`);
    const gl = await page.evaluate(() => {
      const c = document.querySelector('canvas'); const g = c.getContext('webgl2');
      const d = g.getExtension('WEBGL_debug_renderer_info');
      return { renderer: d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER), samples: g.getParameter(g.SAMPLES) };
    });
    console.log('WebGL:', JSON.stringify(gl));

    const results = [];
    for (const v of views) {
      await page.evaluate((view) => window.__explorer.setView(view), { pos: v.pos, look: v.look });
      // ダンピングが落ち着くまで待ってから計測・撮影
      await page.evaluate(() => window.__explorer.measureFrames(20));
      const stats = await page.evaluate(() => window.__explorer.measureFrames(60));
      const file = path.join(outDir, `${v.name}.png`);
      await page.screenshot({ path: file });
      // 変更の前後の画像の比較（imagediff.cjs）で、目印と現在地の部分を除くための矩形（CSS ピクセル。x, y, w, h）
      const chips = await page.evaluate(() => [...document.querySelectorAll('.cluster-label, #cluster-location')]
        .filter((e) => !e.hidden && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).display !== 'none')
        .map((e) => { const r = e.getBoundingClientRect(); return [Math.floor(r.left) - 1, Math.floor(r.top) - 1, Math.ceil(r.width) + 2, Math.ceil(r.height) + 2]; }));
      fs.writeFileSync(path.join(outDir, `${v.name}.chips.json`), JSON.stringify(chips));
      results.push({ ...v, file: path.relative(root, file), frame: stats });
      console.log(`${v.label}: ?pos=${v.pos.join(',')}&look=${v.look.join(',')}`);
      console.log(`  フレーム時間 中央値 ${stats.medianMs.toFixed(1)}ms / 平均 ${stats.meanMs.toFixed(1)}ms / p95 ${stats.p95Ms.toFixed(1)}ms → ${path.relative(root, file)}`);
    }
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ dataset: ds.manifest.name, info, gl, results, consoleErrors, consoleWarnings }, null, 2));
    if (consoleWarnings.length) console.log(`コンソール警告 ${consoleWarnings.length} 件（参考）:\n  ${consoleWarnings.join('\n  ')}`);
    console.log(consoleErrors.length ? `コンソールエラー ${consoleErrors.length} 件:\n${consoleErrors.join('\n')}` : 'コンソールエラー: なし');
    process.exitCode = consoleErrors.length ? 1 : 0;
  } finally {
    if (browser) await browser.close();
    stop();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
