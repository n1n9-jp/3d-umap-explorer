import { describe, expect, it } from 'vitest';
import { Matrix4, PerspectiveCamera, Vector3 } from 'three';
import { projectPoint, screenVisibility, type Vec3 } from './projection';

function viewProj(pos: Vec3, look: Vec3, fov = 60, aspect = 1.6): Float32Array | number[] {
  const cam = new PerspectiveCamera(fov, aspect, 0.01, 50);
  cam.position.set(...pos);
  cam.lookAt(new Vector3(...look));
  cam.updateMatrixWorld();
  cam.updateProjectionMatrix();
  return new Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).elements;
}

describe('projectPoint', () => {
  const m = viewProj([0, 0, 5], [0, 0, 0]);
  it('視線上の点は画面の中央に投影される', () => {
    const p = projectPoint(m, [0, 0, 0], 1000, 600);
    expect(p.inFront).toBe(true);
    expect(p.x).toBeCloseTo(500, 6);
    expect(p.y).toBeCloseTo(300, 6);
    expect(p.depth).toBeCloseTo(5, 6);
  });
  it('右の点は右へ、上の点は上（y が小さい）へ投影される', () => {
    const r = projectPoint(m, [1, 0, 0], 1000, 600);
    const u = projectPoint(m, [0, 1, 0], 1000, 600);
    expect(r.x).toBeGreaterThan(500);
    expect(u.y).toBeLessThan(300);
  });
  it('縦の視野角 60° の端（tan30° × 距離）が画面の上端に当たる', () => {
    const p = projectPoint(m, [0, 5 * Math.tan(Math.PI / 6), 0], 1000, 600);
    expect(p.y).toBeCloseTo(0, 4);
  });
  it('three.js の Vector3.project と一致する', () => {
    const cam = new PerspectiveCamera(50, 1.3, 0.01, 50);
    cam.position.set(0.4, -0.2, 3);
    cam.lookAt(0.1, 0.2, 0);
    cam.updateMatrixWorld(); cam.updateProjectionMatrix();
    const vp = new Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).elements;
    const ndc = new Vector3(0.3, 0.5, -0.4).project(cam);
    const p = projectPoint(vp, [0.3, 0.5, -0.4], 800, 400);
    expect(p.x).toBeCloseTo((ndc.x * 0.5 + 0.5) * 800, 4);
    expect(p.y).toBeCloseTo((0.5 - ndc.y * 0.5) * 400, 4);
  });
  it('カメラの後ろの点は inFront が false で座標が NaN', () => {
    const p = projectPoint(m, [0, 0, 10], 1000, 600);
    expect(p.inFront).toBe(false);
    expect(Number.isNaN(p.x)).toBe(true);
  });
});

describe('screenVisibility', () => {
  const m = viewProj([0, 0, 5], [0, 0, 0]);
  it('画面内は ok、カメラの後ろは behind、画面の外は offscreen', () => {
    expect(screenVisibility(projectPoint(m, [0, 0, 0], 1000, 600), 1000, 600)).toBe('ok');
    expect(screenVisibility(projectPoint(m, [0, 0, 10], 1000, 600), 1000, 600)).toBe('behind');
    expect(screenVisibility(projectPoint(m, [10, 0, 0], 1000, 600), 1000, 600)).toBe('offscreen');
    expect(screenVisibility(projectPoint(m, [0, 10, 0], 1000, 600), 1000, 600)).toBe('offscreen');
  });
  it('margin を指定すると内側の矩形で判定する', () => {
    const pt = { x: 5, y: 300, depth: 1, inFront: true };
    expect(screenVisibility(pt, 1000, 600, 0)).toBe('ok');
    expect(screenVisibility(pt, 1000, 600, 10)).toBe('offscreen');
  });
});
