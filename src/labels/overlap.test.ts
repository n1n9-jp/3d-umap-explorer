import { describe, expect, it } from 'vitest';
import { labelsCoveringWords, rectsOverlap, resolveOverlaps, type OverlapItem } from './overlap';

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

describe('resolveOverlaps の切り替えの幅（前のフレームの結果を持ち込む）', () => {
  const memory = (shown: number[], extra: { pinned?: number | null; stayGap?: number } = {}) => ({ shown: new Set(shown), stayGap: 1, ...extra });

  it('距離の順位が入れ替わっても、出ていたほうが残る', () => {
    // A が出ていて、B がほんの少し近くなっただけ（5%）。前の結果を持ち込まなければ B が残って入れ替わる
    const A = item(0, 0, 0, 1.0), B = item(1, 10, 0, 0.95);
    expect([...resolveOverlaps([A, B], 4)]).toEqual([1]);
    expect([...resolveOverlaps([A, B], 4, memory([0]))]).toEqual([0]);
  });
  it('明確に近くなったら入れ替わる（出ていないほうが stickiness を超えて近い）', () => {
    const A = item(0, 0, 0, 1.0), B = item(1, 10, 0, 0.8);
    expect([...resolveOverlaps([A, B], 4, memory([0]))]).toEqual([1]);
  });
  it('間隔が新しく出す閾値（gap）を割っても、出ている同士は stayGap まで保つ', () => {
    // 幅 40 の 2 つの目印。中心の間隔 42 は、間隔 2（gap 4 を割り、stayGap 1 は超える）
    const A = item(0, 0, 0, 1), B = item(1, 42, 0, 2);
    expect([...resolveOverlaps([A, B], 4)]).toEqual([0]); // 前の結果がなければ B は出ない
    expect([...resolveOverlaps([A, B], 4, memory([0, 1])).values()].sort()).toEqual([0, 1]);
    expect([...resolveOverlaps([A, B], 4, memory([0])).values()]).toEqual([0]); // B が新しく出るなら gap を求める
  });
  it('stayGap も割れば、出ていたものも隠れる', () => {
    const A = item(0, 0, 0, 1), B = item(1, 40.5, 0, 2); // 間隔 0.5 < stayGap 1
    expect([...resolveOverlaps([A, B], 4, memory([0, 1]))]).toEqual([0]);
  });
  it('pinned は距離によらず最優先で残る', () => {
    const A = item(0, 0, 0, 1), B = item(1, 10, 0, 5);
    expect([...resolveOverlaps([A, B], 4, memory([], { pinned: 1 }))]).toEqual([1]);
  });
  it('pinned が指定されていても、重ならないものは残る', () => {
    const A = item(0, 0, 0, 1), B = item(1, 100, 0, 5);
    expect([...resolveOverlaps([A, B], 4, memory([], { pinned: 1 }))].sort()).toEqual([0, 1]);
  });

  /** 前のフレームの結果を持ち込みながら、フレームごとに目印の位置と距離を動かして、表示の切り替わり回数を数える。 */
  function toggles(frames: (t: number) => OverlapItem[], n: number, withMemory: boolean, gap = 4): number {
    let shown = new Set<number>();
    const prev = new Map<number, boolean>();
    let count = 0;
    for (let t = 0; t < n; t++) {
      const kept = resolveOverlaps(frames(t), gap, withMemory ? { shown, stayGap: 1 } : undefined);
      for (let id = 0; id < 2; id++) {
        const now = kept.has(id);
        if (t > 0 && prev.get(id) !== now) count++;
        prev.set(id, now);
      }
      shown = kept;
    }
    return count;
  }

  it('距離がほぼ等しい 2 つの目印の順位が揺れても、表示は切り替わり続けない', () => {
    // 距離が 1.0 前後で、フレームごとに A が近い・B が近いを繰り返す（差は 2%）
    const frames = (t: number) => [item(0, 0, 0, 1 + (t % 2 ? 0.01 : -0.01)), item(1, 10, 0, 1 + (t % 2 ? -0.01 : 0.01))];
    expect(toggles(frames, 40, false)).toBeGreaterThan(20); // 前の結果なしでは毎フレーム入れ替わる
    expect(toggles(frames, 40, true)).toBeLessThanOrEqual(2); // 最初の確定だけ
  });
  it('間隔が閾値（gap）をまたいで揺れても、表示は切り替わり続けない', () => {
    // 中心の間隔が 44.5 と 43.5 の間を往復（目印の幅の合計の半分 40 に gap 4 を足した 44 をまたぐ）
    const frames = (t: number) => [item(0, 0, 0, 1), item(1, t % 2 ? 43.5 : 44.5, 0, 2)];
    expect(toggles(frames, 40, false)).toBeGreaterThan(20);
    expect(toggles(frames, 40, true)).toBeLessThanOrEqual(2);
  });
});

describe('labelsCoveringWords（内部で単語の文字と重なる目印）', () => {
  const chip = (id: number, x: number, y: number): OverlapItem => ({ id, x, y, width: 100, height: 20, distance: 1 });
  it('単語の矩形と、間隔を含めて重なる目印だけを返す', () => {
    const words = [{ x: 200, y: 100, width: 60, height: 14 }];
    const items = [chip(0, 200, 100), chip(1, 200, 125), chip(2, 200, 160), chip(3, 500, 100)];
    // 1: 縦の中心の差 25。間隔 4 では (20 + 14) / 2 + 4 = 21 なので重ならず、間隔 10 では 27 なので重なる
    expect([...labelsCoveringWords(items, words, 4)].sort()).toEqual([0]);
    expect([...labelsCoveringWords(items, words, 10)].sort()).toEqual([0, 1]);
  });
  it('フォーカスのある目印は隠さない。単語がなければ何も隠さない', () => {
    const words = [{ x: 200, y: 100, width: 60, height: 14 }];
    expect([...labelsCoveringWords([chip(0, 200, 100)], words, 4, 0)]).toEqual([]);
    expect([...labelsCoveringWords([chip(0, 200, 100)], [], 4)]).toEqual([]);
  });
});
