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

/**
 * three.js は描画のとき、`updateRanges` の範囲を GPU へ送って空にする（`WebGLAttributes.updateBuffer`）。
 * WebGL なしで、その「空にする」操作で描画を模擬する。
 */
const render = (attr: THREE.InstancedBufferAttribute) => attr.clearUpdateRanges();
const spans = (attr: THREE.InstancedBufferAttribute) => attr.updateRanges.map((r) => [r.start, r.start + r.count]);
/** 描画までに変わったすべての点が、次の描画で送られる（範囲のどれかに入る）か */
const sent = (attr: THREE.InstancedBufferAttribute, i: number) => spans(attr).some(([s, e]) => i >= s! && i < e!);

describe('描画をはさまない複数回の commit と、描画のあと', () => {
  it('範囲 → 範囲: 先の範囲を捨てず、両方を送る', () => {
    const { cloud, attr } = make(70000);
    for (let i = 1000; i < 1010; i++) cloud.setDotScale(i, 0.4);
    cloud.commitDotScales();
    for (let i = 50000; i < 50010; i++) cloud.setDotScale(i, 0.4);
    cloud.commitDotScales();
    expect(spans(attr)).toEqual([[1000, 1010], [50000, 50010]]);
  });
  it('範囲 → 範囲: 近い範囲は 1 つにまとめ、重なる範囲も 1 つにする', () => {
    const { cloud, attr } = make(70000);
    for (const i of [1000, 1001]) cloud.setDotScale(i, 0.4);
    cloud.commitDotScales();
    for (const i of [1002, 1003, 1500, 1501]) cloud.setDotScale(i, 0.4);
    cloud.commitDotScales();
    for (let i = 1000; i < 1504; i++) expect(sent(attr, i) || ![1000, 1001, 1002, 1003, 1500, 1501].includes(i)).toBe(true);
    expect(attr.updateRanges.length).toBeLessThanOrEqual(2);
    expect(spans(attr)[0]![0]).toBe(1000);
  });
  it('範囲を何回足しても、変えたすべての点が送られ、範囲の数は費用の上限に収まる', () => {
    const { cloud, attr } = make(70000);
    const changed: number[] = [];
    for (let c = 0; c < 40; c++) {
      const i = (c * 1733) % 70000;
      cloud.setDotScale(i, 0.3);
      changed.push(i);
      cloud.commitDotScales();
    }
    for (const i of changed) expect(sent(attr, i)).toBe(true);
    const el = spans(attr).reduce((a, [s, e]) => a + e! - s!, 0);
    expect(attr.updateRanges.length * DOT_SCALE_CALL_COST + el).toBeLessThan(DOT_SCALE_CALL_COST + 70000);
  });
  it('全体 → 範囲: 全体の送信が描画されずに残っている間は、全体のまま', () => {
    const { cloud, attr } = make(70000);
    for (let i = 0; i < 70000; i++) cloud.setDotScale(i, 0.4);
    cloud.commitDotScales();
    expect(spans(attr)).toEqual([[0, 70000]]);
    cloud.setDotScale(5, 0.2);
    cloud.commitDotScales();
    expect(spans(attr)).toEqual([[0, 70000]]);
  });
  it('ほぼ全体の 1 つの範囲が残っている間に、範囲を足しても、先の点はすべて送られる', () => {
    const { cloud, attr } = make(70000);
    for (let i = 0; i < 70000; i += 7) cloud.setDotScale(i, 0.4);
    cloud.commitDotScales();
    for (const i of [3, 69999]) cloud.setDotScale(i, 0.2);
    cloud.commitDotScales();
    expect(attr.updateRanges.length).toBe(1);
    for (let i = 0; i < 70000; i += 7) expect(sent(attr, i)).toBe(true);
    expect(sent(attr, 3) && sent(attr, 69999)).toBe(true);
  });
  it('範囲 → 全体: 全体になる commit のあとは、全体の送信が残る', () => {
    const { cloud, attr } = make(70000);
    cloud.setDotScale(5, 0.2);
    cloud.commitDotScales();
    for (let i = 0; i < 70000; i++) cloud.setDotScale(i, 0.4);
    cloud.commitDotScales();
    expect(spans(attr)).toEqual([[0, 70000]]);
  });
  it('範囲を足し合わせて費用が全体を超えるときは、全体の送信に切り替わる', () => {
    const { cloud, attr } = make(70000);
    for (let i = 0; i < 70000; i += 20000) { for (let j = 0; j < 40; j++) cloud.setDotScale(i + j * 400, 0.5); cloud.commitDotScales(); }
    for (let i = 0; i < 70000; i += 50) cloud.setDotScale(i + 3, 0.5);
    cloud.commitDotScales();
    for (let i = 0; i < 70000; i += 50) expect(sent(attr, i + 3)).toBe(true);
  });
  it('描画のあと: 空になっていれば、次の commit は今回の範囲だけを送る（前の範囲は残らない）', () => {
    const { cloud, attr } = make(70000);
    cloud.setDotScale(100, 0.4);
    cloud.commitDotScales();
    render(attr);
    expect(attr.updateRanges).toEqual([]);
    cloud.setDotScale(60000, 0.4);
    cloud.commitDotScales();
    expect(spans(attr)).toEqual([[60000, 60001]]);
  });
  it('全体を送って描画したあとは、次の commit で全体のまま残らず、範囲だけになる', () => {
    const { cloud, attr } = make(70000);
    for (let i = 0; i < 70000; i++) cloud.setDotScale(i, 0.4);
    cloud.commitDotScales();
    render(attr);
    cloud.setDotScale(5, 0.2);
    cloud.commitDotScales();
    expect(spans(attr)).toEqual([[5, 6]]);
  });
  it('描画のたびに属性の version が進んでいれば、送信が残っている（version が three.js の記録より新しい）', () => {
    const { cloud, attr } = make(1000);
    const v0 = attr.version;
    cloud.setDotScale(1, 0.4);
    cloud.commitDotScales();
    cloud.setDotScale(2, 0.4);
    cloud.commitDotScales();
    expect(attr.version).toBeGreaterThan(v0);
  });
  it('最初の描画（バッファの作成と全体の送信）は onUpload を呼ぶ。そのとき残っている範囲は捨てる', () => {
    const { cloud, attr } = make(70000);
    cloud.setDotScale(100, 0.4);
    cloud.commitDotScales();
    attr.onUploadCallback(); // three.js は、バッファの作成・送信のあとに呼ぶ
    expect(attr.updateRanges).toEqual([]);
    cloud.setDotScale(7, 0.4);
    cloud.commitDotScales();
    expect(spans(attr)).toEqual([[7, 8]]);
  });
});
