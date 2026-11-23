import { describe, expect, it } from 'vitest';
import { rectsOverlap, resolveOverlaps, type OverlapItem } from './overlap';

const item = (id: number, x: number, y: number, distance: number, width = 40, height = 20): OverlapItem => ({ id, x, y, width, height, distance });

describe('rectsOverlap', () => {
  it('重なる・離れる・接する', () => {
    expect(rectsOverlap(item(0, 0, 0, 1), item(1, 30, 0, 1))).toBe(true);
    expect(rectsOverlap(item(0, 0, 0, 1), item(1, 41, 0, 1))).toBe(false);
    expect(rectsOverlap(item(0, 0, 0, 1), item(1, 40, 0, 1))).toBe(false); // 接するだけ
    expect(rectsOverlap(item(0, 0, 0, 1), item(1, 0, 19, 1))).toBe(true);
  });
  it('gap を含めて判定する', () => {
    expect(rectsOverlap(item(0, 0, 0, 1), item(1, 42, 0, 1), 4)).toBe(true);
    expect(rectsOverlap(item(0, 0, 0, 1), item(1, 45, 0, 1), 4)).toBe(false);
  });
  it('x が離れていても y だけ重なる場合は重ならない', () => {
    expect(rectsOverlap(item(0, 0, 0, 1), item(1, 100, 5, 1))).toBe(false);
  });
});

describe('resolveOverlaps', () => {
  it('重なるときは近いほうを残し、遠いほうを隠す', () => {
    const kept = resolveOverlaps([item(0, 0, 0, 3), item(1, 10, 5, 1)], 0);
    expect([...kept]).toEqual([1]);
  });
  it('入力の順に依らない', () => {
    const a = [item(0, 0, 0, 3), item(1, 10, 5, 1)];
    expect(resolveOverlaps([...a].reverse(), 0)).toEqual(resolveOverlaps(a, 0));
  });
  it('重ならないものはすべて残す', () => {
    const kept = resolveOverlaps([item(0, 0, 0, 1), item(1, 100, 0, 2), item(2, 0, 100, 3)], 4);
    expect([...kept].sort()).toEqual([0, 1, 2]);
  });
  it('隠された目印は、ほかの目印を隠さない（A が B を隠し、B と重なる C は A と重ならなければ残る）', () => {
    // A(近い)・B(中)・C(遠い)。A と B が重なり、B と C が重なるが、A と C は離れている
    const A = item(0, 0, 0, 1), B = item(1, 30, 0, 2), C = item(2, 60, 0, 3);
    expect([...resolveOverlaps([A, B, C], 0)].sort()).toEqual([0, 2]);
  });
  it('同じ距離なら id の小さいほうを残す', () => {
    expect([...resolveOverlaps([item(5, 0, 0, 1), item(2, 5, 0, 1)], 0)]).toEqual([2]);
  });
  it('空の入力', () => {
    expect(resolveOverlaps([]).size).toBe(0);
  });
});
