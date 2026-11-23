import { describe, expect, it } from 'vitest';
import { computeStopDistance } from './stopDistance';

// 既定の描画（pointSize 0.004、近接フェードの始まり 5 倍）、高さ 800、縦の視野 60°
const base = { pointSize: 0.004, nearFadeStartFactor: 5, pxPerUnitAtUnitDepth: 0.5 * 800 / Math.tan(Math.PI / 6), minPixels: 28 };

describe('computeStopDistance', () => {
  it('近傍の平均距離の 2.5 倍', () => {
    const r = computeStopDistance({ ...base, neighborDistances: [0.01, 0.015, 0.02] });
    expect(r.meanNeighborDistance).toBeCloseTo(0.015);
    expect(r.distance).toBeCloseTo(0.0375);
  });

  it('近接フェードの始まり × 1.5 より近づかない', () => {
    const r = computeStopDistance({ ...base, neighborDistances: [0.001, 0.002] });
    expect(r.minDistance).toBeCloseTo(0.03);
    expect(r.distance).toBeCloseTo(0.03);
  });

  it('点が minPixels 以上に見える距離より遠くへ離れない', () => {
    const r = computeStopDistance({ ...base, neighborDistances: [0.2, 0.3] });
    expect(r.maxDistance).toBeCloseTo(0.004 * base.pxPerUnitAtUnitDepth / 28);
    expect(r.distance).toBeCloseTo(r.maxDistance);
    // その距離で、画面上の大きさがちょうど minPixels
    expect(0.004 * base.pxPerUnitAtUnitDepth / r.distance).toBeCloseTo(28);
  });

  it('自分自身（距離 0）と有限でない値は数えない。近傍がなければ最大', () => {
    expect(computeStopDistance({ ...base, neighborDistances: [0, 0.01, NaN] }).meanNeighborDistance).toBeCloseTo(0.01);
    const r = computeStopDistance({ ...base, neighborDistances: [] });
    expect(r.meanNeighborDistance).toBeNull();
    expect(r.distance).toBeCloseTo(r.maxDistance);
  });

  it('最大が最小を下回るときは最小（消えないことを優先）', () => {
    const r = computeStopDistance({ ...base, pxPerUnitAtUnitDepth: 10, neighborDistances: [0.05] });
    expect(r.maxDistance).toBeLessThan(r.minDistance);
    expect(r.distance).toBe(r.minDistance);
  });

  it('倍率は変えられる', () => {
    const r = computeStopDistance({ ...base, neighborDistances: [0.02], spacingFactor: 2, fadeMargin: 1 });
    expect(r.distance).toBeCloseTo(0.04);
    expect(r.minDistance).toBeCloseTo(0.02);
  });
});
