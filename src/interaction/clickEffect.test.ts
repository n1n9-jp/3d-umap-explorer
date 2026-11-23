import { describe, expect, it } from 'vitest';
import { PointerGesture } from './gesture';
import { clickEffect } from './clickEffect';

/** 左ボタンのクリックを順に送り、そのたびの選択と移動先を返す（pick は点 `pickAt(x)`）。 */
function run(clicks: { t: number; x: number }[], pickAt: (x: number) => number | null, initial: number | null) {
  const g = new PointerGesture();
  let selected = initial;
  const log: { selected: number | null; flyTo: number | null }[] = [];
  for (const { t, x } of clicks) {
    g.down(1, 0, x, 10);
    const r = g.up(1, x, 10, t);
    if (!r || r.kind !== 'click') continue;
    const e = clickEffect(pickAt(r.x), r.double);
    selected = e.select;
    log.push({ selected, flyTo: e.flyTo });
  }
  return log;
}

describe('clickEffect（選択と移動の仕様）', () => {
  it('クリックは離した位置の点を選択し、飛ばない。点のない場所なら解除する', () => {
    expect(clickEffect(5, false)).toEqual({ select: 5, flyTo: null });
    expect(clickEffect(null, false)).toEqual({ select: null, flyTo: null });
  });

  it('ダブルクリックの 2 回目だけが飛ぶ。点のない場所では飛ばない', () => {
    expect(clickEffect(5, true)).toEqual({ select: 5, flyTo: 5 });
    expect(clickEffect(null, true)).toEqual({ select: null, flyTo: null });
  });

  it('点 B を選択中に点 A をダブルクリックすると、1 回目のクリックで選択が A に移り、2 回目で A へ飛ぶ', () => {
    const A = 1, B = 2;
    const log = run([{ t: 0, x: 100 }, { t: 200, x: 100 }], () => A, B);
    expect(log).toEqual([
      { selected: A, flyTo: null }, // 1 回目: 選択が B から A へ移る
      { selected: A, flyTo: A }, // 2 回目: A へ飛ぶ。選択は A のまま
    ]);
  });

  it('点のない場所をダブルクリックすると、1 回目のクリックで選択が解除され、飛ばない', () => {
    const B = 2;
    const log = run([{ t: 0, x: 100 }, { t: 200, x: 100 }], () => null, B);
    expect(log).toEqual([
      { selected: null, flyTo: null }, // 1 回目: 選択が解除される
      { selected: null, flyTo: null },
    ]);
  });

  it('三連打で 2 回飛ばない（3 回目は新しい 1 回目）', () => {
    const log = run([{ t: 0, x: 100 }, { t: 150, x: 100 }, { t: 300, x: 100 }], () => 7, null);
    expect(log.map((l) => l.flyTo)).toEqual([null, 7, null]);
  });
});
