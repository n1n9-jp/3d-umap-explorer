import { describe, expect, it } from 'vitest';
import { HoverTracker, LatestOnly } from './latest';

/** 外から解決できる Promise */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('LatestOnly', () => {
  it('最後に発行した要求の結果だけを使う（解決の順に依らない）', async () => {
    const l = new LatestOnly();
    const got: number[] = [];
    const a = deferred<number>(), b = deferred<number>();
    l.issue(a.promise, (v) => got.push(v));
    l.issue(b.promise, (v) => got.push(v));
    b.resolve(2);
    a.resolve(1);
    await flush();
    expect(got).toEqual([2]);
  });

  it('invalidate の後に解決した結果は捨てる', async () => {
    const l = new LatestOnly();
    const got: number[] = [];
    const a = deferred<number>();
    l.issue(a.promise, (v) => got.push(v));
    l.invalidate();
    a.resolve(1);
    await flush();
    expect(got).toEqual([]);
  });
});

describe('HoverTracker', () => {
  function setup() {
    const calls: { x: number; y: number; d: ReturnType<typeof deferred<number | null>> }[] = [];
    const changes: (number | null)[] = [];
    const t = new HoverTracker((x, y) => { const d = deferred<number | null>(); calls.push({ x, y, d }); return d.promise; },
      (i) => changes.push(i));
    return { t, calls, changes };
  }

  it('1 フレームに最大 1 回、最後のカーソル位置で要求する', () => {
    const { t, calls } = setup();
    t.move(1, 1); t.move(2, 2); t.move(3, 3);
    expect(calls.length).toBe(0);
    expect(t.frame()).toBe(true);
    expect(t.frame()).toBe(false); // 動いていなければ出さない
    expect(calls.map((c) => [c.x, c.y])).toEqual([[3, 3]]);
  });

  it('古い要求の結果は使わない', async () => {
    const { t, calls, changes } = setup();
    t.move(1, 1); t.frame();
    t.move(2, 2); t.frame();
    calls[1]!.d.resolve(20);
    calls[0]!.d.resolve(10);
    await flush();
    expect(t.hovered).toBe(20);
    expect(changes).toEqual([20]);
  });

  it('suspend でホバーを外し、要求を出さず、途中の結果も捨てる。resume で最後の位置をもう一度調べる', async () => {
    const { t, calls, changes } = setup();
    t.move(5, 5); t.frame();
    calls[0]!.d.resolve(7);
    await flush();
    expect(t.hovered).toBe(7);
    t.move(6, 6); t.frame();
    t.suspend();
    expect(t.hovered).toBeNull();
    calls[1]!.d.resolve(8);
    t.move(9, 9);
    expect(t.frame()).toBe(false);
    await flush();
    expect(t.hovered).toBeNull();
    t.resume();
    expect(t.frame()).toBe(true);
    expect(calls[2]).toMatchObject({ x: 9, y: 9 });
    calls[2]!.d.resolve(9);
    await flush();
    expect(changes).toEqual([7, null, 9]);
  });

  it('leave でホバーを外し、位置を忘れる', async () => {
    const { t, calls } = setup();
    t.move(1, 1); t.frame();
    t.leave();
    calls[0]!.d.resolve(3);
    await flush();
    expect(t.hovered).toBeNull();
    expect(t.position).toBeNull();
    t.suspend(); t.resume();
    expect(t.frame()).toBe(false);
  });

  it('点がなければ null、要求の失敗も null', async () => {
    const { t, calls } = setup();
    t.move(1, 1); t.frame();
    calls[0]!.d.resolve(4);
    await flush();
    t.move(2, 2); t.frame();
    calls[1]!.d.reject(new Error('x'));
    await flush();
    expect(t.hovered).toBeNull();
  });
});
