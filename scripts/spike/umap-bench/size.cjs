#!/usr/bin/env node
// dist/ に出た Worker バンドルの大きさ（圧縮前・gzip・brotli）と、Wasm 本体の大きさを出す。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const dir = path.join(__dirname, 'dist/assets');
const out = {};
for (const f of fs.readdirSync(dir)) {
  const buf = fs.readFileSync(path.join(dir, f));
  out[f] = { raw: buf.length, gzip: zlib.gzipSync(buf, { level: 9 }).length, brotli: zlib.brotliCompressSync(buf).length };
  // Wasm の data URI を取り出して大きさを測る
  const s = buf.toString('utf8');
  const m = s.match(/data:application\/wasm;base64,([A-Za-z0-9+/=]+)/);
  if (m) {
    const wasm = Buffer.from(m[1], 'base64');
    out[f].wasm = { dataUriBase64Chars: m[1].length, raw: wasm.length, gzip: zlib.gzipSync(wasm, { level: 9 }).length, brotli: zlib.brotliCompressSync(wasm).length };
  }
}
// 参考: パッケージ全体
const pk = path.join(__dirname, 'node_modules/embedding-atlas/dist');
let total = 0; for (const f of fs.readdirSync(pk)) if (f.endsWith('.js')) total += fs.statSync(path.join(pk, f)).size;
out._embeddingAtlasPackageJsTotalRaw = total;
const ujs = path.join(__dirname, 'node_modules/umap-js/dist');
let ut = 0; for (const f of fs.readdirSync(ujs)) if (f.endsWith('.js')) ut += fs.statSync(path.join(ujs, f)).size;
out._umapJsPackageJsTotalRaw = ut;
fs.mkdirSync(path.join(__dirname, 'results'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'results/sizes.json'), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out, null, 2));
