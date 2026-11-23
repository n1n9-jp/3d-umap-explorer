import { describe, expect, it } from 'vitest';
import { DEFAULT_VIEW, formatView, parsePositiveNumber, parseVec3, parseView } from './view';

describe('parseVec3', () => {
  it('3つの数値を読む', () => {
    expect(parseVec3('0.1,-2, 3e-1')).toEqual([0.1, -2, 0.3]);
  });
  it('不正な形は null', () => {
    expect(parseVec3('1,2')).toBeNull();
    expect(parseVec3('1,,2')).toBeNull();
    expect(parseVec3('a,b,c')).toBeNull();
    expect(parseVec3(null)).toBeNull();
  });
});

describe('parseView', () => {
  it('pos と look を読む', () => {
    expect(parseView('?pos=0.1,0.2,0.3&look=0,0,0')).toEqual({ pos: [0.1, 0.2, 0.3], look: [0, 0, 0] });
  });
  it('指定がなければ既定の視点', () => {
    expect(parseView('')).toEqual(DEFAULT_VIEW);
  });
  it('位置と注視点が同じなら奥を見る', () => {
    expect(parseView('?pos=0,0,0&look=0,0,0').look).toEqual([0, 0, -1]);
  });
  it('formatView と往復できる', () => {
    const v = { pos: [0.12345, -1, 2] as [number, number, number], look: [0, 0.5, 0] as [number, number, number] };
    expect(parseView(`?${formatView(v)}`)).toEqual({ pos: [0.1235, -1, 2], look: [0, 0.5, 0] });
  });
});

describe('parsePositiveNumber', () => {
  it('正の数だけを受け付ける', () => {
    expect(parsePositiveNumber('?size=0.004', 'size')).toBe(0.004);
    expect(parsePositiveNumber('?size=-1', 'size')).toBeNull();
    expect(parsePositiveNumber('?size=x', 'size')).toBeNull();
    expect(parsePositiveNumber('', 'size')).toBeNull();
  });
});
