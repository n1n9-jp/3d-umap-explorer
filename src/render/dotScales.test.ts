import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { DOT_SCALE_CALL_COST, PointCloud } from './pointCloud';

function make(count: number) {
  const positions = new Float32Array(3 * count);
  const colorIndices = new Float32Array(count);
  const cloud = new PointCloud({ positions, colorIndices });
  const attr = cloud.mesh.geometry.getAttribute('instanceDotScale') as THREE.InstancedBufferAttribute;
  return { cloud, attr };
}

/** 範囲（start, count）の集合が覆う要素の数。範囲がなければ全体 */
const covered = (attr: THREE.InstancedBufferAttribute) => (attr.updateRanges.length === 0 ? attr.array.length : attr.updateRanges.reduce((s, r) => s + r.count, 0));

describe('丸い点の倍率の属性の送信（変えた点だけ）', () => {
  it('値が変わらなければ、何も送らない（バージョンが進まない・送信の統計に載らない）', () => {
    const { cloud, attr } = make(70000);
    const v0 = attr.version;
    cloud.setDotScale(5, 1); // 既定と同じ
    cloud.commitDotScales();
    expect(attr.version).toBe(v0);
    expect(cloud.getDotScaleUploadStats().commits).toBe(0);
  });
  it('近くの点を変えたときは、その点を覆う小さな範囲だけを送る（全体の 280 KB は送らない）', () => {
    const { cloud, attr } = make(70000);
    for (let i = 1000; i < 1040; i++) cloud.setDotScale(i, 0.4);
    cloud.commitDotScales();
    expect(attr.updateRanges).toEqual([{ start: 1000, count: 40 }]);
    expect(attr.array[1010]).toBeCloseTo(0.4, 6);
    const st = cloud.getDotScaleUploadStats();
    expect(st).toMatchObject({ commits: 1, elements: 40, ranges: 1, lastElements: 40, lastRanges: 1 });
  });
  it('離れた少数の点は、範囲を分けて送る（隙間を埋めて送るより、範囲を分けるほうが安い間）', () => {
    const { cloud, attr } = make(70000);
    const idx = [100, 30000, 61000];
    for (const i of idx) cloud.setDotScale(i, 0);
    cloud.commitDotScales();
    expect(attr.updateRanges.map((r) => [r.start, r.count])).toEqual([[100, 1], [30000, 1], [61000, 1]]);
  });
  it('近い点は 1 つの範囲にまとめ、離れた点は別の範囲にする', () => {
    const { cloud, attr } = make(70000);
    for (const i of [10, 12, 14, 400, 402]) cloud.setDotScale(i, 0.5);
    cloud.commitDotScales();
    const ranges = attr.updateRanges.map((r) => [r.start, r.count]);
    expect(ranges.length).toBeGreaterThanOrEqual(1);
    expect(ranges.length).toBeLessThanOrEqual(2);
    // どの変えた点も、いずれかの範囲に入る
    for (const i of [10, 12, 14, 400, 402]) expect(ranges.some(([s, c]) => i >= s! && i < s! + c!)).toBe(true);
    expect(covered(attr)).toBeLessThan(DOT_SCALE_CALL_COST * 4);
  });
  it('点が全体にまばらに散らばって多いときは、範囲を分けずに、ほぼ全体を 1 回で送る', () => {
    const { cloud, attr } = make(70000);
    for (let i = 0; i < 70000; i += 7) cloud.setDotScale(i, 0.4);
    cloud.commitDotScales();
    expect(attr.updateRanges.length).toBeLessThanOrEqual(1); // 範囲なし（全体）か、ほぼ全体を覆う 1 つの範囲
    expect(covered(attr)).toBeGreaterThan(69900);
    expect(cloud.getDotScaleUploadStats().lastRanges).toBe(1);
  });
  it('送ったあとの同じ値の書き込みは、何も送らない。値を戻せば、また送る', () => {
    const { cloud, attr } = make(1000);
    cloud.setDotScale(3, 0.4);
    cloud.commitDotScales();
    const v = attr.version;
    cloud.setDotScale(3, 0.4);
    cloud.commitDotScales();
    expect(attr.version).toBe(v);
    cloud.setDotScale(3, 1);
    cloud.commitDotScales();
    expect(attr.version).toBeGreaterThan(v);
    expect(attr.array[3]).toBe(1);
  });
  it('同じ点を続けて書き換えても、1 回の送信で 1 要素（重複しない）', () => {
    const { cloud } = make(70000);
    cloud.setDotScale(500, 0.9);
    cloud.setDotScale(500, 0.5);
    cloud.setDotScale(500, 0.3);
    cloud.commitDotScales();
    expect(cloud.getDotScaleUploadStats().lastElements).toBe(1);
  });
});
