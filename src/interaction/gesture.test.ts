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

  it('cancel(pointerId) は、押しているポインタと同じときだけ取り消す', () => {
    const g = new PointerGesture();
    g.down(1, 0, 0, 0);
    g.cancel(2); // 別のポインタの lostpointercapture / pointercancel
    expect(g.pressed).toBe(true);
    g.cancel(1);
    expect(g.pressed).toBe(false);
    expect(g.up(1, 0, 0, 0)).toBeNull();
  });

  it('cancel のあとの次のクリックは 1 回で効く（押したままの状態が残らない）', () => {
    const g = new PointerGesture();
    g.down(1, 0, 10, 10);
    g.move(1, 60, 10);
    expect(g.dragging).toBe(true);
    g.cancel(1); // 押している最中に capture が外れ、要素の外で離した pointerup は届かない
    expect(g.pressed).toBe(false);
    expect(g.dragging).toBe(false);
    g.down(1, 0, 200, 200);
    expect(g.up(1, 200, 200, 1000)).toEqual({ kind: 'click', x: 200, y: 200, double: false });
  });
});

describe('PointerGesture: pointerup の取りこぼし', () => {
  it('左ボタンを押していない状態の移動が届いたら、押下を破棄する（要素の外で離した pointerup が届かなかった）', () => {
    const g = new PointerGesture();
    g.down(1, 0, 10, 10, 1);
    g.move(1, 12, 10, 1);
    expect(g.pressed).toBe(true);
    expect(g.move(1, 300, 300, 0)).toBe(false); // buttons 0: もう押していない
    expect(g.pressed).toBe(false);
    expect(g.dragging).toBe(false);
    g.down(1, 0, 300, 300, 1);
    expect(g.up(1, 300, 300, 1000)).toEqual({ kind: 'click', x: 300, y: 300, double: false });
  });

  it('別のポインタの移動では破棄しない', () => {
    const g = new PointerGesture();
    g.down(1, 0, 10, 10, 1);
    g.move(2, 50, 50, 0);
    expect(g.pressed).toBe(true);
  });
});

describe('PointerGesture: 複数のボタンを重ねた押下', () => {
  it('左を押したまま右を押し、左を先に離すと、最後に右を離したときの pointerup はクリックではない', () => {
    const g = new PointerGesture();
    g.down(1, 0, 100, 100, 1);
    g.move(1, 100, 100, 3); // 右が重なった（ブラウザは pointermove で知らせる。buttons = 左 | 右）
    g.move(1, 100, 100, 2); // 左を離した（右だけ押している）
    expect(g.up(1, 100, 100, 0, 2)).toBeNull(); // 最後に離したのは右ボタン
    expect(g.pressed).toBe(false);
    // 次の左クリックは、通常どおり 1 回で効く
    g.down(1, 0, 100, 100, 1);
    expect(g.up(1, 100, 100, 1000, 0)).toEqual({ kind: 'click', x: 100, y: 100, double: false });
  });

  it('右を重ねたあと、右を先に離して左を最後に離しても、クリックではない', () => {
    const g = new PointerGesture();
    g.down(1, 0, 100, 100, 1);
    g.move(1, 100, 100, 3);
    g.move(1, 100, 100, 1);
    expect(g.up(1, 100, 100, 0, 0)).toBeNull();
  });

  it('pointerdown で知らされた重なり（同じポインタの 2 つ目のボタン、buttons に右を含む押下）もクリックにしない', () => {
    const g = new PointerGesture();
    g.down(1, 0, 100, 100, 1);
    g.down(1, 2, 100, 100, 3);
    expect(g.up(1, 100, 100, 0, 0)).toBeNull();
    g.down(1, 0, 100, 100, 3); // 右を押したまま左を押した
    expect(g.up(1, 100, 100, 10, 0)).toBeNull();
  });

  it('重なった押下は、ダブルクリックの 1 回目を忘れさせる', () => {
    const g = new PointerGesture();
    g.down(1, 0, 10, 10); g.up(1, 10, 10, 0);
    g.down(1, 0, 10, 10, 1); g.move(1, 10, 10, 3); g.up(1, 10, 10, 100, 2);
    g.down(1, 0, 10, 10);
    expect(g.up(1, 10, 10, 200)).toMatchObject({ kind: 'click', double: false });
  });

  it('buttons を渡さない move と、button を渡さない up は、左ボタンだけの操作として扱う', () => {
    const g = new PointerGesture();
    g.down(1, 0, 5, 5);
    g.move(1, 5, 5);
    expect(g.up(1, 5, 5, 0)?.kind).toBe('click');
  });
});
