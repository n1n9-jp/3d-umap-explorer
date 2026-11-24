import { describe, expect, it } from 'vitest';
import { describeDirection, EMPTY_MEMORY, INSIDE_ENTER_RATIO, INSIDE_EXIT_RATIO, locateCamera, rememberLocation, type ClusterSphere } from './location';

const C: ClusterSphere[] = [
  { id: 0, center: [0, 0, 0], radius: 1 },
  { id: 1, center: [5, 0, 0], radius: 0.5 },
  { id: 2, center: [0, 8, 0], radius: 2 },
];

describe('locateCamera', () => {
  it('球の内部なら inside。境界（半径ちょうど）も内部', () => {
    expect(locateCamera([0.2, 0, 0], C)).toEqual({ kind: 'inside', id: 0, distance: 0.2 });
    expect(locateCamera([1, 0, 0], C)).toMatchObject({ kind: 'inside', id: 0 });
    expect(locateCamera([5.3, 0, 0], C)).toMatchObject({ kind: 'inside', id: 1 });
  });
  it('どの球にも入らないときは、表面までの距離が最小のものを nearest とする', () => {
    const l = locateCamera([3, 0, 0], C); // 0 の表面まで 2、1 の表面まで 1.5
    expect(l.kind).toBe('nearest');
    if (l.kind === 'nearest') {
      expect(l.id).toBe(1);
      expect(l.distance).toBeCloseTo(1.5, 12);
    }
  });
  it('nearest は、中心が遠くても半径の大きい球のほうが表面に近ければそちらを選ぶ', () => {
    const l = locateCamera([0, 5, 0], C); // 0 の表面まで 4、2 の表面まで 1（中心までは 3）
    expect(l).toMatchObject({ kind: 'nearest', id: 2 });
  });
  it('複数の球の内部にいるときは、中心に近い（距離 ÷ 半径が小さい）ものを選ぶ', () => {
    const overlap: ClusterSphere[] = [
      { id: 0, center: [0, 0, 0], radius: 1 },
      { id: 1, center: [0.5, 0, 0], radius: 0.4 },
    ];
    expect(locateCamera([0.45, 0, 0], overlap)).toMatchObject({ kind: 'inside', id: 1 }); // 0.05/0.4 < 0.45/1
    expect(locateCamera([0.0, 0, 0], overlap)).toMatchObject({ kind: 'inside', id: 0 });
  });
  it('同値なら id の小さいほうを選ぶ', () => {
    const tie: ClusterSphere[] = [
      { id: 3, center: [1, 0, 0], radius: 1 },
      { id: 2, center: [-1, 0, 0], radius: 1 },
    ];
    expect(locateCamera([0, 0, 0], tie)).toMatchObject({ kind: 'inside', id: 2 });
  });
  it('クラスタがなければ none', () => {
    expect(locateCamera([0, 0, 0], [])).toEqual({ kind: 'none' });
  });
});

describe('describeDirection', () => {
  it('正面（視線から 18° 以内）', () => {
    expect(describeDirection(0, 0, 1).word).toBe('正面');
    expect(describeDirection(0.2, 0.1, 1).word).toBe('正面');
    expect(describeDirection(0, 0, 0).word).toBe('正面');
  });
  it('後方（視線から 110° 超）', () => {
    expect(describeDirection(0, 0, -1).word).toBe('後方');
    expect(describeDirection(1, 0, -0.9).word).toBe('後方');
  });
  it('真横・斜めは 8 方向', () => {
    expect(describeDirection(1, 0, 0)).toEqual({ arrow: '→', word: '右' });
    expect(describeDirection(-1, 0, 0)).toEqual({ arrow: '←', word: '左' });
    expect(describeDirection(0, 1, 0)).toEqual({ arrow: '↑', word: '上' });
    expect(describeDirection(0, -1, 0)).toEqual({ arrow: '↓', word: '下' });
    expect(describeDirection(1, 1, 0.2).word).toBe('右上');
    expect(describeDirection(-1, 1, 0.2).word).toBe('左上');
    expect(describeDirection(-1, -1, 0.2).word).toBe('左下');
    expect(describeDirection(1, -1, 0.2).word).toBe('右下');
  });
  it('右下寄りの左右（角度の境界の外側）', () => {
    expect(describeDirection(1, -0.1, 0.1).word).toBe('右');
    expect(describeDirection(-1, 0.1, 0.1).word).toBe('左');
  });
});

describe('locateCamera（判定の幅）', () => {
  const A: ClusterSphere = { id: 0, center: [0, 0, 0], radius: 1 };
  /** 軸 x に沿って並べた位置を順に渡して、現在地の判定の列を返す（前の判定を記憶として渡す） */
  const run = (xs: number[], clusters: readonly ClusterSphere[], axis = 0) => {
    let memory = EMPTY_MEMORY;
    return xs.map((x) => {
      const p: [number, number, number] = [0, 0, 0];
      p[axis] = x;
      const loc = locateCamera(p, clusters, memory);
      memory = rememberLocation(loc);
      return loc;
    });
  };
  const kinds = (xs: number[], clusters: readonly ClusterSphere[]) => run(xs, clusters).map((l) => (l.kind === 'inside' ? 'I' : l.kind === 'nearest' ? 'N' : '-')).join('');

  it('入る距離（0.95 倍）と出る距離（1.05 倍）に差がある', () => {
    expect(INSIDE_ENTER_RATIO).toBeLessThan(1);
    expect(INSIDE_EXIT_RATIO).toBeGreaterThan(1);
    // 外から近づく: 0.95 を下回るまでは外
    expect(kinds([1.5, 1.1, 1.0, 0.96, 0.95, 0.9], [A])).toBe('NNNNII');
    // 内から離れる: 1.05 を超えるまでは内
    expect(kinds([0.5, 0.95, 1.0, 1.04, 1.05, 1.06, 1.2], [A])).toBe('IIIIINN');
  });
  it('境界（半径ちょうど）の付近で小さく往復しても、判定が入れ替わり続けない', () => {
    // 外から来て、0.95 を下回って入ったあと、0.96〜1.04 の間を往復する
    const xs = [1.2, 0.9, ...Array.from({ length: 20 }, (_, k) => (k % 2 === 0 ? 0.97 : 1.03))];
    const seq = kinds(xs, [A]);
    expect(seq).toBe('NI' + 'I'.repeat(20));
    // 外にいて、同じ範囲を往復しても、外のまま
    const out = kinds([1.2, ...Array.from({ length: 20 }, (_, k) => (k % 2 === 0 ? 1.03 : 0.97))], [A]);
    expect(out).toBe('N'.repeat(21));
  });
  it('記憶を渡さなければ、幅のない判定（半径ちょうどは内部）', () => {
    expect(locateCamera([1, 0, 0], [A])).toMatchObject({ kind: 'inside' });
    expect(locateCamera([1.0001, 0, 0], [A])).toMatchObject({ kind: 'nearest' });
  });
  it('幅の帯の中の最寄りの表面までの距離は 0（負にならない）', () => {
    const l = locateCamera([0.98, 0, 0], [A], EMPTY_MEMORY);
    expect(l).toMatchObject({ kind: 'nearest', id: 0, distance: 0 });
  });
  it('重なり合う球の内部で、現在地のクラスタが入れ替わり続けない', () => {
    // 2 つの球が重なり、二等分面（x = 0.5）の付近を往復する。ratio は 0 側 = x / 1、1 側 = (1 - x) / 1
    const overlap: ClusterSphere[] = [
      { id: 0, center: [0, 0, 0], radius: 1 },
      { id: 1, center: [1, 0, 0], radius: 1 },
    ];
    const xs = [0.2, ...Array.from({ length: 30 }, (_, k) => 0.5 + (k % 2 === 0 ? 0.03 : -0.03))];
    const ids = run(xs, overlap).map((l) => (l.kind === 'inside' ? l.id : -1));
    expect(ids.every((id) => id === 0)).toBe(true);
    // 十分に 1 側へ寄れば（差が INSIDE_SWITCH_MARGIN を超えたら）替わる。戻りは、同じ幅だけ戻るまで替わらない
    const moved = run([0.2, 0.5, 0.52, 0.6, 0.7, 0.6, 0.5, 0.46, 0.42], overlap).map((l) => (l.kind === 'inside' ? l.id : -1));
    expect(moved).toEqual([0, 0, 0, 1, 1, 1, 1, 1, 0]);
  });
  it('重なり合う球の、片方の外へ出ても、もう一方の内部なら、そちらになる', () => {
    const overlap: ClusterSphere[] = [
      { id: 0, center: [0, 0, 0], radius: 1 },
      { id: 1, center: [1.2, 0, 0], radius: 1 },
    ];
    // A は x = 1.04 まで（出る距離の内側）、B は x = 0.25 から（入る距離の内側）。B のほうが十分に中心に近くなれば、A の内部にいても B へ替わる
    const ids = run([0.3, 0.6, 0.9, 1.04, 1.06, 1.2], overlap).map((l) => (l.kind === 'inside' ? l.id : -1));
    expect(ids).toEqual([0, 0, 1, 1, 1, 1]);
  });
  it('最寄りのクラスタも、表面までの距離がほぼ同じ場所で入れ替わり続けない。closest は幅によらない最小の距離', () => {
    const two: ClusterSphere[] = [
      { id: 0, center: [-3, 0, 0], radius: 1 },
      { id: 1, center: [3, 0, 0], radius: 1 },
    ];
    // x = 0 が二等分。微小に往復する
    const ls = run(Array.from({ length: 20 }, (_, k) => (k % 2 === 0 ? 0.02 : -0.02)), two);
    const ids = new Set(ls.map((l) => (l.kind === 'nearest' ? l.id : -1)));
    expect(ids.size).toBe(1);
    // 大きく寄れば替わる
    const far = run([-1, 0.0, 1, 2], two).map((l) => (l.kind === 'nearest' ? l.id : -1));
    expect(far[0]).toBe(0);
    expect(far[3]).toBe(1);
    // 保っているほうを選んでいても、closest は最小の距離
    const held = run([0.02, -0.02], two)[1]!;
    if (held.kind === 'nearest') {
      expect(held.closest).toBeLessThanOrEqual(held.distance);
      expect(held.closest).toBeCloseTo(2 - 0.02, 12); // どちらの表面までも 2 前後。小さいほうが closest
    }
  });
  it('クラスタがなければ none', () => {
    expect(locateCamera([0, 0, 0], [], EMPTY_MEMORY)).toEqual({ kind: 'none' });
  });
});
