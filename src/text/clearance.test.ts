import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { DOT_CLEARANCE_MARGIN_PX, DOT_CLEARANCE_SCALE, pointsNearRects, pointsNearRectsIndexed } from './clearance';
import { SpatialIndex } from '../spatial/SpatialIndex';
import { DOTS_ONLY_MAX_RADIUS_PX } from '../render/pointCloud';
import { DEFAULT_TEXT_SIZE } from './selection';

const W = 1000, H = 800;
const cam = new THREE.PerspectiveCamera(60, W / H, 0.001, 100);
cam.lookAt(new THREE.Vector3(0, 0, -1));
cam.updateMatrixWorld();
const view = { view: cam.matrixWorldInverse.elements, projection: cam.projectionMatrix.elements, width: W, height: H };
/** 1 単位の奥行きでの画面上のピクセル */
const PX_AT_1 = 0.5 * H / Math.tan(Math.PI / 6);
/** 画面上の位置 (x, y)（CSS ピクセル）に、奥行き 1 で投影される点 */
const at = (x: number, y: number) => [(x - W / 2) / PX_AT_1, -(y - H / 2) / PX_AT_1, -1];

describe('pointsNearRects（単語の矩形の近くの丸い点）', () => {
  const rect = { x: 500, y: 400, width: 60, height: 14 };
  const points = [
    at(500, 400), // 0: 矩形の中
    at(529, 406), // 1: 矩形の中（角の近く）
    at(530 + DOT_CLEARANCE_MARGIN_PX - 0.5, 400), // 2: 広げた範囲の中
    at(530 + DOT_CLEARANCE_MARGIN_PX + 1, 400), // 3: 広げた範囲の外
    at(500, 300), // 4: 遠い
    [0, 0, 1], // 5: カメラの後ろ
  ];
  const positions = points.flat();
  const candidates = points.map((_, i) => i);

  it('矩形を広げた範囲に中心が入る点だけを選ぶ（カメラの後ろは除く）', () => {
    const got = pointsNearRects(candidates, positions, view, [rect], DOT_CLEARANCE_MARGIN_PX, new Set());
    expect([...got].sort()).toEqual([0, 1, 2]);
  });
  it('文字を出している点は除く', () => {
    const got = pointsNearRects(candidates, positions, view, [rect], DOT_CLEARANCE_MARGIN_PX, new Set([0]));
    expect([...got].sort()).toEqual([1, 2]);
  });
  it('単語がなければ何も選ばない', () => {
    expect(pointsNearRects(candidates, positions, view, [], DOT_CLEARANCE_MARGIN_PX, new Set()).size).toBe(0);
  });
  it('候補に null を渡すと全点から選ぶ', () => {
    const got = pointsNearRects(null, positions, view, [rect], DOT_CLEARANCE_MARGIN_PX, new Set());
    expect([...got].sort()).toEqual([0, 1, 2]);
  });
  it('複数の矩形のどれかに入れば選ぶ', () => {
    const got = pointsNearRects(candidates, positions, view, [rect, { x: 500, y: 300, width: 10, height: 10 }], 0, new Set());
    expect([...got].sort()).toEqual([0, 1, 4]);
  });
  it('小さくした丸い点の直径の上限は、文字の高さの下限の半分より小さい', () => {
    expect(2 * DOTS_ONLY_MAX_RADIUS_PX * DOT_CLEARANCE_SCALE).toBeLessThan(DEFAULT_TEXT_SIZE.minPx / 2);
  });
});

/** 決まった乱数（テストを再現できるように）。 */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

describe('pointsNearRectsIndexed（空間索引で絞った結果が、全点を調べた結果と一致する）', () => {
  const rand = rng(12345);
  const N = 6000;
  const pos = new Float32Array(3 * N);
  // 球の中に一様ではなく、塊をいくつか作る
  for (let i = 0; i < N; i++) {
    const c = i % 5;
    for (let k = 0; k < 3; k++) pos[3 * i + k] = (c - 2) * 0.35 * (k === 0 ? 1 : 0.3) + (rand() - 0.5) * (0.2 + 0.1 * c);
  }
  const index = new SpatialIndex(pos);

  const viewFor = (camPos: [number, number, number], target: [number, number, number], fov = 60, w = 1000, h = 800, near = 0.0005, far = 12) => {
    const camera = new THREE.PerspectiveCamera(fov, w / h, near, far);
    camera.position.set(...camPos);
    camera.lookAt(new THREE.Vector3(...target));
    camera.updateMatrixWorld();
    return { view: camera.matrixWorldInverse.elements, projection: camera.projectionMatrix.elements, width: w, height: h };
  };
  const randomRects = (n: number, w: number, h: number) =>
    Array.from({ length: n }, () => ({ x: rand() * w, y: rand() * h, width: 20 + rand() * 100, height: 8 + rand() * 20 }));

  it('いろいろな視点・矩形で、全点を調べた結果と一致する（カメラの後ろ・点群の内部・外を含む）', () => {
    const cams: { cam: [number, number, number]; look: [number, number, number] }[] = [
      { cam: [0, 0, 2], look: [0, 0, 0] }, // 外から全体を
      { cam: [0.1, 0.02, 0.05], look: [0.5, 0, 0] }, // 内部
      { cam: [0.1, 0.02, 0.05], look: [-0.5, 0.1, 0.1] }, // 内部で、向きを変える
      { cam: [-0.3, 0.1, 0], look: [0.6, -0.1, 0.2] },
      { cam: [0, 0, 2], look: [0, 0, 5] }, // 点群に背を向ける
    ];
    let nonEmpty = 0;
    for (const { cam, look } of cams) {
      const v = viewFor(cam, look);
      for (const count of [1, 3, 40, 200]) {
        const rects = randomRects(count, v.width, v.height);
        const exclude = new Set<number>([0, 7, 100, 4000]);
        const all = pointsNearRects(null, pos, v, rects, DOT_CLEARANCE_MARGIN_PX, exclude);
        const got = pointsNearRectsIndexed(index, v, rects, DOT_CLEARANCE_MARGIN_PX, exclude);
        expect([...got].sort((a, b) => a - b)).toEqual([...all].sort((a, b) => a - b));
        if (all.size > 0) nonEmpty++;
      }
    }
    expect(nonEmpty).toBeGreaterThan(8);
  });
  it('矩形が画面の端や外にあっても、全点の場合と一致する', () => {
    const v = viewFor([0.1, 0, 0.05], [0.5, 0.02, 0]);
    const rects = [
      { x: 0, y: 0, width: 40, height: 20 },
      { x: v.width, y: v.height, width: 60, height: 20 },
      { x: -50, y: 400, width: 30, height: 10 },
      { x: 500, y: 400, width: 0.5, height: 0.5 },
    ];
    const all = pointsNearRects(null, pos, v, rects, DOT_CLEARANCE_MARGIN_PX, new Set());
    const got = pointsNearRectsIndexed(index, v, rects, DOT_CLEARANCE_MARGIN_PX, new Set());
    expect([...got].sort((a, b) => a - b)).toEqual([...all].sort((a, b) => a - b));
  });
  it('矩形がなければ空', () => {
    expect(pointsNearRectsIndexed(index, viewFor([0, 0, 2], [0, 0, 0]), [], DOT_CLEARANCE_MARGIN_PX, new Set()).size).toBe(0);
  });
  it('点が少ない（葉 1 つ）でも一致する', () => {
    const small = new Float32Array([0, 0, -1, 0.01, 0, -1, 0, 0.01, -1]);
    const v = viewFor([0, 0, 0], [0, 0, -1]);
    const rects = [{ x: 500, y: 400, width: 30, height: 10 }];
    const got = pointsNearRectsIndexed(new SpatialIndex(small), v, rects, DOT_CLEARANCE_MARGIN_PX, new Set());
    expect([...got].sort()).toEqual([...pointsNearRects(null, small, v, rects, DOT_CLEARANCE_MARGIN_PX, new Set())].sort());
  });
  it('矩形が小さければ、木の巡回で調べる点の数は全点よりずっと少ない', () => {
    const v = viewFor([0, 0, 2], [0, 0, 0]);
    let visited = 0;
    const counting = { forEachInBoxes: (may: Parameters<SpatialIndex['forEachInBoxes']>[0], visit: Parameters<SpatialIndex['forEachInBoxes']>[1]) => index.forEachInBoxes(may, (...a) => { visited++; visit(...a); }) };
    pointsNearRectsIndexed(counting, v, [{ x: 500, y: 400, width: 30, height: 10 }], DOT_CLEARANCE_MARGIN_PX, new Set());
    expect(visited).toBeLessThan(N / 4);
  });
});
