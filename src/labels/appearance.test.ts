import { describe, expect, it } from 'vitest';
import { appearanceParamsForBounds, INSIDE_OPACITY, INSIDE_SCALE, insideAppearance, labelAppearance } from './appearance';

const P = { near: 1, far: 3 };

describe('labelAppearance', () => {
  it('near 以下は最大の大きさと濃さ', () => {
    expect(labelAppearance(0, P)).toEqual({ t: 0, scale: 1, opacity: 1 });
    expect(labelAppearance(1, P)).toEqual({ t: 0, scale: 1, opacity: 1 });
  });
  it('far 以上は最小の大きさと濃さ（既定 0.75 倍・0.6）', () => {
    const a = labelAppearance(3, P);
    expect(a.t).toBe(1);
    expect(a.scale).toBeCloseTo(0.75, 12);
    expect(a.opacity).toBeCloseTo(0.6, 12);
    expect(labelAppearance(100, P)).toEqual(a);
  });
  it('間は線形で、遠いほど小さく薄い', () => {
    const mid = labelAppearance(2, P);
    expect(mid.t).toBeCloseTo(0.5, 12);
    expect(mid.scale).toBeCloseTo(0.875, 12);
    expect(mid.opacity).toBeCloseTo(0.8, 12);
    let prev = labelAppearance(1, P);
    for (let d = 1.1; d <= 3; d += 0.1) {
      const cur = labelAppearance(d, P);
      expect(cur.scale).toBeLessThanOrEqual(prev.scale);
      expect(cur.opacity).toBeLessThanOrEqual(prev.opacity);
      prev = cur;
    }
  });
  it('最小値は指定できる', () => {
    const a = labelAppearance(5, { ...P, minScale: 0.5, minOpacity: 0.2 });
    expect(a.scale).toBeCloseTo(0.5, 12);
    expect(a.opacity).toBeCloseTo(0.2, 12);
  });
  it('far ≤ near や NaN でも壊れない', () => {
    expect(labelAppearance(2, { near: 2, far: 2 }).t).toBe(0);
    expect(labelAppearance(3, { near: 2, far: 2 }).t).toBe(1);
    expect(labelAppearance(NaN, P).t).toBe(1);
  });
  it('点群の半径から基準距離を決める（0.6 R と 3 R）', () => {
    expect(appearanceParamsForBounds(2)).toEqual({ near: 1.2, far: 6 });
  });
});

describe('insideAppearance（内部にいるときのほかのクラスタの目印）', () => {
  it('小さく薄くする（距離に対する単調さは保つ）', () => {
    const p = { near: 1, far: 3 };
    const a = labelAppearance(1.5, p), b = labelAppearance(2.5, p);
    const ia = insideAppearance(a), ib = insideAppearance(b);
    expect(ia.scale).toBeCloseTo(a.scale * INSIDE_SCALE, 9);
    expect(ia.opacity).toBeCloseTo(a.opacity * INSIDE_OPACITY, 9);
    expect(ia.scale).toBeLessThan(a.scale);
    expect(ia.opacity).toBeLessThan(a.opacity);
    expect(ia.scale).toBeGreaterThan(ib.scale);
  });
});
