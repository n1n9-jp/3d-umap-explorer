import { describe, expect, it } from 'vitest';
import { loadDatasetArrays } from '../data/loader';
import { buildEmbeddingData, precomputedColoring } from './embedding';
import {
  LABEL_GROUP_NOISE, ceil6, computeBoundsSphere, computeDensity, computeOverview, labelGroups, medoidOf, percentileSorted, round6,
} from './structure';
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

  it('長さの合わない座標は受け付けない', () => {
    expect(() => buildEmbeddingData(mnist, new Float32Array(9), params)).toThrow(RangeError);
  });
});
