import { describe, expect, it } from 'vitest';
import { avoidObstacles, EDGE_MARKER_RADIUS, placeOnEdge, type EdgeMargins, type EdgeObstacle } from './edge';

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

  it('障害物を渡さないとき（空のとき）は、位置を変えない', () => {
    const a = placeOnEdge(3, 0, 1, W, H, 10);
    expect(placeOnEdge(3, 0, 1, W, H, 10, [])).toEqual(a);
  });
});

/** 印の見た目（中心から半径 EDGE_MARKER_RADIUS の正方形）が、障害物の矩形と重なるか */
const overlaps = (p: { x: number; y: number }, r: EdgeObstacle, radius = EDGE_MARKER_RADIUS): boolean =>
  Math.abs(p.x - r.x) < r.width / 2 + radius && Math.abs(p.y - r.y) < r.height / 2 + radius;

describe('placeOnEdge: 障害物の矩形を避ける', () => {
  const W = 1280, H = 800;
  const margin: EdgeMargins = { top: 50, right: 18, bottom: 18, left: 18 };
  // 左下の HUD、右下のミニマップ、右上の情報パネル（中心と大きさ）
  const hud: EdgeObstacle = { x: 12 + 300, y: H - 10 - 40, width: 600, height: 80 };
  const minimap: EdgeObstacle = { x: W - 12 - 100, y: H - 12 - 100, width: 200, height: 200 };
  const info: EdgeObstacle = { x: W - 12 - 200, y: 12 + 180, width: 400, height: 360 };
  const all = [hud, minimap, info];
  const inBounds = (p: { x: number; y: number }) => p.x >= margin.left - 1e-9 && p.x <= W - margin.right + 1e-9 && p.y >= margin.top - 1e-9 && p.y <= H - margin.bottom + 1e-9;

  it('障害物に隠れない位置は動かさない', () => {
    const p = placeOnEdge(0, 3, 1, W, H, margin, all); // 上の端の真ん中（どの障害物とも離れている）
    expect(p.onScreen).toBe(false);
    expect(p.x).toBeCloseTo(W / 2);
    expect(p.y).toBeCloseTo(margin.top);
  });

  it('左下の HUD に隠れる位置の印は、HUD の外側の縁へずれる（端の余白の内側のまま、重ならない）', () => {
    // 下の端の左寄り（HUD の真下）
    const raw = placeOnEdge(-0.6, -3, 1, W, H, margin);
    expect(overlaps(raw, hud)).toBe(true);
    const p = placeOnEdge(-0.6, -3, 1, W, H, margin, all);
    expect(overlaps(p, hud)).toBe(false);
    expect(inBounds(p)).toBe(true);
    expect(p.angle).toBeCloseTo(raw.angle); // 矢印の向きは変えない
  });

  it('右下のミニマップに隠れる位置の印は、ミニマップの外へずれる', () => {
    const raw = placeOnEdge(3, -2.3, 1, W, H, margin); // 右の端の下寄り
    expect(overlaps(raw, minimap)).toBe(true);
    const p = placeOnEdge(3, -2.3, 1, W, H, margin, all);
    for (const r of all) expect(overlaps(p, r)).toBe(false);
    expect(inBounds(p)).toBe(true);
  });

  it('カメラの後ろの点（真後ろは下を指す）も、HUD・ミニマップ・パネルの外に置く', () => {
    for (const [x, y] of [[0, 0], [0.5, 0], [-0.5, 0], [1, 1], [-1, 1], [1, -1], [-1, -1], [0, 1], [0, -1]]) {
      const p = placeOnEdge(x!, y!, -1, W, H, margin, all);
      for (const r of all) expect(overlaps(p, r), `(${x}, ${y})`).toBe(false);
      expect(inBounds(p)).toBe(true);
    }
  });

  it('全方向の点（画面の外）で、どの障害物にも重ならず、余白の内側にある', () => {
    for (let a = 0; a < 360; a += 5) {
      const rad = (a * Math.PI) / 180;
      const p = placeOnEdge(Math.cos(rad) * 5, Math.sin(rad) * 5, 1, W, H, margin, all);
      expect(p.onScreen).toBe(false);
      for (const r of all) expect(overlaps(p, r), `${a}°`).toBe(false);
      expect(inBounds(p)).toBe(true);
    }
  });

  it('縦の短い画面で、情報パネルが右の端を覆っても、パネルの左へ逃げる', () => {
    const w = 1280, h = 480;
    const panel: EdgeObstacle = { x: w - 12 - 200, y: h / 2, width: 400, height: h - 24 };
    const p = placeOnEdge(3, 0, 1, w, h, margin, [panel]);
    expect(overlaps(p, panel)).toBe(false);
    expect(p.x).toBeLessThan(panel.x - panel.width / 2);
  });

  it('空いた位置がなければ元の位置を返す（画面を覆うパネル）', () => {
    const cover: EdgeObstacle = { x: W / 2, y: H / 2, width: W, height: H };
    const raw = placeOnEdge(3, 0, 1, W, H, margin);
    expect(placeOnEdge(3, 0, 1, W, H, margin, [cover])).toEqual(raw);
  });
});

describe('avoidObstacles', () => {
  const bounds = { left: 0, top: 0, right: 100, bottom: 100 };
  it('矩形に入っていなければそのまま', () => {
    expect(avoidObstacles(5, 5, [{ x: 80, y: 80, width: 20, height: 20 }], bounds, 5)).toEqual({ x: 5, y: 5 });
  });
  it('矩形（広げたもの）に入っていれば、最も近い外側の縁へ、片方の座標だけずらす', () => {
    const r = { x: 50, y: 50, width: 20, height: 20 };
    const p = avoidObstacles(50, 58, [r], bounds, 5);
    // 広げた矩形は x 35..65, y 35..65。下の縁（y = 65.5）が最も近い
    expect(p.x).toBe(50);
    expect(p.y).toBeCloseTo(65.5);
  });
  it('2 つの矩形が並んでいるときは、両方を避ける', () => {
    const rs = [{ x: 30, y: 50, width: 40, height: 20 }, { x: 70, y: 50, width: 40, height: 20 }];
    const p = avoidObstacles(50, 50, rs, bounds, 5);
    for (const r of rs) expect(Math.abs(p.x - r.x) < r.width / 2 + 5 && Math.abs(p.y - r.y) < r.height / 2 + 5).toBe(false);
  });
});
