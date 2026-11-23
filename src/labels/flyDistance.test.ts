import { describe, expect, it } from 'vitest';
import { clusterViewDistance, FLY_MARGIN } from './flyDistance';

describe('clusterViewDistance', () => {
  it('横長の画面では縦の視野が決める: D = margin × r / sin(30°)（縦 60°）', () => {
    expect(clusterViewDistance(0.2, 60, 1.6)).toBeCloseTo((FLY_MARGIN * 0.2) / Math.sin(Math.PI / 6), 12);
  });
  it('縦長の画面では横の視野が決める（遠くなる）', () => {
    const wide = clusterViewDistance(0.2, 60, 1.6);
    const tall = clusterViewDistance(0.2, 60, 0.5);
    expect(tall).toBeGreaterThan(wide);
    const halfH = Math.atan(Math.tan(Math.PI / 6) * 0.5);
    expect(tall).toBeCloseTo((FLY_MARGIN * 0.2) / Math.sin(halfH), 12);
  });
  it('その距離で、半径 r の球が視野（縦横とも）に収まる', () => {
    for (const aspect of [0.5, 1, 1.6, 2.4]) {
      const r = 0.3;
      const d = clusterViewDistance(r, 60, aspect, 1);
      const angular = Math.asin(r / d);
      const v = Math.PI / 6;
      const h = Math.atan(Math.tan(v) * aspect);
      expect(angular).toBeLessThanOrEqual(Math.min(v, h) + 1e-12);
    }
  });
  it('半径に比例する', () => {
    expect(clusterViewDistance(0.4, 60, 1.6)).toBeCloseTo(2 * clusterViewDistance(0.2, 60, 1.6), 12);
  });
});
