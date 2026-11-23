import { describe, expect, it } from 'vitest';
import { MAX_PICKABLE, decodePickId, encodePickId, selectNearest, type PickRegion } from './pickId';

describe('encodePickId / decodePickId', () => {
  it('往復で元の番号に戻る', () => {
    for (const i of [0, 1, 254, 255, 256, 9999, 65535, 65536, 123456, MAX_PICKABLE - 1]) {
      const [r, g, b, a] = encodePickId(i);
      expect(a).toBe(255);
      for (const v of [r, g, b]) expect(v).toBeGreaterThanOrEqual(0), expect(v).toBeLessThanOrEqual(255);
      expect(decodePickId(r, g, b)).toBe(i);
    }
  });
  it('0 は点なし', () => {
    expect(decodePickId(0, 0, 0)).toBe(-1);
  });
  it('R が下位8ビット', () => {
    expect(encodePickId(0)).toEqual([1, 0, 0, 255]);
    expect(encodePickId(255)).toEqual([0, 1, 0, 255]);
    expect(encodePickId(65535)).toEqual([0, 0, 1, 255]);
  });
  it('範囲外は例外', () => {
    expect(() => encodePickId(-1)).toThrow(RangeError);
    expect(() => encodePickId(MAX_PICKABLE)).toThrow(RangeError);
    expect(() => encodePickId(1.5)).toThrow(RangeError);
  });
});

/** 上の行から並べた番号の格子（-1 は点なし）から領域を作る。 */
function region(rows: number[][], x0 = 0, y0 = 0, bufferWidth = 1000, bufferHeight = 1000): PickRegion {
  const size = rows.length;
  const pixels = new Uint8Array(4 * size * size);
  rows.forEach((row, j) => row.forEach((index, i) => {
    if (index >= 0) pixels.set(encodePickId(index), 4 * ((size - 1 - j) * size + i));
  }));
  return { pixels, size, x0, y0, bufferWidth, bufferHeight };
}

describe('selectNearest', () => {
  it('真下の点を返す', () => {
    const r = region([[1, 1, 1], [1, 7, 1], [1, 1, 1]]);
    expect(selectNearest(r, 1)).toEqual({ index: 7, distance: 0 });
  });
  it('真下になければ最も近い点へ吸着する', () => {
    const r = region([
      [-1, -1, -1, -1, 3],
      [-1, -1, -1, -1, -1],
      [-1, -1, -1, 5, -1],
      [-1, -1, -1, -1, -1],
      [-1, -1, -1, -1, -1],
    ]);
    expect(selectNearest(r, 2)).toEqual({ index: 5, distance: 1 });
  });
  it('半径の外は選ばない', () => {
    const r = region([
      [4, -1, -1, -1, -1],
      [-1, -1, -1, -1, -1],
      [-1, -1, -1, -1, -1],
      [-1, -1, -1, -1, -1],
      [-1, -1, -1, -1, -1],
    ]);
    // 角は距離 2√2 > 2
    expect(selectNearest(r, 2)).toBeNull();
    expect(selectNearest(r, 3)).toEqual({ index: 4, distance: Math.SQRT2 * 2 });
  });
  it('同じ距離なら上の行・左の列を優先する', () => {
    const r = region([[-1, 8, -1], [2, -1, 6], [-1, 9, -1]]);
    expect(selectNearest(r, 1)?.index).toBe(8);
  });
  it('描画バッファの外の画素は選ばない', () => {
    // 領域の左上が (-1, -1)：上の行と左の列は画面外
    const r = region([[3, 3, 3], [3, -1, -1], [3, -1, -1]], -1, -1);
    expect(selectNearest(r, 1.5)).toBeNull();
  });
  it('点がなければ null', () => {
    expect(selectNearest(region([[-1, -1, -1], [-1, -1, -1], [-1, -1, -1]]), 1)).toBeNull();
  });
});
