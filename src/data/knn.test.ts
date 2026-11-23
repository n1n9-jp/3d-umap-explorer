import { describe, expect, it } from 'vitest';
import { loadKnnGraph, validateKnnGraph, type KnnGraph } from './knn';
import { parseManifest } from './manifest';
import { publicFetch, readManifest } from '../compute/testData';

const baseManifest = {
  name: 't', count: 4, positions: { file: 'positions.f32', dtype: 'float32', components: 3 },
  knn: { k: 2, metric: 'euclidean', includesSelf: false, exact: true,
    indices: { file: 'i.u16', dtype: 'uint16' }, distances: { file: 'd.f32', dtype: 'float32' } },
};

describe('manifest の knn', () => {
  it('検証して読む', () => {
    const m = parseManifest(baseManifest);
    expect(m.knn).toEqual(baseManifest.knn);
  });
  it('不正な値は ManifestError', () => {
    const bad = (patch: Record<string, unknown>) => parseManifest({ ...baseManifest, knn: { ...baseManifest.knn, ...patch } });
    expect(() => bad({ k: 4 })).toThrow(/knn.k/);
    expect(() => bad({ metric: 'manhattan' })).toThrow(/knn.metric/);
    expect(() => bad({ includesSelf: true })).toThrow(/includesSelf/);
    expect(() => bad({ indices: { file: 'i', dtype: 'int8' } })).toThrow(/knn.indices.dtype/);
    expect(() => bad({ distances: { file: 'd', dtype: 'float64' } })).toThrow(/knn.distances.dtype/);
  });
  it('knn がなければ undefined', () => {
    const { knn: _knn, ...rest } = baseManifest;
    expect(parseManifest(rest).knn).toBeUndefined();
  });
});

describe('validateKnnGraph', () => {
  const g = (indices: number[], distances: number[]): KnnGraph =>
    ({ count: 3, k: 2, metric: 'euclidean', indices: new Uint16Array(indices), distances: new Float32Array(distances) });
  it('正しいグラフを通す', () => {
    expect(() => validateKnnGraph(g([1, 2, 0, 2, 0, 1], [1, 2, 1, 3, 2, 3]))).not.toThrow();
  });
  it('範囲外・自分自身・並び・非有限の距離を拒む', () => {
    expect(() => validateKnnGraph(g([1, 3, 0, 2, 0, 1], [1, 2, 1, 3, 2, 3]))).toThrow(/範囲外/);
    expect(() => validateKnnGraph(g([0, 2, 0, 2, 0, 1], [1, 2, 1, 3, 2, 3]))).toThrow(/自分自身/);
    expect(() => validateKnnGraph(g([1, 2, 0, 2, 0, 1], [2, 1, 1, 3, 2, 3]))).toThrow(/近い順/);
    expect(() => validateKnnGraph(g([1, 2, 0, 2, 0, 1], [1, NaN, 1, 3, 2, 3]))).toThrow(/有限/);
    expect(() => validateKnnGraph(g([1, 2, 0, 2, 0], [1, 2, 1, 3, 2]))).toThrow(/長さ/);
  });
});

describe('loadKnnGraph（配信しているデータ）', () => {
  for (const dir of ['data/mnist', 'data/word2vec-10k']) {
    it(`${dir} の kNN グラフを読んで検証できる`, async () => {
      const m = await readManifest(dir);
      const graph = await loadKnnGraph(`${dir}/`, m, publicFetch);
      expect(graph.count).toBe(10000);
      expect(graph.k).toBe(50);
      expect(graph.indices).toBeInstanceOf(Uint16Array);
      expect(graph.distances.length).toBe(500000);
    });
  }
  it('knn のないデータセットではエラー', async () => {
    const m = parseManifest({ ...baseManifest, knn: undefined });
    await expect(loadKnnGraph('x/', m, publicFetch)).rejects.toThrow(/kNN グラフ/);
  });
});
