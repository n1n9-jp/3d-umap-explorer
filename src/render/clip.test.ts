import { describe, expect, it } from 'vitest';
import { MIN_NEAR, clipPlanesForCamera } from './clip';

describe('clipPlanesForCamera', () => {
  it('点群の内部では近接面は MIN_NEAR、遠方面は球の奥の表面より遠い', () => {
    const { near, far } = clipPlanesForCamera(0.3, 1.14);
    expect(near).toBe(MIN_NEAR);
    expect(far).toBeGreaterThan(0.3 + 1.14);
  });
  it('外にいるときは近接面を球の手前の表面の半分まで遠ざける', () => {
    const { near, far } = clipPlanesForCamera(2.6, 1.14);
    expect(near).toBeCloseTo(0.73);
    expect(near).toBeLessThan(2.6 - 1.14);
    expect(far).toBeGreaterThan(2.6 + 1.14);
  });
  it('遠方面はデータの半径に合わせて伸びる（半径 10 のデータでも全体が描画範囲に入る）', () => {
    const r = 10, d = r / Math.sin(Math.PI / 6); // 縦の視野角 60° で全体が収まる距離
    const { near, far } = clipPlanesForCamera(d, r);
    expect(far).toBeGreaterThan(d + r);
    expect(near).toBeLessThan(d - r);
  });
  it('近接面は位置に対して連続に変わる', () => {
    const a = clipPlanesForCamera(1.14 + 0.001, 1.14).near;
    const b = clipPlanesForCamera(1.14 + 0.002, 1.14).near;
    expect(Math.abs(a - b)).toBeLessThan(0.001);
  });
  it('不正な値でも有限の値を返す', () => {
    const { near, far } = clipPlanesForCamera(Number.NaN, 0);
    expect(Number.isFinite(near) && Number.isFinite(far) && far > near).toBe(true);
  });
});
