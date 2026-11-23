import { describe, expect, it } from 'vitest';
import { alphaToSdf, edt2d } from './sdf';

describe('edt2d（二乗距離変換）', () => {
  it('0 の画素からの二乗ユークリッド距離になる', () => {
    const w = 7, h = 5;
    const g = new Float64Array(w * h).fill(1e20);
    g[2 * w + 3] = 0; // 中央
    edt2d(g, w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      expect(g[y * w + x]).toBe((x - 3) ** 2 + (y - 2) ** 2);
    }
  });
});

describe('alphaToSdf', () => {
  const radius = 8, cutoff = 0.25;
  // 20×20 の中央に 8×8 の四角（インク）
  const w = 20, h = 20;
  const alpha = new Uint8ClampedArray(w * h);
  for (let y = 6; y < 14; y++) for (let x = 6; x < 14; x++) alpha[y * w + x] = 255;
  const sdf = alphaToSdf(alpha, w, h, radius, cutoff);
  const at = (x: number, y: number) => sdf[y * w + x]!;
  const edge = 255 * (1 - cutoff);

  it('インクの内側は輪郭の値より大きく、外側は小さい', () => {
    expect(at(10, 10)).toBeGreaterThan(edge);
    expect(at(6, 10)).toBeGreaterThan(edge);
    expect(at(5, 10)).toBeLessThan(edge);
    expect(at(0, 10)).toBeLessThan(at(4, 10));
  });
  it('外側では、輪郭からの距離に比例して下がる（1 画素で 255 / radius）', () => {
    // 外側の画素の中心から最も近いインクの画素の中心までの距離 d（画素）: 255 - 255 * (d / radius + cutoff)
    expect(at(3, 10)).toBe(Math.round(255 - 255 * (3 / radius + cutoff)));
    expect(at(5, 10)).toBe(Math.round(255 - 255 * (1 / radius + cutoff)));
  });
  it('輪郭から radius × (1 − cutoff) 以上離れると 0', () => {
    const far = alphaToSdf(alpha, w, h, 4, cutoff);
    expect(far[0]).toBe(0);
  });
  it('アンチエイリアスの中間の値（0.5）は輪郭の上にある', () => {
    const a = new Uint8ClampedArray([0, 0, 128, 255, 255]);
    const s = alphaToSdf(a, 5, 1, radius, cutoff);
    expect(Math.abs(s[2]! - edge)).toBeLessThanOrEqual(1);
  });
});
