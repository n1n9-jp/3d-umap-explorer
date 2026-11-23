import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { computeHomeView } from '../app/homeView';
import type { Vec3 } from '../render/view';
import {
  clampRange, clampToFrame, computeExtent, computeLayout, convexHull, depthFacing, depthHistogram, depthToGauge, describeMinimapStatus,
  FACING_THRESHOLD, fromPlane, mapToPlane, minimapBasis, planeToMap, sampleIndices, toPlane, viewFigure, withMinimapHelp,
  GAUGE_GAP, GAUGE_WIDTH, LAYOUT_MARGIN, MAP_SIZE_MAX, MAP_SIZE_MIN,
} from './geometry';

const MNIST_AXES: [Vec3, Vec3, Vec3] = [[0.935867, 0.243862, 0.254331], [-0.237131, 0.969787, -0.057293], [-0.260618, -0.006691, 0.965419]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

describe('minimapBasis', () => {
  it('overview がなければ +Z から見る（横 +X、縦 +Y）', () => {
    const b = minimapBasis(null);
    expect(b.right[0]).toBeCloseTo(1); expect(b.up[1]).toBeCloseTo(1); expect(b.back[2]).toBeCloseTo(1);
  });

  it('正規直交の右手系で、ホームの視点のカメラの右・上・後ろと一致する', () => {
    const b = minimapBasis(MNIST_AXES);
    for (const v of [b.right, b.up, b.back]) expect(Math.hypot(...v)).toBeCloseTo(1, 9);
    expect(dot(b.right, b.up)).toBeCloseTo(0, 9);
    expect(dot(b.up, b.back)).toBeCloseTo(0, 9);
    // right × up = back
    const c: Vec3 = [b.right[1] * b.up[2] - b.right[2] * b.up[1], b.right[2] * b.up[0] - b.right[0] * b.up[2], b.right[0] * b.up[1] - b.right[1] * b.up[0]];
    for (let k = 0; k < 3; k++) expect(c[k]).toBeCloseTo(b.back[k]!, 9);

    const home = computeHomeView({ center: [0, 0, 0], radius: 1.14 }, 60, 16 / 10, MNIST_AXES);
    const cam = new PerspectiveCamera(60, 1.6);
    cam.position.set(...home.pos);
    cam.lookAt(new Vector3(...home.look));
    cam.updateMatrixWorld();
    const e = cam.matrixWorld.elements;
    const camRight: Vec3 = [e[0]!, e[1]!, e[2]!], camUp: Vec3 = [e[4]!, e[5]!, e[6]!], camBack: Vec3 = [e[8]!, e[9]!, e[10]!];
    expect(dot(camRight, b.right)).toBeCloseTo(1, 6);
    expect(dot(camUp, b.up)).toBeCloseTo(1, 6);
    expect(dot(camBack, b.back)).toBeCloseTo(1, 6);
    // 第1軸はおおむね横、第2軸はおおむね縦に並ぶ
    expect(dot(MNIST_AXES[0], b.right)).toBeGreaterThan(0.95);
    expect(dot(MNIST_AXES[1], b.up)).toBeGreaterThan(0.95);
  });
});

describe('面への投影と逆変換', () => {
  it('toPlane と fromPlane は互いに逆', () => {
    const b = minimapBasis(MNIST_AXES);
    const p: Vec3 = [0.3, -0.7, 0.45];
    const back = fromPlane(toPlane(p, b), b);
    for (let k = 0; k < 3; k++) expect(back[k]).toBeCloseTo(p[k]!, 9);
  });

  it('planeToMap と mapToPlane は互いに逆で、上が v の正', () => {
    const e = { center: [0.1, -0.2, 0] as Vec3, half: 0.5, depthRange: [-0.3, 0.3] as [number, number] };
    const [x, y] = planeToMap(0.3, 0.1, e, 200);
    const [u, v] = mapToPlane(x, y, e, 200);
    expect(u).toBeCloseTo(0.3); expect(v).toBeCloseTo(0.1);
    expect(planeToMap(0.1, -0.2, e, 200)).toEqual([100, 100]);
    expect(planeToMap(0.1, 0.3, e, 200)[1]).toBeCloseTo(0); // v 最大が上端
    expect(planeToMap(-0.4, -0.2, e, 200)[0]).toBeCloseTo(0); // u 最小が左端
  });

  it('奥行きの目盛りは上が手前（w が大きい）', () => {
    const e = { center: [0, 0, 0.2] as Vec3, half: 0.5, depthRange: [0, 0] as [number, number] };
    expect(depthToGauge(0.7, e, 200)).toBeCloseTo(0);
    expect(depthToGauge(-0.3, e, 200)).toBeCloseTo(200);
    expect(depthToGauge(0.2, e, 200)).toBeCloseTo(100);
  });
});

describe('computeExtent', () => {
  it('全点の投影が正方形の内側に収まり、余白を持つ', () => {
    const b = minimapBasis(MNIST_AXES);
    let s = 7;
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
    const pts = new Float32Array(3 * 500).map(() => rnd() * 0.8);
    const e = computeExtent(pts, b);
    let maxEdge = 0;
    for (let i = 0; i < 500; i++) {
      const q = toPlane([pts[3 * i]!, pts[3 * i + 1]!, pts[3 * i + 2]!], b);
      const [x, y] = planeToMap(q[0], q[1], e, 200);
      expect(x).toBeGreaterThan(0); expect(x).toBeLessThan(200);
      expect(y).toBeGreaterThan(0); expect(y).toBeLessThan(200);
      const g = depthToGauge(q[2], e, 200);
      expect(g).toBeGreaterThan(0); expect(g).toBeLessThan(200);
      maxEdge = Math.max(maxEdge, Math.abs(x - 100), Math.abs(y - 100), Math.abs(g - 100));
      expect(q[2]).toBeGreaterThanOrEqual(e.depthRange[0] - 1e-6);
      expect(q[2]).toBeLessThanOrEqual(e.depthRange[1] + 1e-6);
    }
    // 最も広い向きでは、余白 1.08 の分だけ内側（100 / 1.08）
    expect(maxEdge).toBeCloseTo(100 / 1.08, 3);
  });

  it('点がなくても有限の範囲', () => {
    const e = computeExtent(new Float32Array(0), minimapBasis(null));
    expect(e.half).toBeGreaterThan(0);
  });
});

describe('computeLayout', () => {
  it('右下に 200 ピクセル角、左脇に目盛り', () => {
    const l = computeLayout(1280, 800);
    expect(l.map).toEqual({ left: 1280 - LAYOUT_MARGIN - 200, top: 800 - LAYOUT_MARGIN - 200, width: 200, height: 200 });
    expect(l.gauge.left + l.gauge.width + GAUGE_GAP).toBe(l.map.left);
    expect(l.gauge.width).toBe(GAUGE_WIDTH);
    expect(l.outer.left).toBe(l.gauge.left);
    expect(l.outer.left + l.outer.width).toBe(l.map.left + l.map.width);
  });

  it('画面が小さいと縮み、下限を持つ', () => {
    expect(computeLayout(500, 400).map.width).toBe(120);
    expect(computeLayout(300, 200).map.width).toBe(MAP_SIZE_MIN);
    expect(computeLayout(4000, 3000).map.width).toBe(MAP_SIZE_MAX);
    for (const [w, h] of [[375, 667], [960, 640]]) {
      const l = computeLayout(w, h);
      expect(Number.isInteger(l.map.width)).toBe(true);
      expect(l.map.left + l.map.width).toBe(w - LAYOUT_MARGIN);
      expect(l.map.top + l.map.height).toBe(h - LAYOUT_MARGIN);
    }
  });
});

describe('clampToFrame / clampRange', () => {
  it('内側ならそのまま、外なら向きを保って縁に寄せる', () => {
    expect(clampToFrame(50, 60, 200, 7)).toEqual({ x: 50, y: 60, outside: false });
    const c = clampToFrame(500, 100, 200, 7);
    expect(c.outside).toBe(true);
    expect(c.x).toBeCloseTo(193); expect(c.y).toBeCloseTo(100);
    const d = clampToFrame(-300, -300, 200, 10);
    expect(d.x).toBeCloseTo(10); expect(d.y).toBeCloseTo(10);
  });

  it('範囲に収める', () => {
    expect(clampRange(5, 0, 10)).toEqual({ value: 5, outside: false });
    expect(clampRange(-1, 0, 10)).toEqual({ value: 0, outside: true });
    expect(clampRange(11, 0, 10)).toEqual({ value: 10, outside: true });
  });
});

describe('sampleIndices', () => {
  it('上限以下なら全点', () => {
    expect(Array.from(sampleIndices(5, 10))).toEqual([0, 1, 2, 3, 4]);
  });

  it('超えると等間隔に上限の数だけ、重複なく昇順に選ぶ', () => {
    const idx = sampleIndices(50000, 20000);
    expect(idx.length).toBe(20000);
    expect(idx[0]).toBe(0);
    for (let k = 1; k < idx.length; k++) expect(idx[k]!).toBeGreaterThan(idx[k - 1]!);
    expect(idx[idx.length - 1]!).toBeLessThan(50000);
    expect(sampleIndices(0).length).toBe(0);
  });
});

describe('viewFigure', () => {
  const b = minimapBasis(null); // 横 +X、縦 +Y、奥行き +Z
  it('面に平行な視線は、その向きの単位ベクトル（画面は下向きが y の正）', () => {
    const f = viewFigure({ forward: [0, 1, 0], right: [1, 0, 0], up: [0, 0, -1], fovDeg: 60, aspect: 1 }, b);
    expect(f.heading[0]).toBeCloseTo(0); expect(f.heading[1]).toBeCloseTo(-1);
    expect(f.headingLength).toBeCloseTo(1);
    // 扇の 4 隅は視線の側にあり、横に ±tan(30°) の広がり
    for (const c of f.corners) expect(c[1]).toBeLessThan(0);
    const xs = f.corners.map((c) => c[0]);
    expect(Math.max(...xs)).toBeGreaterThan(0.4);
    expect(Math.min(...xs)).toBeLessThan(-0.4);
    expect(f.hull.length).toBeGreaterThanOrEqual(3);
    expect(f.hull.some(([x, y]) => x === 0 && y === 0)).toBe(true); // カメラの位置が頂点
  });

  it('右を向けば右、斜めなら斜め', () => {
    const f = viewFigure({ forward: [1, 0, 0], right: [0, 0, 1], up: [0, 1, 0], fovDeg: 60, aspect: 1.6 }, b);
    expect(f.heading[0]).toBeCloseTo(1); expect(f.heading[1]).toBeCloseTo(0);
    const s = Math.SQRT1_2;
    const g = viewFigure({ forward: [-s, 0, -s], right: [s, 0, -s], up: [0, 1, 0], fovDeg: 60, aspect: 1 }, b);
    expect(g.heading[0]).toBeCloseTo(-1); expect(g.heading[1]).toBeCloseTo(0);
    expect(g.headingLength).toBeCloseTo(s);
  });

  it('奥行きの方向を向くと、向きは 0 で、扇はカメラを囲む', () => {
    const f = viewFigure({ forward: [0, 0, -1], right: [1, 0, 0], up: [0, 1, 0], fovDeg: 60, aspect: 1 }, b);
    expect(f.heading).toEqual([0, 0]);
    expect(f.headingLength).toBeCloseTo(0);
    expect(f.hull.length).toBe(4); // 原点は内側
  });
});

describe('depthFacing（手前向きか奥向きか）', () => {
  const b = minimapBasis(MNIST_AXES);
  const neg = (v: Vec3): Vec3 => [-v[0], -v[1], -v[2]];

  it('視線が面に垂直だと、投影した図形は手前向きでも奥向きでも同じ形になる（だから目盛りの側で区別する）', () => {
    const toward = viewFigure({ forward: b.back, right: neg(b.right), up: b.up, fovDeg: 60, aspect: 1.6 }, b);
    const away = viewFigure({ forward: neg(b.back), right: b.right, up: b.up, fovDeg: 60, aspect: 1.6 }, b);
    expect(toward.heading).toEqual([0, 0]);
    expect(away.heading).toEqual([0, 0]);
    // 隅の並びは左右が入れ替わるだけで、凸包の頂点の集合は同じ
    const key = (h: [number, number][]) => h.map(([x, y]) => `${x.toFixed(6)},${y.toFixed(6)}`).sort().join('|');
    expect(key(toward.hull)).toBe(key(away.hull));
    expect(depthFacing(b.back, b).facing).toBe('near');
    expect(depthFacing(neg(b.back), b).facing).toBe('far');
  });

  it('手前向きは成分が正、奥向きは負。面に平行なら横向き', () => {
    expect(depthFacing(b.back, b).component).toBeCloseTo(1, 9);
    expect(depthFacing(neg(b.back), b).component).toBeCloseTo(-1, 9);
    expect(depthFacing(b.right, b)).toMatchObject({ facing: 'level' });
    expect(depthFacing(b.up, b).component).toBeCloseTo(0, 9);
  });

  it('しきい値の前後で切り替わり、ベクトルの長さによらない', () => {
    const tilt = (k: number): Vec3 => [b.right[0] * Math.sqrt(1 - k * k) + b.back[0] * k, b.right[1] * Math.sqrt(1 - k * k) + b.back[1] * k, b.right[2] * Math.sqrt(1 - k * k) + b.back[2] * k];
    expect(depthFacing(tilt(FACING_THRESHOLD + 0.01), b).facing).toBe('near');
    expect(depthFacing(tilt(FACING_THRESHOLD - 0.01), b).facing).toBe('level');
    expect(depthFacing(tilt(-(FACING_THRESHOLD + 0.01)), b).facing).toBe('far');
    expect(depthFacing(tilt(-(FACING_THRESHOLD - 0.01)), b).facing).toBe('level');
    const long = tilt(0.5).map((x) => x * 7) as Vec3;
    expect(depthFacing(long, b).component).toBeCloseTo(0.5, 9);
    expect(depthFacing([0, 0, 0], b).facing).toBe('level'); // 長さ 0 でも壊れない
  });

  it('ホームの視点（奥を見下ろす）は奥向き', () => {
    const home = computeHomeView({ center: [0, 0, 0], radius: 1.14 }, 60, 1.6, MNIST_AXES);
    const f: Vec3 = [home.look[0] - home.pos[0], home.look[1] - home.pos[1], home.look[2] - home.pos[2]];
    expect(depthFacing(f, b).facing).toBe('far');
  });
});

describe('describeMinimapStatus（読み上げ用の説明）', () => {
  const base = { mapSize: 200, gaugeHeight: 200, facing: 'far' as const };
  it('地図の 3×3 と奥行きの 3 段で言う', () => {
    expect(describeMinimapStatus({ ...base, mapX: 100, mapY: 100, depthY: 100 })).toBe('現在位置: 地図の中央あたり、奥行きは中ほど。視線は奥向き。');
    expect(describeMinimapStatus({ ...base, mapX: 190, mapY: 10, depthY: 10 })).toBe('現在位置: 地図の右上あたり、奥行きは手前寄り。視線は奥向き。');
    expect(describeMinimapStatus({ ...base, mapX: 10, mapY: 100, depthY: 190, facing: 'near' })).toBe('現在位置: 地図の左あたり、奥行きは奥寄り。視線は手前向き。');
  });
  it('範囲の外にいることを言う', () => {
    const t = describeMinimapStatus({ ...base, mapX: 320, mapY: -40, depthY: -30, facing: 'level' });
    expect(t).toContain('地図の範囲の外');
    expect(t).toContain('目盛りの範囲の外（手前側）');
    expect(t).toContain('奥行きには水平な向き');
    expect(describeMinimapStatus({ ...base, mapX: 100, mapY: 100, depthY: 230 })).toContain('目盛りの範囲の外（奥側）');
  });
});

describe('convexHull', () => {
  it('内側の点を除く', () => {
    const h = convexHull([[0, 0], [1, 0], [1, 1], [0, 1], [0.5, 0.5]]);
    expect(h).toHaveLength(4);
    expect(h).not.toContainEqual([0.5, 0.5]);
  });
});

describe('depthHistogram', () => {
  it('最大の区間が 1、奥（w が小さい）から順', () => {
    const b = minimapBasis(null);
    const pts = new Float32Array([0, 0, -0.9, 0, 0, -0.9, 0, 0, 0.9]);
    const e = { center: [0, 0, 0] as Vec3, half: 1, depthRange: [-0.9, 0.9] as [number, number] };
    const h = depthHistogram(pts, b, e, 10);
    expect(h[0]).toBe(1);
    expect(h[9]).toBe(0.5);
  });
});

describe('withMinimapHelp', () => {
  it('3 行目の末尾に M キーを足す', () => {
    expect(withMinimapHelp('a\nb\nc\nd')).toBe('a\nb\nc / M ミニマップ\nd');
    expect(withMinimapHelp('読み込み中')).toBe('読み込み中');
  });
});
