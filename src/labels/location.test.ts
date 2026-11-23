import { describe, expect, it } from 'vitest';
import { describeDirection, locateCamera, type ClusterSphere } from './location';

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
