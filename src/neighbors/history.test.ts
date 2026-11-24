import { describe, expect, it } from 'vitest';
import { SelectionHistory } from './history';

describe('SelectionHistory', () => {
  it('別の点へ選択が移ると、前の点を積み、戻ると取り出す', () => {
    const h = new SelectionHistory();
    h.record(1);
    expect(h.canGoBack).toBe(false);
    h.record(2);
    h.record(3);
    expect(h.entries()).toEqual([1, 2]);
    expect(h.peek()).toBe(2);
    const b = h.back();
    expect(b).toBe(2);
    h.record(2, { back: true }); // 戻った先は積まない
    expect(h.entries()).toEqual([1]);
    expect(h.back()).toBe(1);
    h.record(1, { back: true });
    expect(h.canGoBack).toBe(false);
    expect(h.back()).toBeNull();
  });
  it('同じ点の選び直しと解除は積まない。解除のあとに別の点を選ぶと、解除の前の点を積む', () => {
    const h = new SelectionHistory();
    h.record(5);
    h.record(5);
    expect(h.length).toBe(0);
    h.record(null);
    expect(h.length).toBe(0);
    h.record(6);
    expect(h.entries()).toEqual([5]);
  });
  it('戻ったあとに別の点を選ぶと、戻った先の点を積む（たどり直せる）', () => {
    const h = new SelectionHistory();
    h.record(1); h.record(2); h.record(3);
    h.record(h.back()!, { back: true }); // 2 へ戻る
    h.record(9);
    expect(h.entries()).toEqual([1, 2]);
  });
  it('長さの上限を超えると古いものから捨てる。clear で空になる', () => {
    const h = new SelectionHistory(3);
    for (let i = 0; i < 10; i++) h.record(i);
    expect(h.entries()).toEqual([6, 7, 8]);
    h.clear();
    expect(h.length).toBe(0);
    h.record(4);
    expect(h.length).toBe(0); // clear のあとの最初の選択は積まない
  });
});
