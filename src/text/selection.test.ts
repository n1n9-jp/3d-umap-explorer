import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  DEFAULT_SELECT_PARAMS, DEFAULT_TEXT_SIZE, NATURAL_TEXT_SIZE, placeWordRect, rectsOverlap, selectWords, stepOpacities, textSizePx,
  type SelectInput, type WordBox, type WordSelectParams,
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
    // 既存の判定は、透視投影のままの大きさ（写さない）と、閾値 9px・8px で確かめる
    params: { ...DEFAULT_SELECT_PARAMS, minNaturalPx: 9, keepMinNaturalPx: 8, size: NATURAL_TEXT_SIZE, ...params },
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
  it('画面上の文字の高さが minNaturalPx 未満の単語を外す', () => {
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
  it('文字の高さの閾値に幅がある（表示中は keepMinNaturalPx まで残す）', () => {
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

describe('textSizePx（文字の高さの写し方）', () => {
  const p = DEFAULT_TEXT_SIZE;
  it('下限と上限で止め、その間は単調に増える（近いほど大きい）', () => {
    expect(textSizePx(2, p)).toBe(p.minPx);
    expect(textSizePx(500, p)).toBe(p.maxPx);
    let prev = 0;
    for (let n = 1; n <= 200; n += 0.5) {
      const v = textSizePx(n, p);
      expect(v).toBeGreaterThanOrEqual(prev);
      expect(v).toBeGreaterThanOrEqual(p.minPx);
      expect(v).toBeLessThanOrEqual(p.maxPx);
      prev = v;
    }
    expect(textSizePx(30, p)).toBeGreaterThan(textSizePx(20, p));
  });
  it('近くと遠くの大きさの差を縮める（自然な大きさの比 8 倍が、2 倍程度になる）', () => {
    const near = textSizePx(72, p), far = textSizePx(9, p);
    expect(near / far).toBeLessThan(2.5);
    expect(far).toBeGreaterThanOrEqual(12);
  });
  it('基準の高さでは自然な大きさのまま。写さない設定では恒等', () => {
    expect(textSizePx(p.referencePx, p)).toBeCloseTo(p.referencePx, 9);
    expect(textSizePx(37.5, NATURAL_TEXT_SIZE)).toBe(37.5);
    expect(textSizePx(0, p)).toBe(0);
  });
});

describe('selectWords（文字の高さの写し方と障害物）', () => {
  it('矩形は写したあとの大きさ。閾値は自然な大きさで判定する', () => {
    const size = DEFAULT_TEXT_SIZE;
    // 自然な大きさ 6px（minNaturalPx 5 以上）と 4px（未満）
    const d6 = 0.01 * PX_AT_1 / 6, d4 = 0.01 * PX_AT_1 / 4;
    const r = selectWords(input([[0, 0, -d6], [0.3 * d4, 0, -d4]], {}, { minNaturalPx: 5, keepMinNaturalPx: 4.5, size }));
    expect(ids(r)).toEqual([0]);
    const w = r.words[0]!;
    expect(w.naturalPx).toBeCloseTo(6, 6);
    expect(w.textPx).toBe(size.minPx);
    expect(w.rect.height).toBeCloseTo(size.minPx, 6); // 単語の矩形の高さは 1 em
  });
  it('近い単語は上限の大きさで描く', () => {
    const r = selectWords(input([[0, 0, -0.06]], {}, { size: DEFAULT_TEXT_SIZE }));
    expect(r.words[0]!.naturalPx).toBeGreaterThan(DEFAULT_TEXT_SIZE.maxPx * 2);
    expect(r.words[0]!.textPx).toBe(DEFAULT_TEXT_SIZE.maxPx);
    expect(r.words[0]!.rect.width).toBeCloseTo(2 * DEFAULT_TEXT_SIZE.maxPx, 6);
  });
  it('障害物（UI の領域）と重なる単語は出さない。間隔 obstacleGapPx を含める', () => {
    // 画面の中央の単語（高さ約 27.7px、幅 55.4px）
    const base = selectWords(input([[0, 0, -0.5]]));
    const rect = base.words[0]!.rect;
    const covering = { x: rect.x + rect.width / 2 + 10, y: rect.y, width: 22, height: 10 }; // 右端に 1px 重なる
    expect(ids(selectWords(input([[0, 0, -0.5]], { obstacles: [covering] })))).toEqual([]);
    const near = { ...covering, x: covering.x + 3 }; // 2px 離れる（間隔 4 より狭い）
    expect(ids(selectWords(input([[0, 0, -0.5]], { obstacles: [near] }, { obstacleGapPx: 4 })))).toEqual([]);
    const far = { ...covering, x: covering.x + 6 }; // 5px 離れる
    expect(ids(selectWords(input([[0, 0, -0.5]], { obstacles: [far] }, { obstacleGapPx: 4 })))).toEqual([0]);
  });
  it('新しく出す単語は、画面の端で切れるものを出さない（表示中なら残す）', () => {
    // 基準点は画面の内側だが、矩形（幅 2 em）が右端からはみ出す位置
    const z = -0.5, px = 0.01 * PX_AT_1 / 0.5; // 1 em の画面上の大きさ（約 13.9px。単語の幅は 2 em）
    const ndcX = 1 - (0.5 * px) / (W / 2); // 右端から 0.5 em 内側
    const x = ndcX * Math.tan(Math.PI / 6) * (W / H) * -z;
    expect(ids(selectWords(input([[x, 0, z]])))).toEqual([]);
    expect(ids(selectWords(input([[x, 0, z]], { shown: new Set([0]) })))).toEqual([0]);
    // 表示中でも、はみ出し（0.5 em ≈ 6.9px）が余白（画面の半分 × keepFrustumMargin）を超えれば外す
    expect(ids(selectWords(input([[x, 0, z]], { shown: new Set([0]) }, { keepFrustumMargin: 0.02 })))).toEqual([0]); // 余白 10px
    expect(ids(selectWords(input([[x, 0, z]], { shown: new Set([0]) }, { keepFrustumMargin: 0.01 })))).toEqual([]); // 余白 5px
  });
  it('障害物に隠れた単語の代わりに、ほかの単語が残る', () => {
    const r0 = selectWords(input([[0, 0, -0.5], [0.15, 0, -0.5]]));
    const left = r0.words.find((w) => w.index === 0)!.rect;
    const r = selectWords(input([[0, 0, -0.5], [0.15, 0, -0.5]], { obstacles: [left] }));
    expect(ids(r)).toEqual([1]);
  });
});

describe('placeWordRect（いまの視点での矩形）', () => {
  it('選んだときの矩形と、同じ視点なら一致する', () => {
    const pts = [[0.02, 0.01, -0.4], [-0.05, 0.03, -0.9]];
    const r = selectWords(input(pts, {}, { size: DEFAULT_TEXT_SIZE, minNaturalPx: 5, keepMinNaturalPx: 4.5 }));
    expect(r.words.length).toBe(2);
    for (const w of r.words) {
      const p = placeWordRect(view(), pts[w.index]![0]!, pts[w.index]![1]!, pts[w.index]![2]!, BOX, 0.01, DEFAULT_TEXT_SIZE)!;
      expect(p.rect.x).toBeCloseTo(w.rect.x, 9);
      expect(p.rect.y).toBeCloseTo(w.rect.y, 9);
      expect(p.rect.width).toBeCloseTo(w.rect.width, 9);
      expect(p.textPx).toBeCloseTo(w.textPx, 9);
    }
  });
  it('カメラが回ると、矩形はいまの視点の位置へ動く。カメラの後ろに回れば null', () => {
    const p = [0, 0, -0.5];
    const a = placeWordRect(view(), p[0]!, p[1]!, p[2]!, BOX, 0.01, DEFAULT_TEXT_SIZE)!;
    expect(a.anchorX).toBeCloseTo(W / 2, 6);
    const turned = view(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.2, 0, -1)); // 右へ向く → 点は左へ動く
    const b = placeWordRect(turned, p[0]!, p[1]!, p[2]!, BOX, 0.01, DEFAULT_TEXT_SIZE)!;
    expect(b.anchorX).toBeLessThan(a.anchorX - 50);
    const back = view(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 1)); // 真後ろを向く
    expect(placeWordRect(back, p[0]!, p[1]!, p[2]!, BOX, 0.01, DEFAULT_TEXT_SIZE)).toBeNull();
  });
});

describe('selectWords（カメラが速く動く間の余裕）', () => {
  const params = { size: DEFAULT_TEXT_SIZE, minNaturalPx: 5, keepMinNaturalPx: 4.5 };
  it('障害物との間隔に motionMarginPx を足す（新しく出す単語も、表示中の単語も、動いて重なる手前から外す）', () => {
    const pts = [[0, 0, -0.5]];
    const base = selectWords(input(pts, {}, params));
    const w = base.words[0]!;
    // 矩形の右端から 20px 離れた障害物
    const obstacle = { x: w.rect.x + w.rect.width / 2 + 20 + 10, y: w.rect.y, width: 20, height: 20 };
    const none = selectWords(input(pts, { obstacles: [obstacle] }, params));
    expect(ids(none)).toEqual([0]);
    const margin = selectWords(input(pts, { obstacles: [obstacle], motionMarginPx: 30 }, params));
    expect(ids(margin)).toEqual([]);
    const keptNone = selectWords(input(pts, { obstacles: [obstacle], shown: new Set([0]) }, params));
    expect(ids(keptNone)).toEqual([0]);
    const keptMargin = selectWords(input(pts, { obstacles: [obstacle], shown: new Set([0]), motionMarginPx: 30 }, params));
    expect(ids(keptMargin)).toEqual([]);
  });
  it('余裕が 0 や負なら、これまでと同じ', () => {
    const pts = [[0, 0, -0.5], [0.05, 0, -0.7]];
    const a = selectWords(input(pts, {}, params));
    expect(ids(selectWords(input(pts, { motionMarginPx: 0 }, params)))).toEqual(ids(a));
    expect(ids(selectWords(input(pts, { motionMarginPx: -5 }, params)))).toEqual(ids(a));
  });
});
