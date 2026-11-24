import { describe, expect, it } from 'vitest';
import { SpatialIndex } from '../spatial/SpatialIndex';
import { formatHud } from '../app/hud';
import {
  BEFORE_COMPUTE_NOTE, compareNeighbors, inMapPhrase, mapNeighbors, mapReliability, neighborItemLabel, originalNeighbors, summaryCountText, summaryHintText,
  summaryLeadText, summaryText,
} from './neighbors';

/** 4 点・k=3 のグラフ（行優先、近い順） */
const graph = {
  count: 4,
  k: 3,
  indices: new Uint16Array([1, 2, 3, 0, 2, 3, 3, 1, 0, 2, 1, 0]),
  distances: new Float32Array([0.1, 0.2, 0.3, 0.1, 0.4, 0.5, 0.2, 0.25, 0.3, 0.2, 0.3, 0.6]),
};

describe('originalNeighbors', () => {
  it('点の行の先頭 n 個を近い順に返す', () => {
    expect(originalNeighbors(graph, 2, 2)).toEqual({ indices: [3, 1], distances: [Math.fround(0.2), Math.fround(0.25)] });
    expect(originalNeighbors(graph, 0, 3).indices).toEqual([1, 2, 3]);
  });
  it('n がグラフの k を超えても k 個まで', () => {
    expect(originalNeighbors(graph, 3, 10).indices).toEqual([2, 1, 0]);
  });
  it('範囲外の番号はエラー', () => {
    expect(() => originalNeighbors(graph, 4, 2)).toThrow(RangeError);
    expect(() => originalNeighbors(graph, -1, 2)).toThrow(RangeError);
  });
});

describe('mapNeighbors', () => {
  it('3 次元の座標での近傍を、自分自身を除いて近い順に n 個返す（総当たりと一致）', () => {
    const n = 300;
    const pos = new Float32Array(3 * n);
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
    for (let i = 0; i < pos.length; i++) pos[i] = rnd();
    const index = new SpatialIndex(pos);
    for (const q of [0, 17, 123, 299]) {
      const brute = [...Array(n).keys()].filter((j) => j !== q).map((j) => {
        const dx = pos[3 * j]! - pos[3 * q]!, dy = pos[3 * j + 1]! - pos[3 * q + 1]!, dz = pos[3 * j + 2]! - pos[3 * q + 2]!;
        return { j, d: dx * dx + dy * dy + dz * dz };
      }).sort((a, b) => a.d - b.d || a.j - b.j).slice(0, 10).map((e) => e.j);
      expect(mapNeighbors(index, pos, q, 10)).toEqual(brute);
    }
  });
  it('同じ位置に重なった点があっても、自分自身だけを除く', () => {
    // 点 0 と 1 が同じ位置。点 1 の近傍には点 0 が入る
    const pos = new Float32Array([0, 0, 0, 0, 0, 0, 1, 0, 0, 2, 0, 0]);
    const index = new SpatialIndex(pos);
    expect(mapNeighbors(index, pos, 1, 2)).toEqual([0, 2]);
    expect(mapNeighbors(index, pos, 0, 2)).toEqual([1, 2]);
  });
});

describe('compareNeighbors', () => {
  it('元の空間での近傍のそれぞれが地図での近傍に含まれるかと、その数', () => {
    expect(compareNeighbors([5, 6, 7, 8], [8, 1, 5, 2])).toEqual({ inMap: [true, false, false, true], matches: 2 });
    expect(compareNeighbors([], [1])).toEqual({ inMap: [], matches: 0 });
  });
});

describe('要約の文', () => {
  it('数の文は「元のデータで近い N 点のうち、地図で近い N 点にも入っているのは M 点」', () => {
    expect(summaryCountText(3, 10)).toBe('元のデータで近い10点のうち、地図で近い10点にも入っているのは3点');
    expect(summaryCountText(0, 7)).toBe('元のデータで近い7点のうち、地図で近い7点にも入っているのは0点');
  });
  it('一致の割合で、この点の周りの地図がどの程度当てになるかの文が変わる', () => {
    expect(mapReliability(10, 10)).toBe('high');
    expect(mapReliability(7, 10)).toBe('high');
    expect(mapReliability(6, 10)).toBe('medium');
    expect(mapReliability(4, 10)).toBe('medium');
    expect(mapReliability(3, 10)).toBe('low');
    expect(mapReliability(0, 0)).toBe('low');
    for (const m of [7, 8, 10]) expect(summaryHintText(m, 10)).toBe('この点の周りでは、地図は元のデータの近さをよく表しています。');
    for (const m of [4, 5, 6]) expect(summaryHintText(m, 10)).toBe('この点の周りでは、地図は元のデータの近さを一部だけ表しています。');
    for (const m of [0, 1, 3]) expect(summaryHintText(m, 10)).toBe('地図で近く見える点も、元のデータでは近いとは限りません。');
  });
  it('一言は、周辺の全体ではなく、この点の周りについて述べる（「この辺り」を使わない）', () => {
    for (const m of [0, 5, 10]) expect(summaryText(m, 10)).not.toContain('この辺り');
  });
  it('全文は 1 文目と一言をつなげたもの。専門用語を使わない', () => {
    const t = summaryText(0, 10);
    expect(t).toBe(`${summaryCountText(0, 10)}。${summaryHintText(0, 10)}`);
    for (const m of [0, 5, 10]) {
      const s = summaryText(m, 10);
      for (const word of ['次元', '削減', '埋め込み', '近傍', 'UMAP']) expect(s).not.toContain(word);
    }
  });
  it('全文の実際の値の例', () => {
    expect(summaryText(8, 10)).toBe('元のデータで近い10点のうち、地図で近い10点にも入っているのは8点。この点の周りでは、地図は元のデータの近さをよく表しています。');
  });
  it('計算の途中の表示の間は、1 文目のあとに「計算前の地図での判定」を添える。終われば添えない', () => {
    expect(BEFORE_COMPUTE_NOTE).toBe('（計算前の地図での判定）');
    expect(summaryLeadText(4, 10)).toBe('元のデータで近い10点のうち、地図で近い10点にも入っているのは4点。');
    expect(summaryLeadText(4, 10, true)).toBe('元のデータで近い10点のうち、地図で近い10点にも入っているのは4点。（計算前の地図での判定）');
    expect(summaryText(4, 10, true)).toBe(`${summaryLeadText(4, 10, true)}${summaryHintText(4, 10)}`);
    expect(summaryText(4, 10, false)).not.toContain('計算前');
    expect(summaryText(4, 10)).not.toContain('計算前');
  });
  it('項目の読み上げの名前に、順位・名前・地図で近い点に入っているかが入る', () => {
    expect(neighborItemLabel(2, 'queen', true, 10)).toBe('2 番目に近い: queen、地図で近い10点にも入っている');
    expect(neighborItemLabel(1, 'kings', false, 10)).toBe('1 番目に近い: kings、地図で近い10点には入っていない');
    expect(neighborItemLabel(3, 'x', true)).toBe('3 番目に近い: x、地図で近い点にも入っている');
    expect(inMapPhrase(false)).toBe('地図で近い点には入っていない');
  });
});

describe('HUD の操作説明', () => {
  const base = { datasetName: 'x', pointCount: 1, pointSize: 0.004, speed: 0.4, viewParams: 'pos=0,0,0&look=0,0,1', mode: 'fly' as const };
  it('neighbors があるときだけ N キーの説明を含める', () => {
    expect(formatHud({ ...base, neighbors: true }).split('\n')[2]).toContain('N 元のデータで近い点');
    expect(formatHud({ ...base }).split('\n')[2]).not.toContain('N 元のデータ');
    expect(formatHud({ ...base, neighbors: false }).split('\n')[2]).not.toContain('N 元のデータ');
  });
});
