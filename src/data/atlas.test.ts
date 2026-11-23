import { describe, expect, it } from 'vitest';
import { atlasLayout, cellOrigin, cellOrigins, inkIsDark } from './atlas';

const sprite = { cellSize: [28, 28] as [number, number], columns: 100, rows: 100 };

describe('atlasLayout', () => {
  it('2800x2800 のアトラスでは 1セルが 0.01', () => {
    const l = atlasLayout(sprite, 2800, 2800);
    expect(l.cellU).toBeCloseTo(0.01);
    expect(l.cellV).toBeCloseTo(0.01);
  });

  it('余白のあるアトラスでは画像の実寸からセル幅を求める', () => {
    const l = atlasLayout(sprite, 4096, 4096);
    expect(l.cellU).toBeCloseTo(28 / 4096);
  });

  it('セルが収まらない画像を拒否する', () => {
    expect(() => atlasLayout(sprite, 2799, 2800)).toThrow();
  });
});

describe('cellOrigin', () => {
  const l = atlasLayout(sprite, 2800, 2800);

  it('点 0 は左上', () => {
    expect(cellOrigin(0, l)).toEqual([0, 0]);
  });

  it('点 i は列 i % columns、行 floor(i / columns)（v は下向き）', () => {
    const [u, v] = cellOrigin(101, l);
    expect(u).toBeCloseTo(0.01);
    expect(v).toBeCloseTo(0.01);
    const [u2, v2] = cellOrigin(9999, l);
    expect(u2).toBeCloseTo(0.99);
    expect(v2).toBeCloseTo(0.99);
  });

  it('cellOrigins は cellOrigin と一致する', () => {
    const all = cellOrigins(10000, l);
    for (const i of [0, 1, 99, 100, 5432, 9999]) {
      const [u, v] = cellOrigin(i, l);
      expect(all[i * 2]).toBeCloseTo(u);
      expect(all[i * 2 + 1]).toBeCloseTo(v);
    }
  });
});

describe('inkIsDark', () => {
  it('白地なら黒インク、黒地なら白インク', () => {
    expect(inkIsDark(0.98)).toBe(true);
    expect(inkIsDark(0.02)).toBe(false);
  });
});
