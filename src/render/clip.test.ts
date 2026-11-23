import { describe, expect, it } from 'vitest';
import { MIN_NEAR, NEAR_MARGIN, clipPlanesForCamera, cornerCos, type ViewShape } from './clip';

const VIEW: ViewShape = { fovDeg: 60, aspect: 16 / 10 };

describe('clipPlanesForCamera', () => {
  it('点群の内部では近接面は MIN_NEAR、遠方面は球の奥の表面より遠い', () => {
    const { near, far } = clipPlanesForCamera(0.3, 1.14, VIEW);
    expect(near).toBe(MIN_NEAR);
    expect(far).toBeGreaterThan(0.3 + 1.14);
  });
  it('外にいるときは近接面を球の手前の表面の手前まで遠ざける', () => {
    const { near, far } = clipPlanesForCamera(2.6, 1.14, VIEW);
    expect(near).toBeCloseTo(NEAR_MARGIN * cornerCos(VIEW) * (2.6 - 1.14));
    expect(near).toBeLessThan(2.6 - 1.14);
    expect(near).toBeGreaterThan(0.3);
    expect(far).toBeGreaterThan(2.6 + 1.14);
  });
  it('遠方面はデータの半径に合わせて伸びる（半径 10 のデータでも全体が描画範囲に入る）', () => {
    const r = 10, d = r / Math.sin(Math.PI / 6); // 縦の視野角 60° で全体が収まる距離
    const { near, far } = clipPlanesForCamera(d, r, VIEW);
    expect(far).toBeGreaterThan(d + r);
    expect(near).toBeLessThan(d - r);
  });
  it('近接面は位置に対して連続に変わる', () => {
    const a = clipPlanesForCamera(1.14 + 0.001, 1.14, VIEW).near;
    const b = clipPlanesForCamera(1.14 + 0.002, 1.14, VIEW).near;
    expect(Math.abs(a - b)).toBeLessThan(0.001);
  });
  it('不正な値でも有限の値を返す', () => {
    const { near, far } = clipPlanesForCamera(Number.NaN, 0, { fovDeg: Number.NaN, aspect: 0 });
    expect(Number.isFinite(near) && Number.isFinite(far) && far > near).toBe(true);
  });
  it('縦横比が大きいほど、近接面は手前になる（隅の角度が開く）', () => {
    const near = (aspect: number) => clipPlanesForCamera(3, 1.14, { fovDeg: 60, aspect }).near;
    expect(near(1)).toBeGreaterThan(near(16 / 9));
    expect(near(16 / 9)).toBeGreaterThan(near(3));
    expect(near(3)).toBeGreaterThan(near(4));
  });
});

// ---- 視錐台の内側にあるすべての点が、近接面より奥にあること ----

/** 決定的な乱数（mulberry32） */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type V = [number, number, number];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V): V => { const l = Math.hypot(...a); return [a[0] / l, a[1] / l, a[2] / l]; };

/** 位置 pos から forward を向くカメラ（上は +Y）の右・上。 */
function cameraAxes(forward: V): { right: V; up: V } {
  const right = unit(cross(forward, [0, 1, 0]));
  return { right, up: cross(right, forward) };
}

describe('近接面は、視錐台の内側にあるすべての点より手前にある', () => {
  const R = 1.14;
  const center: V = [0.05, -0.1, 0.2];
  const aspects = [1, 16 / 9, 3, 4];
  for (const aspect of aspects) {
    it(`縦横比 ${aspect.toFixed(2)}（縦の視野角 60°）：点群の外の各位置・各向きから`, () => {
      const view: ViewShape = { fovDeg: 60, aspect };
      const tv = Math.tan(Math.PI / 6), th = tv * aspect;
      const rand = rng(1234 + Math.round(aspect * 100));
      // 球の中の点（内部と表面）
      const pts: V[] = [];
      for (let i = 0; i < 1500; i++) {
        let p: V;
        do { p = [rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1]; } while (Math.hypot(...p) > 1);
        const k = i % 3 === 0 ? R / Math.hypot(...p) : R; // 3 分の 1 は表面へ寄せる
        pts.push([center[0] + p[0] * k, center[1] + p[1] * k, center[2] + p[2] * k]);
      }
      let inFrustum = 0, tightest = Infinity;
      for (let t = 0; t < 400; t++) {
        // 球の外の位置（中心から d の距離、ランダムな向き）。表面のすぐ外から遠方まで
        const d = R * (1.001 + rand() * rand() * 6);
        const dir = unit([rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1]);
        const pos: V = [center[0] + dir[0] * d, center[1] + dir[1] * d, center[2] + dir[2] * d];
        // 向き：球の中心の方向から、画面の隅が球に掛かるまでの範囲でずらす（隅に球の表面が来る配置を含む）
        const toCenter = unit(sub(center, pos));
        const jitter = (rand() - 0.5) * 2 * Math.atan(Math.hypot(tv, th)) * (t % 2 === 0 ? 1 : 0.2);
        const axis = unit(cross(toCenter, unit([rand() - 0.5, rand() - 0.5, rand() - 0.5])));
        const c = Math.cos(jitter), s = Math.sin(jitter);
        const forward = unit([
          toCenter[0] * c + cross(axis, toCenter)[0] * s,
          toCenter[1] * c + cross(axis, toCenter)[1] * s,
          toCenter[2] * c + cross(axis, toCenter)[2] * s,
        ]);
        const { right, up } = cameraAxes(forward);
        const { near } = clipPlanesForCamera(Math.hypot(...sub(pos, center)), R, view);
        for (const p of pts) {
          const v = sub(p, pos);
          const z = dot(v, forward);
          if (z <= 0 || Math.abs(dot(v, right)) > z * th || Math.abs(dot(v, up)) > z * tv) continue; // 視錐台の外
          inFrustum++;
          tightest = Math.min(tightest, z / near);
          expect(z).toBeGreaterThanOrEqual(near);
        }
      }
      expect(inFrustum).toBeGreaterThan(1000); // 検証に十分な数の点が視錐台の内側にあった
      expect(tightest).toBeGreaterThanOrEqual(1);
    });

    it(`縦横比 ${aspect.toFixed(2)}：球の手前の表面が画面の隅にあるとき（最も厳しい配置）でも切れない`, () => {
      const view: ViewShape = { fovDeg: 60, aspect };
      const tv = Math.tan(Math.PI / 6), th = tv * aspect;
      for (const d of [1.2, 1.5, 2, 3, 6, 20]) {
        // 画面の隅の方向 c（カメラ座標、視線が -z）に球の中心を置く。手前の表面の点は、その方向に距離 d − R
        const c = unit([th, tv, 1]);
        const nearestDepth = (d - R) * c[2]; // 隅の方向にある、球で最もカメラに近い点の奥行き
        const { near } = clipPlanesForCamera(d, R, view);
        expect(near).toBeLessThanOrEqual(nearestDepth + 1e-12);
        expect(near).toBeCloseTo(NEAR_MARGIN * nearestDepth, 12);
      }
    });
  }

  it('従来の 0.5 ×（距離 − 半径）は、縦横比 4 の隅では足りなかった（このテストが検出する対象）', () => {
    const tv = Math.tan(Math.PI / 6), th = tv * 4;
    const cos = 1 / Math.sqrt(1 + tv * tv + th * th);
    expect(cos).toBeLessThan(0.5);
  });
});
