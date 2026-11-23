import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  DEFAULT_SELECT_PARAMS, rectsOverlap, selectWords, stepOpacities, type SelectInput, type WordBox, type WordSelectParams,
} from './selection';

const W = 1000, H = 800;

/** 原点から -Z を見るカメラ（縦の視野 60°）。 */
function view(position = new THREE.Vector3(0, 0, 0), look = new THREE.Vector3(0, 0, -1)) {
  const cam = new THREE.PerspectiveCamera(60, W / H, 0.001, 100);
  cam.position.copy(position);
  cam.lookAt(look);
  cam.updateMatrixWorld();
  return { view: cam.matrixWorldInverse.elements, projection: cam.projectionMatrix.elements, width: W, height: H };
}
/** 1 単位の奥行きでの画面上のピクセル（縦） */
const PX_AT_1 = 0.5 * H / Math.tan(Math.PI / 6);

/** 幅 2 em・高さ 1 em の単語（中央が基準点） */
const BOX: WordBox = { left: -1, right: 1, top: 0.5, bottom: -0.5 };

function input(points: number[][], over: Partial<SelectInput> = {}, params: Partial<WordSelectParams> = {}): SelectInput {
  const positions = points.flat();
  return {
    candidates: points.map((_, i) => i),
    positions,
    view: view(),
    emWorld: 0.01,
    nearLimit: 0.05,
    box: () => BOX,
    shown: new Set(),
    params: { ...DEFAULT_SELECT_PARAMS, ...params },
    ...over,
  };
}
const ids = (r: ReturnType<typeof selectWords>) => r.words.map((w) => w.index).sort((a, b) => a - b);

describe('selectWords（視錐台・距離・大きさ）', () => {
  it('カメラの後ろ・視錐台の外・近接フェードより内側の単語を外す', () => {
    const r = selectWords(input([
      [0, 0, -0.5],   // 0: 正面
      [0, 0, 0.5],    // 1: 後ろ
      [5, 0, -0.5],   // 2: 右の視錐台の外
      [0, 0, -0.03],  // 3: 近すぎる（nearLimit 0.05 より内側）
    ]));
    expect(ids(r)).toEqual([0]);
  });
  it('画面上の文字の高さが minTextPx 未満の単語を外す', () => {
    // 文字の高さ = emWorld × PX_AT_1 / 奥行き。9px になる奥行き
    const d9 = 0.01 * PX_AT_1 / 9;
    const r = selectWords(input([[0, 0, -d9 * 0.95], [0.5, 0, -d9 * 1.05]]));
    expect(ids(r)).toEqual([0]);
    expect(r.words[0]!.textPx).toBeGreaterThanOrEqual(9);
  });
  it('矩形の大きさと位置は、文字の高さと単語の矩形から決まる（基準点が画面の中央）', () => {
    const r = selectWords(input([[0, 0, -0.5]]));
    const w = r.words[0]!;
    const px = 0.01 * PX_AT_1 / 0.5;
    expect(w.textPx).toBeCloseTo(px, 6);
    expect(w.rect.x).toBeCloseTo(W / 2, 6);
    expect(w.rect.y).toBeCloseTo(H / 2, 6);
    expect(w.rect.width).toBeCloseTo(2 * px, 6);
    expect(w.rect.height).toBeCloseTo(px, 6);
  });
});

describe('selectWords（重なりと上限）', () => {
  it('近い順に、画面上で重なる単語を除く', () => {
    const r = selectWords(input([
      [0, 0, -0.5],       // 0: 近い
      [0.001, 0, -0.52],  // 1: ほぼ同じ方向で少し奥（重なる）
      [0.2, 0, -0.5],     // 2: 離れている
    ]));
    expect(ids(r)).toEqual([0, 2]);
    for (const a of r.words) for (const b of r.words) if (a !== b) expect(rectsOverlap(a.rect, b.rect)).toBe(false);
  });
  it('表示する数は maxWords 個まで（近いものから）', () => {
    const pts: number[][] = [];
    for (let i = 0; i < 50; i++) pts.push([(i % 10 - 4.5) * 0.08, (Math.floor(i / 10) - 2) * 0.08, -0.6 - i * 0.001]);
    const r = selectWords(input(pts, {}, { maxWords: 12 }));
    expect(r.words).toHaveLength(12);
    // カメラ（原点）からの距離の近い順に 12 個（この配置では互いに重ならない）
    const byDistance = pts.map((p, i) => ({ i, d: Math.hypot(p[0]!, p[1]!, p[2]!) })).sort((a, b) => a.d - b.d).slice(0, 12).map((x) => x.i);
    expect(ids(r)).toEqual(byDistance.sort((a, b) => a - b));
  });
  it('多数の単語でも、残した単語の矩形は互いに重ならない', () => {
    let s = 7;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const pts = Array.from({ length: 1500 }, () => [rnd() - 0.5, rnd() - 0.5, -0.2 - rnd() * 0.8]);
    const r = selectWords(input(pts));
    expect(r.words.length).toBeGreaterThan(20);
    expect(r.words.length).toBeLessThanOrEqual(DEFAULT_SELECT_PARAMS.maxWords);
    for (let i = 0; i < r.words.length; i++) for (let j = i + 1; j < r.words.length; j++) {
      expect(rectsOverlap(r.words[i]!.rect, r.words[j]!.rect)).toBe(false);
    }
  });
});

describe('selectWords（フレーム間の安定）', () => {
  it('距離の順位が少し入れ替わっても、表示中の単語が残る（stickiness を超えて近くなれば入れ替わる）', () => {
    const near = [0, 0, -0.5], far = [0.001, 0, -0.55];
    // 1 が表示中で、0 のほうが 10% 近い → 1 が残る
    expect(ids(selectWords(input([near, far], { shown: new Set([1]) })))).toEqual([1]);
    // 表示中でなければ近い 0
    expect(ids(selectWords(input([near, far])))).toEqual([0]);
    // 0 が 30% 近くなれば入れ替わる
    expect(ids(selectWords(input([[0, 0, -0.38], far], { shown: new Set([1]) })))).toEqual([0]);
  });
  it('文字の高さの閾値に幅がある（表示中は keepMinTextPx まで残す）', () => {
    const d = 0.01 * PX_AT_1 / 8.5; // 8.5px
    expect(ids(selectWords(input([[0, 0, -d]])))).toEqual([]);
    expect(ids(selectWords(input([[0, 0, -d]], { shown: new Set([0]) })))).toEqual([0]);
  });
  it('間隔の閾値に幅がある（新しく出すには gapPx、表示中どうしは接するまで）', () => {
    // 2 つの単語の矩形の間隔が 1px（gapPx より狭いが、重ならない）
    const px = 0.01 * PX_AT_1 / 0.5; // 文字の高さ
    const dx = (2 * px + 1) / PX_AT_1 * 0.5; // 中心の間隔 = 幅 + 1px
    const pts = [[0, 0, -0.5], [dx, 0, -0.5]];
    expect(ids(selectWords(input(pts)))).toEqual([0]);
    expect(ids(selectWords(input(pts, { shown: new Set([0, 1]) })))).toEqual([0, 1]);
  });
  it('同じ入力からは同じ結果になり、結果を前回として渡し直しても変わらない', () => {
    let s = 3;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const pts = Array.from({ length: 800 }, () => [rnd() - 0.5, rnd() - 0.5, -0.2 - rnd() * 0.8]);
    const a = selectWords(input(pts));
    const b = selectWords(input(pts, { shown: new Set(a.words.map((w) => w.index)) }));
    expect(ids(b)).toEqual(ids(a));
    const c = selectWords(input(pts, { shown: new Set(b.words.map((w) => w.index)) }));
    expect(ids(c)).toEqual(ids(b));
  });
  it('カメラを小さく往復させても（最も近い点の画面上の振れが 2px 程度）、表示する単語が切り替わり続けない', () => {
    let s = 11;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const pts = Array.from({ length: 1500 }, () => [rnd() - 0.5, rnd() - 0.5, -0.1 - rnd() * 0.9]);
    let shown = new Set<number>();
    const history: string[] = [];
    for (let k = 0; k < 40; k++) {
      const x = (k % 2 === 0 ? 1 : -1) * 0.00015; // 奥行き 0.1 の点で ±1px
      const r = selectWords(input(pts, { shown, view: view(new THREE.Vector3(x, 0, 0), new THREE.Vector3(x, 0, -1)) }));
      shown = new Set(r.words.map((w) => w.index));
      history.push([...shown].sort((a, b) => a - b).join(','));
    }
    // 最初の数回で落ち着き、そのあとは同じ集合（往復の両端で同じ）
    const tail = history.slice(10);
    expect(new Set(tail).size).toBe(1);
  });
});

describe('stepOpacities（切り替えの不透明度）', () => {
  it('表示する単語は 0 から 1 へ、外れた単語は 0 へ近づけ、0 になったら取り除く', () => {
    const op = new Map<number, number>();
    expect(stepOpacities(op, new Set([1, 2]), 0.1, 0.2)).toBe(true);
    expect(op.get(1)).toBeCloseTo(0.5);
    stepOpacities(op, new Set([1, 2]), 0.1, 0.2);
    expect(op.get(1)).toBe(1);
    expect(stepOpacities(op, new Set([1, 2]), 0.1, 0.2)).toBe(false);
    stepOpacities(op, new Set([2]), 0.1, 0.2);
    expect(op.get(1)).toBeCloseTo(0.5);
    stepOpacities(op, new Set([2]), 0.1, 0.2);
    expect(op.has(1)).toBe(false);
    expect(op.get(2)).toBe(1);
  });
  it('消えていく途中で再び表示されれば、その不透明度から戻る', () => {
    const op = new Map([[1, 1]]);
    stepOpacities(op, new Set(), 0.05, 0.2);
    expect(op.get(1)).toBeCloseTo(0.75);
    stepOpacities(op, new Set([1]), 0.05, 0.2);
    expect(op.get(1)).toBe(1);
  });
});
