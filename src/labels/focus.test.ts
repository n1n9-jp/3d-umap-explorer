import { describe, expect, it } from 'vitest';
import { focusFallback } from './focus';

describe('focusFallback', () => {
  const order = [0, 1, 2, 3, 4];
  it('Tab の順で、次に出ている目印を返す', () => {
    expect(focusFallback(order, new Set([0, 2, 4]), 1)).toBe(2);
    expect(focusFallback(order, new Set([3]), 1)).toBe(3);
  });
  it('末尾からは先頭へ戻る', () => {
    expect(focusFallback(order, new Set([0, 1]), 4)).toBe(0);
  });
  it('フォーカス中の目印自身は返さない（出ているものに含まれていても）', () => {
    expect(focusFallback(order, new Set([2]), 2)).toBeNull();
    expect(focusFallback(order, new Set([2, 3]), 2)).toBe(3);
  });
  it('出ている目印がなければ null（フォーカスを外す）', () => {
    expect(focusFallback(order, new Set(), 2)).toBeNull();
  });
  it('順序にない id は null', () => {
    expect(focusFallback(order, new Set([1]), 9)).toBeNull();
  });
});
