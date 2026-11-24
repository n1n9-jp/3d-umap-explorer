import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { DOT_CLEARANCE_MARGIN_PX, DOT_CLEARANCE_SCALE, pointsNearRects } from './clearance';
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
