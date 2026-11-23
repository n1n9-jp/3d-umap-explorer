import { describe, expect, it } from 'vitest';
import { loadDatasetArrays } from '../data/loader';
import { buildEmbeddingData, precomputedColoring } from './embedding';
import {
  LABEL_GROUP_NOISE, MEDOID_CANDIDATES, MEDOID_EXACT_MAX, MEDOID_REFERENCES, ceil6, computeBoundsSphere, computeDensity, computeOverview,
  computeStructure, labelGroups, medoidOf, percentileSorted, round6,
} from './structure';
import { SpatialIndex } from '../spatial/SpatialIndex';
import { publicFetch } from './testData';

describe('丸めとパーセンタイル', () => {
  it('numpy の percentile（linear）と同じ補間', () => {
    const s = [1, 2, 3, 4, 10];
    expect(percentileSorted(s, 0)).toBe(1);
    expect(percentileSorted(s, 50)).toBe(3);
    expect(percentileSorted(s, 90)).toBeCloseTo(7.6, 12);
    expect(percentileSorted(s, 100)).toBe(10);
  });
  it('round6・ceil6', () => {
    expect(round6(0.1234566)).toBe(0.123457);
    expect(round6(0.1234565)).toBe(0.123456); // 2 進では 0.12345649… なので、Python の round と同じく切り捨て
    expect(round6(-0.0000004)).toBe(-0);
    expect(ceil6(0.1234561)).toBe(0.123457);
  });
});

// 事前計算の座標から計算すると、manifest の値（scripts/precompute/add_structure.py の出力）と一致する
for (const dir of ['data/mnist', 'data/word2vec-10k']) {
  describe(`事前計算との一致（${dir}）`, async () => {
    const arrays = await loadDatasetArrays(`${dir}/`, publicFetch);
    const m = arrays.manifest;
    const p = arrays.positions;

    it('bounds', () => {
      expect(computeBoundsSphere(p)).toEqual(m.bounds);
    });
    it('density（空間索引の 8 近傍）', () => {
      const d = computeDensity(p);
      expect(d.k).toBe(m.density!.k);
      expect(d.knnDistP05).toBeCloseTo(m.density!.knnDistP05, 6);
      expect(d.knnDistP50).toBeCloseTo(m.density!.knnDistP50, 6);
      expect(d.knnDistP95).toBeCloseTo(m.density!.knnDistP95, 6);
    });
    it('overview（主成分軸と符号）', () => {
      const o = computeOverview(p);
      for (let a = 0; a < 3; a++) for (let c = 0; c < 3; c++) {
        expect(Math.abs(o.axes[a]![c]! - m.overview!.axes[a]![c]!)).toBeLessThanOrEqual(1.5e-6);
      }
    });
  });
}

describe('labelGroups（MNIST のラベルごとのまとまり）', async () => {
  const arrays = await loadDatasetArrays('data/mnist/', publicFetch);
  const p = arrays.positions;
  const labels = arrays.labels!;
  const names = arrays.manifest.labels!.names;
  const g = labelGroups(p, labels, names);
  const clusters = g.clusters.levels[0]!.clusters;

  it('ラベルごとに 1 つ、点数・名前・ラベルが合う', () => {
    expect(clusters.length).toBe(10);
    expect(g.clusters.noise).toBe(LABEL_GROUP_NOISE);
    for (const c of clusters) {
      expect(c.name).toBe(names[c.majorityLabel!]);
      expect(c.purity).toBe(1);
      expect(c.parent).toBeNull();
      expect(c.size).toBe(labels.filter((l) => l === c.majorityLabel).length);
      expect(labels[c.medoid]).toBe(c.majorityLabel);
    }
    for (let i = 0; i < labels.length; i++) expect(clusters[g.ids[i]!]!.majorityLabel).toBe(labels[i]);
  });

  it('代表点は medoid、半径は 90 パーセンタイル、bbox は全点を含む', () => {
    const c = clusters[3]!;
    const members = [...labels.keys()].filter((i) => labels[i] === c.majorityLabel);
    expect(c.medoid).toBe(medoidOf(p, members));
    // 総当たりの検算（近傍の 10 点だけで、medoid の距離の合計が最小）
    const sumFrom = (i: number) => members.reduce((s, j) => s + Math.hypot(p[3 * i]! - p[3 * j]!, p[3 * i + 1]! - p[3 * j + 1]!, p[3 * i + 2]! - p[3 * j + 2]!), 0);
    const best = sumFrom(c.medoid);
    for (const j of members.slice(0, 50)) expect(sumFrom(j)).toBeGreaterThanOrEqual(best);
    const d = members.map((i) => Math.hypot(p[3 * i]! - c.center[0], p[3 * i + 1]! - c.center[1], p[3 * i + 2]! - c.center[2]));
    const inside = d.filter((x) => x <= c.radius).length / d.length;
    expect(inside).toBeGreaterThanOrEqual(0.9);
    expect(inside).toBeLessThan(0.92);
    for (const i of members) for (let a = 0; a < 3; a++) {
      expect(p[3 * i + a]!).toBeGreaterThanOrEqual(c.bbox[0][a]);
      expect(p[3 * i + a]!).toBeLessThanOrEqual(c.bbox[1][a]);
    }
  });

  it('事前計算の HDBSCAN のクラスタと、中心がおおむね同じ位置', () => {
    const hdb = arrays.manifest.clusters!.levels[0]!.clusters;
    for (const c of clusters) {
      const h = hdb.find((x) => x.majorityLabel === c.majorityLabel && x.name === c.name)!;
      expect(Math.hypot(h.center[0] - c.center[0], h.center[1] - c.center[1], h.center[2] - c.center[2])).toBeLessThan(0.25);
    }
  });
});

describe('buildEmbeddingData', async () => {
  const mnist = await loadDatasetArrays('data/mnist/', publicFetch);
  const w2v = await loadDatasetArrays('data/word2vec-10k/', publicFetch);
  const params = { nNeighbors: 15, minDist: 0.1, seed: 42 };

  it('ラベルのあるデータセット: ラベルのまとまりをクラスタにし、色はラベルのまま', () => {
    const e = buildEmbeddingData(mnist, mnist.positions, params);
    expect(e.coloring).toBeNull();
    expect(e.arrays.manifest.clusters!.levels.length).toBe(1);
    expect(e.arrays.clusterAssignments![0]!.ids.length).toBe(10000);
    expect(e.arrays.manifest.bounds).toEqual(mnist.manifest.bounds);
    expect(e.arrays.bounds.min).toEqual(mnist.bounds.min);
    expect(e.arrays.manifest.umap!.nNeighbors).toBe(15);
    expect(e.arrays.manifest.umap!.randomState).toBe(42);
    expect('quality' in e.arrays.manifest).toBe(false);
    expect(e.arrays.labels).toBe(mnist.labels);
    // 元のデータは書き換えない
    expect(mnist.manifest.clusters!.method).toBe('hdbscan');
  });

  it('ラベルのないデータセット: クラスタなし、色は事前計算のクラスタの色を引き継ぐ', () => {
    const e = buildEmbeddingData(w2v, w2v.positions, params);
    expect(e.arrays.manifest.clusters).toBeUndefined();
    expect(e.arrays.clusterAssignments).toBeUndefined();
    expect(e.coloring!.source).toBe('cluster');
    expect([...e.coloring!.indices]).toEqual([...precomputedColoring(w2v).indices]);
    expect(e.arrays.text).toBe(w2v.text);
  });

  it('構造（空間索引を含む）を渡すと、それを使い、座標からの計算をしない', () => {
    const structure = computeStructure(mnist.positions, mnist.labels!, mnist.manifest.labels!.names);
    const e = buildEmbeddingData(mnist, mnist.positions, params, structure);
    expect(e.spatialIndex).toBe(structure.index);
    expect(e.arrays.manifest.density).toBe(structure.density);
    expect(e.arrays.manifest.clusters).toBe(structure.groups!.clusters);
    expect(buildEmbeddingData(mnist, mnist.positions, params).arrays.manifest.density).toEqual(structure.density);
  });

  it('長さの合わない座標は受け付けない', () => {
    expect(() => buildEmbeddingData(mnist, new Float32Array(9), params)).toThrow(RangeError);
  });
});

/** ガウス分布の塊（種で決まる）。点 i の座標は [3i..3i+2]。 */
function gaussianCloud(n: number, seed: number, scale = 1): Float32Array {
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const g = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
  const p = new Float32Array(3 * n);
  for (let i = 0; i < p.length; i++) p[i] = g() * scale;
  return p;
}

/** 総当たりで、全点への距離の合計を返す */
function distanceSum(p: Float32Array, i: number, n: number): number {
  let s = 0;
  for (let j = 0; j < n; j++) s += Math.hypot(p[3 * i]! - p[3 * j]!, p[3 * i + 1]! - p[3 * j + 1]!, p[3 * i + 2]! - p[3 * j + 2]!);
  return s;
}

describe('medoidOf（点数の多いまとまりでは近似）', () => {
  const all = (n: number) => Int32Array.from({ length: n }, (_, i) => i);

  it('上限以下の点数では厳密（総当たりの最小）で、近似の経路を通らない', () => {
    const n = MEDOID_EXACT_MAX;
    const p = gaussianCloud(n, 7);
    const m = medoidOf(p, all(n));
    let best = Infinity, bestI = -1;
    for (let i = 0; i < n; i++) { const s = distanceSum(p, i, n); if (s < best) { best = s; bestI = i; } }
    expect(m).toBe(bestI);
  });

  it('上限を超えると近似する: 結果は決まっていて（同じ入力で同じ）、候補は点集合の中の点で、距離の合計は厳密な最小に近い', () => {
    const n = 6000;
    const p = gaussianCloud(n, 11);
    const members = all(n);
    const a = medoidOf(p, members);
    const b = medoidOf(p, members);
    expect(b).toBe(a);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(n);
    let best = Infinity;
    for (let i = 0; i < n; i++) best = Math.min(best, distanceSum(p, i, n));
    expect(distanceSum(p, a, n) / best).toBeLessThan(1.02);
  });

  it('部分集合（番号が飛ぶ）でも、結果は部分集合の点で、入力の配列を変えない', () => {
    const n = 9000;
    const p = gaussianCloud(n, 3);
    const members = Int32Array.from({ length: 4000 }, (_, i) => i * 2);
    const copy = Int32Array.from(members);
    const m = medoidOf(p, members);
    expect(m % 2).toBe(0);
    expect(Array.from(members)).toEqual(Array.from(copy));
    expect(medoidOf(p, members)).toBe(m);
  });

  it('計算量に上限がある（距離の計算が 候補数 × 相手の数 を超えない）', () => {
    // 点数に関わらず、距離の計算回数は MEDOID_CANDIDATES × MEDOID_REFERENCES 以下。時間は環境で変わるので、
    // 座標の配列の読み出し回数を数えて確かめる（厳密に総当たりすると 2 万点で 4 億回の距離の計算になる）
    const n = 20000;
    const base = gaussianCloud(n, 5);
    let reads = 0;
    const counted = new Proxy(base, {
      get(t, k, r) { if (typeof k === 'string' && /^\d+$/.test(k)) reads++; return Reflect.get(t, k, r); },
    }) as unknown as Float32Array;
    medoidOf(counted, all(n));
    // 距離 1 回につき座標を 3 回（相手）読む。候補側の読み出し（候補ごとに 3 回）と合わせても、この上限に収まる
    expect(reads).toBeLessThanOrEqual(3 * MEDOID_CANDIDATES * MEDOID_REFERENCES + 3 * MEDOID_CANDIDATES);
  });

  it('labelGroups: 点数の多いラベルでも medoid と半径が決まる', () => {
    const n = 5000;
    const p = gaussianCloud(n, 9);
    const labels = new Uint8Array(n);
    for (let i = 0; i < n; i++) labels[i] = i < 3000 ? 0 : 1;
    const g1 = labelGroups(p, labels, ['a', 'b']);
    const g2 = labelGroups(p, labels, ['a', 'b']);
    expect(g2).toEqual(g1);
    expect(g1.clusters.levels[0]!.clusters[0]!.size).toBe(3000); // 上限を超えるまとまり（近似）
    expect(g1.clusters.levels[0]!.clusters[1]!.size).toBe(2000); // 上限以下のまとまり（厳密）
  });
});

describe('computeStructure（Worker で呼ぶ、構造と空間索引を 1 回の構築でまとめて作る）', async () => {
  const mnist = await loadDatasetArrays('data/mnist/', publicFetch);

  it('個別の計算と同じ値になる（MNIST 1 万点）', () => {
    const p = mnist.positions;
    const names = mnist.manifest.labels!.names;
    const r = computeStructure(p, mnist.labels!, names);
    expect(r.bounds).toEqual(computeBoundsSphere(p));
    expect(r.density).toEqual(computeDensity(p));
    expect(r.overview).toEqual(computeOverview(p));
    expect(r.groups).toEqual(labelGroups(p, mnist.labels!, names));
    expect(r.index).toBeInstanceOf(SpatialIndex);
    expect(r.index.count).toBe(10000);
  });

  it('ラベルがなければ、まとまりは作らない', () => {
    const r = computeStructure(gaussianCloud(100, 1), null, null);
    expect(r.groups).toBeNull();
  });

  it('密度に使った空間索引は、表示側の索引として、構築し直した索引と同じ検索結果を返す', () => {
    const p = mnist.positions;
    const r = computeStructure(p, null, null);
    const fresh = new SpatialIndex(p);
    for (const i of [0, 17, 4999, 9999]) {
      const x = p[3 * i]!, y = p[3 * i + 1]!, z = p[3 * i + 2]!;
      expect(Array.from(r.index.kNearest(x, y, z, 12).indices)).toEqual(Array.from(fresh.kNearest(x, y, z, 12).indices));
    }
  });
});
