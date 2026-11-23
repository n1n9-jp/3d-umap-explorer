import { describe, expect, it } from 'vitest';
import { fogForCamera } from './fog';

const interior: [number, number, number] = [0.15, 0.9, 0.75];
const radius = 1;

describe('fogForCamera', () => {
  it('点群の内部では interior の値そのまま', () => {
    expect(fogForCamera(0.5, 1.2, interior)).toEqual(interior);
  });
  it('外では点群の表面までの距離だけ霧の開始が遠ざかる', () => {
    const [start, range, max] = fogForCamera(3, 1, interior);
    expect(start).toBeCloseTo(2.15);
    expect(range).toBeCloseTo(radius);
    expect(max).toBe(0.75);
  });
});
