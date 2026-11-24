import { describe, expect, it } from 'vitest';
import { placeOnEdge } from './edge';

describe('placeOnEdge', () => {
  const W = 800, H = 600;
  it('画面の中の点は、投影した位置で onScreen', () => {
    const p = placeOnEdge(0.5, -0.5, 1, W, H, 10);
    expect(p.onScreen).toBe(true);
    expect(p.x).toBeCloseTo(600);
    expect(p.y).toBeCloseTo(450);
  });
  it('画面の右の外の点は、右の端から余白の内側に、方向を保って置く', () => {
    const p = placeOnEdge(3, 0, 1, W, H, 10);
    expect(p.onScreen).toBe(false);
    expect(p.behind).toBe(false);
    expect(p.x).toBeCloseTo(790);
    expect(p.y).toBeCloseTo(300);
    expect(p.angle).toBeCloseTo(0);
  });
  it('斜めの外の点は、中心からの方向の線と、内側の矩形の交点', () => {
    const p = placeOnEdge(4, 4, 1, W, H, { top: 50, right: 10, bottom: 10, left: 10 });
    // 画面の座標で右上（vx = 4*400, vy = -4*300）。上の余白 50 で止まる
    const t = Math.min(390 / 1600, 250 / 1200);
    expect(p.x).toBeCloseTo(400 + 1600 * t);
    expect(p.y).toBeCloseTo(300 - 1200 * t);
    expect(p.y).toBeCloseTo(50);
  });
  it('カメラの後ろの点は、割らずに x, y の向きを方向にする（右後ろなら右の端）', () => {
    const p = placeOnEdge(0.5, 0, -1, W, H, 10);
    expect(p.onScreen).toBe(false);
    expect(p.behind).toBe(true);
    expect(p.x).toBeCloseTo(790);
    expect(p.y).toBeCloseTo(300);
  });
  it('真後ろの点は下を指す', () => {
    const p = placeOnEdge(0, 0, -1, W, H, 10);
    expect(p.behind).toBe(true);
    expect(p.x).toBeCloseTo(400);
    expect(p.y).toBeCloseTo(590);
  });
});
