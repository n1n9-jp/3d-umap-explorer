import { describe, expect, it } from 'vitest';
import { BACKGROUND_COLOR, LABEL_COLORS, hexToRgb } from './palette';
import {
  NOISE_COLOR, NOISE_COLOR_INDEX, UNIFORM_COLOR_INDEX, clusterColorIndex, colorIndexHex, colorIndexRgb, pointColoring,
} from './colorScheme';

const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (hex: string) => {
  const [r, g, b] = hexToRgb(hex).map(lin) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

describe('pointColoring', () => {
  it('ラベルがあればラベルの番号（クラスタがあっても）', () => {
    const c = pointColoring({ count: 3, labels: new Uint8Array([2, 0, 9]), coarse: { ids: new Uint16Array([1, 1, 1]), noise: 65535 } });
    expect(c.source).toBe('label');
    expect(Array.from(c.indices)).toEqual([2, 0, 9]);
  });

  it('ラベルがなければ粗い階層のクラスタの番号、クラスタなしの点は NOISE_COLOR_INDEX', () => {
    const c = pointColoring({ count: 4, coarse: { ids: new Uint16Array([0, 17, 65535, 3]), noise: 65535 } });
    expect(c.source).toBe('cluster');
    expect(Array.from(c.indices)).toEqual([0, 17, NOISE_COLOR_INDEX, 3]);
  });

  it('ラベルもクラスタもなければ全点が同じ色', () => {
    const c = pointColoring({ count: 2 });
    expect(c.source).toBe('uniform');
    expect(Array.from(c.indices)).toEqual([UNIFORM_COLOR_INDEX, UNIFORM_COLOR_INDEX]);
  });
});

describe('色の番号から色', () => {
  it('10 色を繰り返し、-1 は灰色', () => {
    expect(colorIndexHex(0)).toBe(LABEL_COLORS[0]);
    expect(colorIndexHex(13)).toBe(LABEL_COLORS[3]);
    expect(colorIndexHex(17)).toBe(LABEL_COLORS[7]);
    expect(colorIndexHex(NOISE_COLOR_INDEX)).toBe(NOISE_COLOR);
    expect(colorIndexRgb(NOISE_COLOR_INDEX)).toEqual(hexToRgb(NOISE_COLOR));
  });

  it('灰色はほぼ無彩色で、背景より明るく、パレットのどの色よりも目立たない（コントラスト比 3 以上、パレットの最小より低い）', () => {
    const [r, g, b] = hexToRgb(NOISE_COLOR);
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(0.07);
    const c = contrast(NOISE_COLOR, BACKGROUND_COLOR);
    expect(c).toBeGreaterThanOrEqual(3);
    const minPalette = Math.min(...LABEL_COLORS.map((h) => contrast(h, BACKGROUND_COLOR)));
    expect(c).toBeLessThan(minPalette);
  });
});

describe('clusterColorIndex', () => {
  it('ラベルで色分けするときは多数派ラベル、クラスタで色分けするときはクラスタの番号', () => {
    expect(clusterColorIndex({ id: 4, majorityLabel: 7 }, 'label')).toBe(7);
    expect(clusterColorIndex({ id: 4, majorityLabel: null }, 'label')).toBe(4);
    expect(clusterColorIndex({ id: 12, majorityLabel: null }, 'cluster')).toBe(12);
    expect(colorIndexHex(clusterColorIndex({ id: 12, majorityLabel: null }, 'cluster'))).toBe(LABEL_COLORS[2]);
  });
});
