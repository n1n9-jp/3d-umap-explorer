import { describe, expect, it } from 'vitest';
import { PointerGesture } from './gesture';

describe('PointerGesture', () => {
  it('動かさずに押して離すとクリック', () => {
    const g = new PointerGesture();
    g.down(1, 0, 100, 100);
    expect(g.pressed).toBe(true);
    expect(g.up(1, 100, 100, 0)).toEqual({ kind: 'click', x: 100, y: 100, double: false });
    expect(g.pressed).toBe(false);
  });

  it('閾値以内の揺れはクリックのまま', () => {
    const g = new PointerGesture({ dragThresholdPx: 4 });
    g.down(1, 0, 100, 100);
    expect(g.move(1, 103, 101)).toBe(false);
    expect(g.up(1, 102, 102, 0)?.kind).toBe('click');
  });

  it('閾値を超えたらドラッグ。元の位置へ戻して離してもクリックにしない', () => {
    const g = new PointerGesture({ dragThresholdPx: 4 });
    g.down(1, 0, 100, 100);
    expect(g.move(1, 150, 100)).toBe(true);
    expect(g.dragging).toBe(true);
    expect(g.move(1, 160, 100)).toBe(false); // 初めて超えたときだけ true
    g.move(1, 100, 100);
    expect(g.up(1, 100, 100, 0)).toEqual({ kind: 'drag' });
    expect(g.dragging).toBe(false);
  });

  it('move が届かなくても、離した位置が遠ければドラッグ', () => {
    const g = new PointerGesture();
    g.down(1, 0, 0, 0);
    expect(g.up(1, 50, 0, 0)).toEqual({ kind: 'drag' });
  });

  it('左ボタン以外と、ほかのポインタは無視する', () => {
    const g = new PointerGesture();
    g.down(1, 2, 0, 0);
    expect(g.pressed).toBe(false);
    expect(g.up(1, 0, 0, 0)).toBeNull();
    g.down(1, 0, 0, 0);
    g.down(2, 0, 50, 50); // 押している間の別の押下
    expect(g.up(2, 50, 50, 0)).toBeNull();
    expect(g.up(1, 0, 0, 0)?.kind).toBe('click');
  });

  it('近い時刻・位置の 2 回目のクリックがダブルクリック。3 回目は新しい 1 回目', () => {
    const g = new PointerGesture({ doubleClickMs: 400, doubleClickPx: 6 });
    const click = (t: number, x = 10) => { g.down(1, 0, x, 10); return g.up(1, x, 10, t); };
    expect(click(0)).toMatchObject({ double: false });
    expect(click(300)).toMatchObject({ double: true });
    expect(click(400)).toMatchObject({ double: false });
    expect(click(1000)).toMatchObject({ double: false }); // 間隔が長い
    expect(click(1100, 30)).toMatchObject({ double: false }); // 位置が離れている
    expect(click(1200, 31)).toMatchObject({ double: true });
  });

  it('ドラッグを挟むとダブルクリックにならない', () => {
    const g = new PointerGesture();
    g.down(1, 0, 10, 10); g.up(1, 10, 10, 0);
    g.down(1, 0, 10, 10); g.move(1, 60, 10); g.up(1, 10, 10, 100);
    g.down(1, 0, 10, 10);
    expect(g.up(1, 10, 10, 200)).toMatchObject({ kind: 'click', double: false });
  });

  it('cancel で押下を取り消す', () => {
    const g = new PointerGesture();
    g.down(1, 0, 0, 0);
    g.cancel();
    expect(g.up(1, 0, 0, 0)).toBeNull();
  });
});
