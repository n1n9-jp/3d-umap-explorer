/**
 * 同梱した embedding-atlas の UMAP（src/compute/vendor/embedding-atlas/）が、実際に計算できることを確かめる。
 * 版を更新して入口や引数が変わったときに、ここで気づけるようにする。
 */
import { describe, expect, it } from 'vitest';
import { createUMAPFromKNN } from './vendor/embedding-atlas/umap.js';
import { knnInput, runUmap } from './umapRun';

/** 乱数（mulberry32） */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 3 つの塊（8 次元）の点と、自分自身を含まない厳密な k 近傍グラフ。 */
function blobs(count: number, k: number) {
  const r = rng(7);
  const dim = 8;
  const x = new Float64Array(count * dim);
  const group = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const g = i % 3;
    group[i] = g;
    for (let d = 0; d < dim; d++) x[i * dim + d] = (d === g ? 10 : 0) + (r() - 0.5);
  }
  const indices = new Uint16Array(count * k);
  const distances = new Float32Array(count * k);
  for (let i = 0; i < count; i++) {
    const cand: [number, number][] = [];
    for (let j = 0; j < count; j++) {
      if (j === i) continue;
      let s = 0;
      for (let d = 0; d < dim; d++) s += (x[i * dim + d]! - x[j * dim + d]!) ** 2;
      cand.push([Math.fround(Math.sqrt(s)), j]);
    }
    cand.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (let j = 0; j < k; j++) { indices[i * k + j] = cand[j]![1]; distances[i * k + j] = cand[j]![0]; }
  }
  return { indices, distances, group };
}

const sameBits = (a: Float32Array, b: Float32Array) => {
  const x = new Uint32Array(a.buffer, a.byteOffset, a.length), y = new Uint32Array(b.buffer, b.byteOffset, b.length);
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

describe('knnInput', () => {
  it('列 0 に自分自身（距離 0）を置き、続けて近い順に n−1 個を並べる', () => {
    const indices = new Uint16Array([1, 2, 3, 0, 2, 3, 0, 1, 3, 0, 1, 2]);
    const distances = new Float32Array([1, 2, 3, 1, 4, 5, 2, 4, 6, 3, 5, 6]);
    const { idx, dist } = knnInput(indices, distances, 4, 3, 3);
    expect([...idx]).toEqual([0, 1, 2, 1, 0, 2, 2, 0, 1, 3, 0, 1]);
    expect([...dist]).toEqual([0, 1, 2, 0, 1, 4, 0, 2, 4, 0, 3, 5]);
  });

  it('列数を超える近傍数は受け付けない', () => {
    expect(() => knnInput(new Uint16Array(4), new Float32Array(4), 2, 2, 4)).toThrow(RangeError);
    expect(() => knnInput(new Uint16Array(4), new Float32Array(4), 2, 2, 3)).not.toThrow();
  });
});

describe('embedding-atlas の UMAP（同梱）', () => {
  const count = 150, k = 15;
  const g = blobs(count, k);

  it('createUMAPFromKNN で 3 次元の座標が出る', async () => {
    const { idx, dist } = knnInput(g.indices, g.distances, count, k, 10);
    const umap = await createUMAPFromKNN(count, 3, idx, dist, { seed: 1, minDist: 0.1, nEpochs: 30 });
    await umap.run();
    const e = new Float32Array(umap.embedding);
    umap.destroy();
    expect(e.length).toBe(count * 3);
    expect(e.every(Number.isFinite)).toBe(true);
  });

  it('step と学習率の減衰で計算し、同じ種で一致し、種を変えると変わる。塊が分かれる', async () => {
    const { idx, dist } = knnInput(g.indices, g.distances, count, k, 10);
    const chunks: number[] = [];
    const run = (seed: number) => runUmap({
      count, idx, dist, params: { nNeighbors: 10, minDist: 0.1, seed }, nEpochs: 40, chunkEpochs: 10,
      onChunk: (epoch) => chunks.push(epoch),
    });
    const a = await run(3);
    const b = await run(3);
    const c = await run(4);
    expect(a.cancelled).toBe(false);
    expect(a.epochs).toBe(40);
    expect(chunks.slice(0, 4)).toEqual([10, 20, 30, 40]);
    expect(a.embedding!.every(Number.isFinite)).toBe(true);
    expect(sameBits(a.embedding!, b.embedding!)).toBe(true);
    expect(sameBits(a.embedding!, c.embedding!)).toBe(false);
    // 各点の最近傍（3 次元）が同じ塊に属する割合
    const e = a.embedding!;
    let same = 0;
    for (let i = 0; i < count; i++) {
      let best = -1, bd = Infinity;
      for (let j = 0; j < count; j++) {
        if (j === i) continue;
        const d = (e[3 * i]! - e[3 * j]!) ** 2 + (e[3 * i + 1]! - e[3 * j + 1]!) ** 2 + (e[3 * i + 2]! - e[3 * j + 2]!) ** 2;
        if (d < bd) { bd = d; best = j; }
      }
      if (g.group[best] === g.group[i]) same++;
    }
    expect(same / count).toBeGreaterThan(0.95);
  });

  it('shouldCancel で途中で止まり、座標を返さない', async () => {
    const { idx, dist } = knnInput(g.indices, g.distances, count, k, 10);
    let chunks = 0;
    const r = await runUmap({
      count, idx, dist, params: { nNeighbors: 10, minDist: 0.1, seed: 1 }, nEpochs: 100, chunkEpochs: 5,
      onChunk: () => { chunks++; }, shouldCancel: () => chunks >= 2,
    });
    expect(r.cancelled).toBe(true);
    expect(r.embedding).toBeNull();
    expect(r.epochs).toBe(10);
  });
});
