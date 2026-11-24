import { describe, expect, it } from 'vitest';
import { FLIGHT_ORIENT_END, flightEase } from '../controls/easing';
import { HomeFlight, homeFlightDuration, interpolatePose, poseLookAt, type FlightPose } from './homeFlight';

const A: FlightPose = { position: [1, 0, 0], yaw: 0.2, pitch: 0.1 };
const B: FlightPose = { position: [-1, 2, 4], yaw: -0.4, pitch: -0.3 };

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
  it('向きの進み `orient` を別に与えると、位置は t、向きは orient で補間する', () => {
    const p = interpolatePose(A, B, 0.25, 1);
    expect(p.position).toEqual([0.5, 0.5, 1]);
    expect(p.yaw).toBeCloseTo(B.yaw, 12);
    expect(p.pitch).toBeCloseTo(B.pitch, 12);
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

describe('homeFlightDuration', () => {
  const near: FlightPose = { position: [0, 0, 0.05], yaw: 0, pitch: 0 };
  const far: FlightPose = { position: [0, 0, 3], yaw: 0, pitch: 0 };
  const origin: FlightPose = { position: [0, 0, 0], yaw: 0, pitch: 0 };

  it('基準の所要時間を、移動の距離と点群の半径で 0.8〜1.8 倍に伸縮する', () => {
    const R = 1;
    const d = (to: FlightPose) => Math.hypot(...to.position);
    for (const to of [near, far, B]) {
      const want = Math.min(1.8, Math.max(0.8, 0.8 + 0.25 * Math.log2(1 + d(to) / (0.25 * R))));
      expect(homeFlightDuration(origin, to, 1, R, false)).toBeCloseTo(want, 12);
    }
    expect(homeFlightDuration(origin, near, 1, R, false)).toBeLessThan(1);
    expect(homeFlightDuration(origin, far, 1, R, false)).toBeGreaterThan(1.4);
    expect(homeFlightDuration(origin, { ...far, position: [0, 0, 1e6] }, 0.6, R, false)).toBeCloseTo(0.6 * 1.8, 12);
    expect(homeFlightDuration(origin, origin, 0.6, R, false)).toBeCloseTo(0.6 * 0.8, 12);
  });

  it('半径が使えなければ伸縮しない。動きを減らす設定なら 0.5 倍', () => {
    expect(homeFlightDuration(origin, far, 1, undefined, false)).toBe(1);
    expect(homeFlightDuration(origin, far, 1, 0, false)).toBe(1);
    expect(homeFlightDuration(origin, far, 1, undefined, true)).toBe(0.5);
    expect(homeFlightDuration(origin, far, 1, 1, true)).toBeCloseTo(0.5 * homeFlightDuration(origin, far, 1, 1, false), 12);
  });

  it('位置は f(t)（flightEase）のとおりに進み、向きは f(t/0.7) で、進みの 70% で合い終える', () => {
    const T = 1.3;
    const f = new HomeFlight(A, B, T);
    const steps = 52;
    for (let i = 1; i < steps; i++) {
      const p = f.advance(T / steps);
      const t = f.progress;
      const e = flightEase(t);
      for (let k = 0; k < 3; k++) {
        const want = (A.position[k] as number) + ((B.position[k] as number) - (A.position[k] as number)) * e;
        expect(p.position[k]).toBeCloseTo(want, 9);
      }
      const o = flightEase(t / FLIGHT_ORIENT_END);
      expect(p.yaw).toBeCloseTo(A.yaw + (B.yaw - A.yaw) * o, 9);
      expect(p.pitch).toBeCloseTo(A.pitch + (B.pitch - A.pitch) * o, 9);
      if (t >= FLIGHT_ORIENT_END) {
        expect(p.yaw).toBeCloseTo(B.yaw, 12);
        expect(p.pitch).toBeCloseTo(B.pitch, 12);
      } else {
        expect(Math.abs(p.yaw - B.yaw)).toBeGreaterThan(1e-9);
      }
    }
  });

  it('速さの山は進みの 1/3 のあたり（点へ飛ぶ移動と同じ緩急）', () => {
    const f = new HomeFlight(A, B, 1);
    const total = Math.hypot(...B.position.map((v, i) => v - (A.position[i] as number)));
    let prev = [...A.position];
    let peak = 0;
    let peakAt = 0;
    for (let i = 1; i <= 300; i++) {
      const p = f.advance(1 / 300);
      const step = Math.hypot(...p.position.map((v, k) => v - (prev[k] as number))) / total;
      if (step > peak) {
        peak = step;
        peakAt = i / 300;
      }
      prev = p.position;
    }
    expect(Math.abs(peakAt - 1 / 3)).toBeLessThan(0.01);
  });

  it('所要時間が伸びても、進みの割合で同じ姿勢', () => {
    const a = new HomeFlight(A, B, 1);
    const b = new HomeFlight(A, B, 1.7);
    const pa = a.advance(0.3);
    const pb = b.advance(0.3 * 1.7);
    expect(pb.position[0]).toBeCloseTo(pa.position[0], 12);
    expect(pb.yaw).toBeCloseTo(pa.yaw, 12);
  });
});
