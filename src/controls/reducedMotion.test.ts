import { describe, expect, it } from 'vitest';
import { prefersReducedMotion, REDUCED_MOTION_QUERY, ReducedMotionQuery } from './reducedMotion';

type ChangeListener = (e: { matches: boolean }) => void;

/** `change` イベントを送れる、最小の MediaQueryList。 */
class FakeMediaQueryList {
  matches: boolean;
  readonly listeners = new Set<ChangeListener>();
  constructor(matches: boolean) {
    this.matches = matches;
  }
  addEventListener(type: string, fn: ChangeListener): void {
    if (type === 'change') this.listeners.add(fn);
  }
  removeEventListener(type: string, fn: ChangeListener): void {
    if (type === 'change') this.listeners.delete(fn);
  }
  /** OS の設定を切り替えたときのように、値を変えて `change` を送る。 */
  set(matches: boolean): void {
    this.matches = matches;
    for (const fn of [...this.listeners]) fn({ matches });
  }
}

/** 呼ばれた回数を数える `matchMedia` を持つ窓。 */
function countingWindow(initial: boolean) {
  const mql = new FakeMediaQueryList(initial);
  const queries: string[] = [];
  const win = {
    matchMedia: (q: string) => {
      queries.push(q);
      return mql as unknown as MediaQueryList;
    },
  };
  return { win, mql, queries };
}

describe('ReducedMotionQuery', () => {
  it('作るときに matchMedia を 1 回だけ呼び、何度読んでも呼び直さない', () => {
    const { win, queries } = countingWindow(true);
    const q = new ReducedMotionQuery(win);
    for (let i = 0; i < 100; i++) expect(q.reduced).toBe(true);
    expect(queries).toEqual([REDUCED_MOTION_QUERY]);
    expect(REDUCED_MOTION_QUERY).toBe('(prefers-reduced-motion: reduce)');
  });

  it('change イベントで値を持ち直す（設定を途中で切り替えると、次に読んだときから新しい値）', () => {
    const { win, mql } = countingWindow(false);
    const q = new ReducedMotionQuery(win);
    expect(q.reduced).toBe(false);
    mql.set(true);
    expect(q.reduced).toBe(true);
    mql.set(false);
    expect(q.reduced).toBe(false);
  });

  it('dispose でリスナーを外し、そのあとは値を持ち直さない。2 回呼んでもよい', () => {
    const { win, mql } = countingWindow(false);
    const q = new ReducedMotionQuery(win);
    expect(mql.listeners.size).toBe(1);
    q.dispose();
    expect(mql.listeners.size).toBe(0);
    mql.set(true);
    expect(q.reduced).toBe(false);
    q.dispose();
  });

  it('addEventListener のない古い MediaQueryList では addListener / removeListener を使う', () => {
    const listeners = new Set<ChangeListener>();
    const legacy = {
      matches: false,
      addListener: (fn: ChangeListener) => listeners.add(fn),
      removeListener: (fn: ChangeListener) => listeners.delete(fn),
    };
    const q = new ReducedMotionQuery({ matchMedia: () => legacy as unknown as MediaQueryList });
    expect(listeners.size).toBe(1);
    for (const fn of listeners) fn({ matches: true });
    expect(q.reduced).toBe(true);
    q.dispose();
    expect(listeners.size).toBe(0);
  });

  it('matchMedia がない・例外を投げる・change を送れないときは、それぞれ false・false・最初の値のまま', () => {
    expect(new ReducedMotionQuery(null).reduced).toBe(false);
    expect(new ReducedMotionQuery({} as Pick<Window, 'matchMedia'>).reduced).toBe(false);
    const throwing = { matchMedia: () => { throw new Error('no'); } };
    expect(new ReducedMotionQuery(throwing as unknown as Pick<Window, 'matchMedia'>).reduced).toBe(false);
    const plain = new ReducedMotionQuery({ matchMedia: () => ({ matches: true }) as MediaQueryList });
    expect(plain.reduced).toBe(true);
    plain.dispose();
  });

  it('prefersReducedMotion: いまの値を 1 回だけ読む', () => {
    const { win, mql, queries } = countingWindow(true);
    expect(prefersReducedMotion(win)).toBe(true);
    mql.matches = false;
    expect(prefersReducedMotion(win)).toBe(false);
    expect(queries.length).toBe(2);
  });
});
