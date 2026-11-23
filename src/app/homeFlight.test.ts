import { describe, expect, it } from 'vitest';
import { HomeFlight, interpolatePose, poseLookAt, smootherstep, type FlightPose } from './homeFlight';

const A: FlightPose = { position: [1, 0, 0], yaw: 0.2, pitch: 0.1 };
const B: FlightPose = { position: [-1, 2, 4], yaw: -0.4, pitch: -0.3 };

describe('smootherstep', () => {
  it('端で 0 と 1、中点で 0.5、単調増加、範囲外は丸める', () => {
    expect(smootherstep(0)).toBe(0);
    expect(smootherstep(1)).toBe(1);
    expect(smootherstep(0.5)).toBeCloseTo(0.5, 12);
    expect(smootherstep(-1)).toBe(0);
    expect(smootherstep(2)).toBe(1);
    let prev = -1;
    for (let i = 0; i <= 100; i++) {
      const v = smootherstep(i / 100);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
  it('始まりと終わりが緩やか（端の近くの進みが一様な補間より小さい）', () => {
    expect(smootherstep(0.05)).toBeLessThan(0.01);
    expect(1 - smootherstep(0.95)).toBeLessThan(0.01);
  });
});

describe('interpolatePose', () => {
  it('t=0 と t=1 で両端、途中は位置・yaw・pitch が線形', () => {
    expect(interpolatePose(A, B, 0)).toEqual(A);
    const end = interpolatePose(A, B, 1);
    expect(end.position).toEqual(B.position);
    expect(end.yaw).toBeCloseTo(B.yaw, 12);
    expect(end.pitch).toBeCloseTo(B.pitch, 12);
    const mid = interpolatePose(A, B, 0.5);
    expect(mid.position).toEqual([0, 1, 2]);
    expect(mid.yaw).toBeCloseTo(-0.1, 12);
    expect(mid.pitch).toBeCloseTo(-0.1, 12);
  });
  it('yaw は短いほうの回り方（±π をまたぐ）', () => {
    const from: FlightPose = { position: [0, 0, 0], yaw: 3, pitch: 0 };
    const to: FlightPose = { position: [0, 0, 0], yaw: -3, pitch: 0 };
    const mid = interpolatePose(from, to, 0.5);
    // 3 → -3 は、0 を通る約 6 rad ではなく、π を通る約 0.28 rad で回る
    expect(Math.abs(Math.cos(mid.yaw) - Math.cos(Math.PI))).toBeLessThan(1e-9);
  });
});

describe('HomeFlight', () => {
  it('所要時間ののち終点に着き、終点の姿勢をそのまま返す', () => {
    const f = new HomeFlight(A, B, 1);
    expect(f.done).toBe(false);
    f.advance(0.4);
    expect(f.done).toBe(false);
    const end = f.advance(0.7);
    expect(f.done).toBe(true);
    expect(end).toEqual(B);
    expect(f.advance(1)).toEqual(B);
  });
  it('フレームごとの位置は途中で跳ばず、終点へ単調に近づく', () => {
    const f = new HomeFlight(A, B, 1);
    const total = Math.hypot(...B.position.map((v, i) => v - (A.position[i] as number)));
    let prev: number[] = [...A.position];
    let prevDist = total;
    let maxStep = 0;
    for (let i = 0; i < 10; i++) {
      const p = f.advance(0.1);
      const step = Math.hypot(...p.position.map((v, k) => v - (prev[k] as number)));
      maxStep = Math.max(maxStep, step);
      const dist = Math.hypot(...p.position.map((v, k) => v - (B.position[k] as number)));
      expect(dist).toBeLessThanOrEqual(prevDist + 1e-12);
      prev = p.position;
      prevDist = dist;
    }
    expect(maxStep).toBeLessThan(total * 0.2);
    expect(prevDist).toBeLessThan(1e-12);
  });
  it('負・NaN の dt は進めない。所要時間 0 なら最初から着いている', () => {
    const f = new HomeFlight(A, B, 1);
    f.advance(-1);
    f.advance(Number.NaN);
    expect(f.progress).toBe(0);
    expect(new HomeFlight(A, B, 0).done).toBe(true);
  });
});

describe('poseLookAt', () => {
  it('位置から視線方向へ 1 進んだ点', () => {
    expect(poseLookAt({ position: [1, 2, 3], yaw: 0, pitch: 0 })).toEqual([1, 2, 2]);
    const up = poseLookAt({ position: [0, 0, 0], yaw: 0, pitch: Math.PI / 2 });
    expect(up[1]).toBeCloseTo(1, 12);
  });
});
