import { describe, expect, it } from 'vitest';
import { Matrix4, PerspectiveCamera, Vector3 } from 'three';
import { computeHomeView, fitDistance, homeDirection, HOME_MARGIN } from './homeView';
import type { Vec3 } from '../render/view';
import { MAX_VIEW_PITCH } from '../render/view';

/** 疑似乱数（再現できるように固定の種）。球の中に一様でなく散らばった点を作る。 */
function makePoints(center: Vec3, radius: number, n: number): Vec3[] {
  let s = 12345;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const pts: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const v = new Vector3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1);
    if (v.length() > 1 || v.length() < 1e-6) { i--; continue; }
    pts.push([center[0] + v.x * radius, center[1] + v.y * radius, center[2] + v.z * radius]);
  }
  // 球の表面上の点（最も外側）も入れる
  for (const d of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as Vec3[]) {
    pts.push([center[0] + d[0] * radius, center[1] + d[1] * radius, center[2] + d[2] * radius]);
  }
  return pts;
}

/** ホームの視点から見たときの、各点の正規化デバイス座標（x, y）と奥行き。 */
function project(points: Vec3[], view: { pos: Vec3; look: Vec3 }, fov: number, aspect: number) {
  const camera = new PerspectiveCamera(fov, aspect, 0.0005, 12);
  camera.position.set(...view.pos);
  camera.lookAt(new Vector3(...view.look));
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  const viewProj = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  return points.map((p) => {
    const w = new Vector3(...p).applyMatrix4(viewProj);
    return { x: w.x, y: w.y, z: w.z };
  });
}

const AXES: [Vec3, Vec3, Vec3] = [
  [0.935867, 0.243862, 0.254331],
  [-0.237131, 0.969787, -0.057293],
  [-0.260618, -0.006691, 0.965419],
];

describe('computeHomeView: 全点が視錐台に収まる', () => {
  const cases: Array<[string, number, number]> = [
    ['横長 16:10', 60, 1.6],
    ['正方形', 60, 1],
    ['縦長 600x900', 60, 600 / 900],
    ['極端に縦長', 60, 0.3],
    ['極端に横長', 60, 3],
    ['視野角が狭い', 30, 1.6],
    ['視野角が広い縦長', 90, 0.5],
  ];
  for (const [name, fov, aspect] of cases) {
    for (const [axesName, axes] of [['overview あり', AXES], ['overview なし', undefined]] as const) {
      it(`${name}・${axesName}`, () => {
        const center: Vec3 = [0.3, -0.2, 0.1];
        const radius = 1.14;
        const view = computeHomeView({ center, radius }, fov, aspect, axes);
        for (const p of project(makePoints(center, radius, 800), view, fov, aspect)) {
          expect(Math.abs(p.x)).toBeLessThanOrEqual(1);
          expect(Math.abs(p.y)).toBeLessThanOrEqual(1);
          expect(p.z).toBeGreaterThan(-1);
          expect(p.z).toBeLessThan(1);
        }
      });
    }
  }

  it('余白 1（球が画面の縁に接する）でも収まり、制限する側の縁にほぼ接する', () => {
    const center: Vec3 = [0, 0, 0];
    for (const aspect of [0.5, 1.6]) {
      const view = computeHomeView({ center, radius: 1 }, 60, aspect, AXES, { margin: 1 });
      const projected = project(makePoints(center, 1, 3000), view, 60, aspect);
      const maxX = Math.max(...projected.map((p) => Math.abs(p.x)));
      const maxY = Math.max(...projected.map((p) => Math.abs(p.y)));
      expect(Math.max(maxX, maxY)).toBeLessThanOrEqual(1 + 1e-9);
      expect(Math.max(maxX, maxY)).toBeGreaterThan(0.9);
    }
  });

  it('既定の余白で、画面を使い切りつつ余白が極端でない', () => {
    const center: Vec3 = [0, 0, 0];
    for (const aspect of [0.6, 1.6]) {
      const view = computeHomeView({ center, radius: 1 }, 60, aspect, AXES);
      const projected = project(makePoints(center, 1, 3000), view, 60, aspect);
      const extent = Math.max(...projected.map((p) => Math.max(Math.abs(p.x), Math.abs(p.y))));
      expect(extent).toBeGreaterThan(0.75);
      expect(extent).toBeLessThan(1);
    }
  });
});

describe('computeHomeView: 位置と向き', () => {
  it('bounds の中心が原点でなくても、その中心を向き、中心からの距離は fitDistance × 余白', () => {
    const center: Vec3 = [2, -3, 5];
    const view = computeHomeView({ center, radius: 0.7 }, 60, 1.6, AXES);
    expect(view.look).toEqual(center);
    const d = Math.hypot(view.pos[0] - center[0], view.pos[1] - center[1], view.pos[2] - center[2]);
    expect(d).toBeCloseTo(fitDistance(0.7, 60, 1.6) * HOME_MARGIN, 9);
  });

  it('縦長では横の視野で、横長では縦の視野で距離が決まる', () => {
    const r = 1;
    expect(fitDistance(r, 60, 1)).toBeCloseTo(2, 9); // 半視野角 30° → 1 / sin30°
    expect(fitDistance(r, 60, 2)).toBeCloseTo(2, 9); // 横長は縦で決まる
    const halfH = Math.atan(Math.tan(Math.PI / 6) * 0.5);
    expect(fitDistance(r, 60, 0.5)).toBeCloseTo(1 / Math.sin(halfH), 9);
    expect(fitDistance(r, 60, 0.5)).toBeGreaterThan(fitDistance(r, 60, 1));
  });

  it('縦横比が不正（0・NaN）でも有限の距離を返す', () => {
    expect(Number.isFinite(fitDistance(1, 60, 0))).toBe(true);
    expect(Number.isFinite(fitDistance(1, 60, Number.NaN))).toBe(true);
  });

  it('overview がなければ +Z から見る', () => {
    const view = computeHomeView({ center: [0, 0, 0], radius: 1 }, 60, 1.6);
    expect(view.pos[0]).toBeCloseTo(0, 12);
    expect(view.pos[1]).toBeCloseTo(0, 12);
    expect(view.pos[2]).toBeGreaterThan(0);
  });

  it('半径が 0・負・非有限でも有限の視点を返す', () => {
    for (const radius of [0, -1, Number.NaN]) {
      const v = computeHomeView({ center: [1, 2, 3], radius }, 60, 1.6, AXES);
      expect([...v.pos, ...v.look].every(Number.isFinite)).toBe(true);
    }
  });
});

describe('homeDirection', () => {
  it('第3軸の方向（符号は第1軸が右、+Y 側が上になる側）から見る', () => {
    const d = homeDirection(AXES);
    const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    expect(Math.abs(dot(d, AXES[2]))).toBeGreaterThan(0.999);
    expect(Math.hypot(...d)).toBeCloseTo(1, 12);
    expect(dot(d, AXES[2])).toBeGreaterThan(0); // 右手系の軸なので第3軸そのもの
  });

  it('左手系の軸でも、第1軸が画面の右になる（左右が反転しない）', () => {
    const left: [Vec3, Vec3, Vec3] = [AXES[0], AXES[1], [-AXES[2][0], -AXES[2][1], -AXES[2][2]]];
    const view = computeHomeView({ center: [0, 0, 0], radius: 1 }, 60, 1.6, left);
    const camera = new PerspectiveCamera(60, 1.6);
    camera.position.set(...view.pos);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const right = new Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    expect(right.dot(new Vector3(...AXES[0]))).toBeGreaterThan(0.9);
  });

  it('第2軸が下向きなら反転し、画面の上が +Y 側になる', () => {
    const down: [Vec3, Vec3, Vec3] = [[1, 0, 0], [0, -1, 0], [0, 0, 1]];
    const view = computeHomeView({ center: [0, 0, 0], radius: 1 }, 60, 1.6, down);
    const camera = new PerspectiveCamera(60, 1.6);
    camera.position.set(...view.pos);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    expect(new Vector3(0, 1, 0).applyQuaternion(camera.quaternion).y).toBeGreaterThan(0.9);
  });

  it('真上・真下から見る軸でも、仰角は ±89° に収まる', () => {
    for (const axes of [
      [[1, 0, 0], [0, 0, -1], [0, 1, 0]],
      [[1, 0, 0], [0, 0, 1], [0, -1, 0]],
    ] as Array<[Vec3, Vec3, Vec3]>) {
      const d = homeDirection(axes);
      expect(Math.abs(Math.asin(d[1]))).toBeLessThanOrEqual(MAX_VIEW_PITCH + 1e-12);
      const view = computeHomeView({ center: [0, 0, 0], radius: 1 }, 60, 1.6, axes);
      for (const p of project(makePoints([0, 0, 0], 1, 300), view, 60, 1.6)) {
        expect(Math.abs(p.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(p.y)).toBeLessThanOrEqual(1);
      }
    }
  });

  it('軸が退化している（零ベクトル・平行）なら既定の向き', () => {
    expect(homeDirection([[0, 0, 0], [0, 1, 0], [0, 0, 1]])).toEqual([0, 0, 1]);
    expect(homeDirection([[1, 0, 0], [1, 0, 0], [0, 0, 1]])).toEqual([0, 0, 1]);
  });
});
