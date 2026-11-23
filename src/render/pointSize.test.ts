import { describe, expect, it } from 'vitest';
import mnistRaw from '../../public/data/mnist/manifest.json?raw';
import word2vecRaw from '../../public/data/word2vec-10k/manifest.json?raw';
import { POINT_SIZE_RANGE, REFERENCE_POINT_SIZE, defaultPointSize } from './pointSize';

describe('defaultPointSize', () => {
  it('MNIST では従来の 0.004 のまま', () => {
    expect(defaultPointSize(JSON.parse(mnistRaw).density)).toBe(0.004);
  });

  it('word2vec では点の間隔に比例して大きくなる（有効数字 3 桁）', () => {
    const density = JSON.parse(word2vecRaw).density;
    const s = defaultPointSize(density);
    expect(s).toBe(0.00967);
    // 丸い点の直径（ビルボードの 1 辺）は、最近傍点間距離の中央値（0.0187）の 4〜7 割
    expect(s / 0.0187).toBeGreaterThan(0.4);
    expect(s / 0.0187).toBeLessThan(0.7);
  });

  it('density がない・不正なら基準の値、極端な値は範囲に収める', () => {
    expect(defaultPointSize(undefined)).toBe(REFERENCE_POINT_SIZE);
    expect(defaultPointSize({ knnDistP50: 0 })).toBe(REFERENCE_POINT_SIZE);
    expect(defaultPointSize({ knnDistP50: Number.NaN })).toBe(REFERENCE_POINT_SIZE);
    expect(defaultPointSize({ knnDistP50: 100 })).toBe(POINT_SIZE_RANGE[1]);
    expect(defaultPointSize({ knnDistP50: 1e-6 })).toBe(POINT_SIZE_RANGE[0]);
  });
});
