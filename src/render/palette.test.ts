import { describe, expect, it } from 'vitest';
import { LABEL_COLORS, hexToRgb, labelColors } from './palette';

describe('palette', () => {
  it('hexToRgb は 0..1 の値を返す', () => {
    expect(hexToRgb('#ff8000')).toEqual([1, 128 / 255, 0]);
    expect(() => hexToRgb('red')).toThrow();
  });
  it('10色はすべて異なり、暗い背景で見えるだけの明るさがある', () => {
    expect(new Set(LABEL_COLORS).size).toBe(10);
    for (const c of LABEL_COLORS) {
      const [r, g, b] = hexToRgb(c);
      expect(0.299 * r + 0.587 * g + 0.114 * b).toBeGreaterThan(0.4);
    }
  });
  it('10色を超える分は繰り返す', () => {
    expect(labelColors(12)[10]).toEqual(labelColors(1)[0]);
  });
});
