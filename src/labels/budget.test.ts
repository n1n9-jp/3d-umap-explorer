import { describe, expect, it } from 'vitest';
import { BUDGET_HYSTERESIS, DEFAULT_BUDGET, NEAR_LABEL_COUNT, cloudProximity, labelBudget, selectWithinBudget } from './budget';

describe('cloudProximity（カメラから点群までの近さ）', () => {
  it('点群の球の外では、球の表面と最寄りのクラスタの表面のうち近いほう ÷ R', () => {
    expect(cloudProximity([3, 0, 0], [0, 0, 0], 1, Infinity)).toBeCloseTo(2);
    expect(cloudProximity([3, 0, 0], [0, 0, 0], 1, 2.5)).toBeCloseTo(2);
    expect(cloudProximity([3, 0, 0], [0, 0, 0], 1, 1.2)).toBeCloseTo(1.2);
    expect(cloudProximity([0, 0, 4], [0, 0, 1], 2, Infinity)).toBeCloseTo(0.5);
  });
  it('点群の球の内側（クラスタに属さない領域も含む）では 0', () => {
    expect(cloudProximity([0.5, 0, 0], [0, 0, 0], 1, 0.3)).toBe(0);
    expect(cloudProximity([0.5, 0, 0], [0, 0, 0], 1, Infinity)).toBe(0);
  });
  it('半径が 0 なら Infinity（上限を設けない）', () => {
    expect(cloudProximity([0, 0, 0], [0, 0, 0], 0, 0)).toBe(Infinity);
  });
});

describe('labelBudget（出す目印の数の上限）', () => {
  const total = 18;
  it('すぐ近くでは nearCount 個', () => {
    expect(NEAR_LABEL_COUNT).toBe(3);
    expect(labelBudget(0, total)).toBe(3);
    expect(labelBudget(DEFAULT_BUDGET.near, total)).toBe(3);
  });
  it('遠い視点（far 以上）では上限なし（全数）', () => {
    expect(labelBudget(DEFAULT_BUDGET.far, total)).toBe(total);
    expect(labelBudget(5, total)).toBe(total);
    expect(labelBudget(Infinity, total)).toBe(total);
  });
  it('その間は、離れるほど増える', () => {
    const ps = [0.3, 0.4, 0.5, 0.6, 0.69];
    const b = ps.map((p) => labelBudget(p, total));
    for (let k = 1; k < b.length; k++) expect(b[k]!).toBeGreaterThanOrEqual(b[k - 1]!);
    expect(b[0]!).toBeGreaterThanOrEqual(3);
    expect(b[b.length - 1]!).toBeLessThan(total);
  });
  it('総数が nearCount 以下なら、常に全数', () => {
    expect(labelBudget(0, 2)).toBe(2);
  });
  it('前の上限を渡すと、境目の付近で切り替わり続けない', () => {
    // 連続値がちょうど 5 になる近さ
    const span = DEFAULT_BUDGET.far - DEFAULT_BUDGET.near;
    const at = (v: number) => DEFAULT_BUDGET.near + ((v - DEFAULT_BUDGET.nearCount) / (total - DEFAULT_BUDGET.nearCount)) * span;
    expect(labelBudget(at(5.01), total)).toBe(5);
    expect(labelBudget(at(4.99), total)).toBe(4);
    // 前が 5 なら、少し下がっても 5 のまま。幅を超えると 4 へ
    expect(labelBudget(at(5 - BUDGET_HYSTERESIS / 2), total, DEFAULT_BUDGET, 5)).toBe(5);
    expect(labelBudget(at(5 - 2 * BUDGET_HYSTERESIS), total, DEFAULT_BUDGET, 5)).toBe(4);
    // 前が 4 なら、少し上がっても 4 のまま
    expect(labelBudget(at(5 + BUDGET_HYSTERESIS / 2), total, DEFAULT_BUDGET, 4)).toBe(4);
    expect(labelBudget(at(5 + 2 * BUDGET_HYSTERESIS), total, DEFAULT_BUDGET, 4)).toBe(5);
  });
});

describe('selectWithinBudget（上限の範囲で残す目印）', () => {
  const items = [
    { id: 0, distance: 0.5 },
    { id: 1, distance: 0.2 },
    { id: 2, distance: 0.3 },
    { id: 3, distance: 0.9 },
    { id: 4, distance: 0.31 },
  ];
  it('近い順に上限まで残す', () => {
    expect([...selectWithinBudget(items, 2)].sort()).toEqual([1, 2]);
    expect(selectWithinBudget(items, 10).size).toBe(5);
  });
  it('前に出ていた目印は、距離の差が stickiness 以内なら残る', () => {
    expect([...selectWithinBudget(items, 2, new Set([1, 4]))].sort()).toEqual([1, 4]);
    // 差が大きければ入れ替わる
    expect([...selectWithinBudget(items, 2, new Set([1, 0]))].sort()).toEqual([1, 2]);
  });
  it('フォーカスのある目印は必ず残し、上限の 1 つに数える', () => {
    expect([...selectWithinBudget(items, 2, new Set(), 3)].sort()).toEqual([1, 3]);
  });
});
