#!/usr/bin/env node
/**
 * 計測用の合成データセット（MNIST を複製して小さな雑音を加えた N 点）を作る。
 *
 *   node scripts/spike/switch-stall/make-synth.cjs --out <dir> [--copies 7] [--sigma 0.01]
 *
 * public/data/mnist の 3 次元座標とラベルを `copies` 回複製し、各複製に等方ガウス雑音（標準偏差 sigma。座標の絶対値の最大は 1）を加える。
 * kNN グラフは、この 3 次元座標での厳密な k=50 近傍（UMAP の計算の入力としてだけ使う。点の意味は MNIST と同じではない）。
 * 点群の構造（空間の構造の計算の負荷）を 7 万点へ合わせるためのもので、UMAP の結果の質を測るものではない。
 * 点ごとの文字列は `<ラベル>-<番号>`（kind を text にするためのもの。画像のアトラスは作らない）。
 * manifest の bounds・density・overview・clusters は MNIST のものを流用する（点の数と、ラベルのあるデータセットという形を合わせるため）。
 * 出力は乱数の種を固定しているので、同じ引数なら同じ内容になる。
 */
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const root = path.resolve(__dirname, '../../..');
const out = path.resolve(opt('out', ''));
const copies = Number(opt('copies', '7'));
const sigma = Number(opt('sigma', '0.01'));
const K = 50;
if (!opt('out', '')) { console.error('--out <dir> が必要です'); process.exit(2); }

const src = path.join(root, 'public/data/mnist');
const manifest = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8'));
const buf = (f) => { const b = fs.readFileSync(path.join(src, f)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const P0 = new Float32Array(buf('positions.f32'));
const L0 = new Uint8Array(buf('labels.u8'));
const n0 = L0.length;
const N = n0 * copies;

function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260101);
const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());

const P = new Float32Array(3 * N);
const labels = new Uint8Array(N);
for (let c = 0; c < copies; c++) {
  for (let i = 0; i < n0; i++) {
    const o = c * n0 + i;
    labels[o] = L0[i];
    for (let a = 0; a < 3; a++) P[3 * o + a] = P0[3 * i + a] + (c === 0 ? 0 : sigma * gauss());
  }
}

// 厳密な K 近傍（格子。セルの 1 辺は、1 セルあたりの点数が 25 前後になる大きさ）
console.log(`kNN（${N} 点、k=${K}）を計算します…`);
const t0 = Date.now();
const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < N; i++) for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], P[3 * i + a]); mx[a] = Math.max(mx[a], P[3 * i + a]); }
const vol = (mx[0] - mn[0]) * (mx[1] - mn[1]) * (mx[2] - mn[2]);
const cell = Math.cbrt(vol / (N / 25));
const dims = [0, 1, 2].map((a) => Math.max(1, Math.ceil((mx[a] - mn[a]) / cell)));
const cellOf = (v, a) => Math.min(dims[a] - 1, Math.floor((v - mn[a]) / cell));
const key = (x, y, z) => (x * dims[1] + y) * dims[2] + z;
const heads = new Map();
for (let i = 0; i < N; i++) {
  const k = key(cellOf(P[3 * i], 0), cellOf(P[3 * i + 1], 1), cellOf(P[3 * i + 2], 2));
  let a = heads.get(k);
  if (!a) heads.set(k, (a = []));
  a.push(i);
}
const idx = new Uint32Array(N * K);
const dist = new Float32Array(N * K);
for (let i = 0; i < N; i++) {
  const x = P[3 * i], y = P[3 * i + 1], z = P[3 * i + 2];
  const cx = cellOf(x, 0), cy = cellOf(y, 1), cz = cellOf(z, 2);
  let found = [];
  for (let r = 1; ; r++) {
    found = [];
    for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
      const X = cx + dx, Y = cy + dy, Z = cz + dz;
      if (X < 0 || Y < 0 || Z < 0 || X >= dims[0] || Y >= dims[1] || Z >= dims[2]) continue;
      const a = heads.get(key(X, Y, Z));
      if (!a) continue;
      for (const j of a) if (j !== i) found.push([(P[3 * j] - x) ** 2 + (P[3 * j + 1] - y) ** 2 + (P[3 * j + 2] - z) ** 2, j]);
    }
    const inside = found.filter((f) => f[0] <= (r * cell) ** 2);
    if (inside.length >= K || (r > Math.max(...dims) && found.length >= K)) { found = inside.length >= K ? inside : found; break; }
  }
  found.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  for (let j = 0; j < K; j++) { idx[i * K + j] = found[j][1]; dist[i * K + j] = Math.sqrt(found[j][0]); }
}
console.log(`kNN: ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);

fs.mkdirSync(out, { recursive: true });
const w = (name, arr) => fs.writeFileSync(path.join(out, name), Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength));
w('positions.f32', P);
w('labels.u8', labels);
w('knn-indices.u32', idx);
w('knn-distances.f32', dist);
fs.writeFileSync(path.join(out, 'text.json'), JSON.stringify(Array.from(labels, (l, i) => `${l}-${i % 1000}`)));
const tile = (f) => { const a = new Uint16Array(buf(f)); const o = new Uint16Array(N); for (let c = 0; c < copies; c++) o.set(a, c * n0); return o; };
w('clusters-coarse.u16', tile('clusters-coarse.u16'));
w('clusters-fine.u16', tile('clusters-fine.u16'));
const m = {
  name: `合成 ${N} 点（MNIST を ${copies} 回複製、雑音 ${sigma}）`,
  kind: 'text',
  text: { file: 'text.json' },
  count: N,
  positions: { file: 'positions.f32', dtype: 'float32', components: 3 },
  labels: { file: 'labels.u8', dtype: 'uint8', names: manifest.labels.names },
  umap: manifest.umap,
  knn: { k: K, metric: 'euclidean', includesSelf: false, exact: true, indices: { file: 'knn-indices.u32', dtype: 'uint32' }, distances: { file: 'knn-distances.f32', dtype: 'float32' } },
  bounds: manifest.bounds,
  density: manifest.density,
  overview: manifest.overview,
  clusters: { ...manifest.clusters, levels: manifest.clusters.levels.map((l) => ({ ...l, pointFile: l.pointFile })) },
};
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(m));
console.log(`書き出しました: ${out}（${N} 点）`);
