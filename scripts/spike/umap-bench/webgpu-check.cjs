// この環境のヘッドレス Chromium で WebGPU が使えるか（embedding-atlas の gpu: true を試せるか）を確認する。
const { chromium } = require('playwright');
const { start } = require('./server.cjs');
(async () => {
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const out = {};
  for (const [name, args] of [['既定', []], ['unsafe-webgpu + swiftshader', ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-angle=swiftshader', '--disable-vulkan-surface']]]) {
    const b = await chromium.launch({ args });
    const p = await b.newPage();
    await p.goto(url);
    out[name] = await p.evaluate(async () => {
      if (!navigator.gpu) return { hasNavigatorGpu: false };
      try { const a = await navigator.gpu.requestAdapter(); return { hasNavigatorGpu: true, adapter: a ? (a.info ? { vendor: a.info.vendor, architecture: a.info.architecture, isFallback: a.isFallbackAdapter } : 'あり') : null }; }
      catch (e) { return { hasNavigatorGpu: true, error: String(e) }; }
    });
    await b.close();
  }
  server.close();
  console.log(JSON.stringify(out, null, 2));
  require('fs').writeFileSync(require('path').join(__dirname, 'results/webgpu.json'), JSON.stringify(out, null, 2) + '\n');
})();
