import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { MAX_VIEW_PITCH } from '../render/view';
import {
  REORIENT_DURATION_SECONDS,
  REORIENT_MIN_ANGLE,
  RESIDUAL_TIME_CONSTANT,
  Reorient,
  ResidualMotion,
  reorientEase,
} from './modeTransition';

describe('定数', () => {
  it('向き直しは 0.5 秒・3°、残った動きの時定数は 0.15 秒', () => {
    expect(REORIENT_DURATION_SECONDS).toBe(0.5);
    expect(REORIENT_MIN_ANGLE).toBeCloseTo((3 * Math.PI) / 180, 12);
    expect(RESIDUAL_TIME_CONSTANT).toBe(0.15);
  });
});

describe('reorientEase: f(t) = 1 − (1−t)³(1+3t)', () => {
  it('端で 0 と 1、中点で 0.6875、範囲外は端に丸める', () => {
    expect(reorientEase(0)).toBe(0);
    expect(reorientEase(1)).toBe(1);
    expect(reorientEase(0.5)).toBeCloseTo(0.6875, 12);
    expect(reorientEase(-3)).toBe(0);
    expect(reorientEase(4)).toBe(1);
  });

  it('単調増加で、始めと終わりの速さが 0', () => {
    let prev = -1;
    for (let i = 0; i <= 200; i++) {
      const v = reorientEase(i / 200);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    const h = 1e-5;
    expect((reorientEase(h) - reorientEase(0)) / h).toBeLessThan(1e-3);
    expect((reorientEase(1) - reorientEase(1 - h)) / h).toBeLessThan(1e-3);
  });
});

describe('Reorient', () => {
  it('0.5 秒で終わる。終わったあとは目標をそのまま返す', () => {
    const r = new Reorient({ yaw: 0, pitch: 0 });
    const target = { yaw: 1, pitch: 0.4 };
    expect(r.done).toBe(false);
    r.advance(0.49, target);
    expect(r.done).toBe(false);
    const end = r.advance(0.02, target);
    expect(r.done).toBe(true);
    expect(end).toEqual(target);
    expect(r.advance(1, target)).toEqual(target);
  });

  it('yaw と pitch を、同じ進み方 f(t) で補間する', () => {
    const r = new Reorient({ yaw: 0.2, pitch: -0.1 });
    const target = { yaw: 1.2, pitch: 0.5 };
    const a = r.advance(0.25, target);
    const f = reorientEase(0.5);
    expect(a.yaw).toBeCloseTo(0.2 + 1.0 * f, 12);
    expect(a.pitch).toBeCloseTo(-0.1 + 0.6 * f, 12);
  });

  it('yaw は短いほうの回り方（±π をまたぐ）', () => {
    const r = new Reorient({ yaw: 3, pitch: 0 });
    const a = r.advance(0.25, { yaw: -3, pitch: 0 });
    // 3 → -3 は、短いほうだと +0.2832 rad（2π − 6）進んで π をまたぐ
    expect(Math.abs(a.yaw - 3)).toBeLessThan(0.3);
  });

  it('目標を毎フレーム変えても、終わるときは最後の目標を向く', () => {
    const r = new Reorient({ yaw: 0, pitch: 0 });
    r.advance(0.2, { yaw: 1, pitch: 0 });
    r.advance(0.2, { yaw: 1.1, pitch: 0.1 });
    expect(r.advance(0.2, { yaw: 1.3, pitch: 0.2 })).toEqual({ yaw: 1.3, pitch: 0.2 });
  });

  it('rotateBaseline: 開始の向きをずらす。途中ではずれた分が (1 − f) の割合で残り、終わるとなくなる。仰角は ±89° に収める', () => {
    const target = { yaw: 1, pitch: 0 };
    const plain = new Reorient({ yaw: 0, pitch: 0 }).advance(0.25, target);
    const shifted = new Reorient({ yaw: 0, pitch: 0 });
    shifted.rotateBaseline(0.3, 0);
    const a = shifted.advance(0.25, target);
    expect(a.yaw - plain.yaw).toBeCloseTo(-0.3 * reorientEase(0.5) + 0.3, 12);
    const end = shifted.advance(1, target);
    expect(end).toEqual(target);
    const steep = new Reorient({ yaw: 0, pitch: 1.5 });
    steep.rotateBaseline(0, 1);
    expect(steep.advance(0.01, { yaw: 0, pitch: 1.5 }).pitch).toBeLessThanOrEqual(MAX_VIEW_PITCH + 1e-12);
  });

  it('dt が負・非有限なら進めない', () => {
    const r = new Reorient({ yaw: 0, pitch: 0 });
    for (const dt of [-1, Number.NaN, Number.POSITIVE_INFINITY]) r.advance(dt, { yaw: 1, pitch: 0 });
    expect(r.progress).toBe(0);
    expect(r.done).toBe(false);
  });

  it('所要時間 0 なら、すぐ終わる', () => {
    const r = new Reorient({ yaw: 0, pitch: 0 }, 0);
    expect(r.done).toBe(true);
    expect(r.advance(0, { yaw: 2, pitch: 0 })).toEqual({ yaw: 2, pitch: 0 });
  });
});

describe('ResidualMotion', () => {
  const total = (motion: ResidualMotion, dt: number, seconds: number) => {
    const sum = new Vector3();
    let yaw = 0;
    let pitch = 0;
    for (let t = 0; t < seconds - 1e-12; t += dt) {
      const s = motion.step(dt);
      sum.add(s.translation);
      yaw += s.dYaw;
      pitch += s.dPitch;
    }
    return { sum, yaw, pitch };
  };

  it('移動の速度は時定数 0.15 秒で減り、総距離は v0 × τ。刻み幅によらない', () => {
    for (const dt of [1 / 240, 1 / 60, 0.05, 0.1]) {
      const m = new ResidualMotion();
      m.addVelocity(new Vector3(0.4, 0, -0.3)); // 速さ 0.5
      const { sum } = total(m, dt, 4);
      expect(sum.length()).toBeCloseTo(0.5 * 0.15, 5);
      expect(sum.clone().normalize().distanceTo(new Vector3(0.8, 0, -0.6))).toBeLessThan(1e-9);
      expect(m.active).toBe(false);
    }
  });

  it('毎フレームの移動量は exp(−dt/τ) の比で減る', () => {
    const m = new ResidualMotion();
    m.addVelocity(new Vector3(1, 0, 0));
    const a = m.step(1 / 60).translation.length();
    const b = m.step(1 / 60).translation.length();
    expect(b / a).toBeCloseTo(Math.exp(-1 / 60 / 0.15), 9);
  });

  it('回転の角速度も時定数 0.15 秒で減り、総回転は rate × τ（stopSpeed 分を除く）。ヨーとピッチは別々に積算される', () => {
    const m = new ResidualMotion();
    m.setRotation(2, -1, false);
    expect(m.rotating).toBe(true);
    expect(m.orbit).toBe(false);
    const { yaw, pitch } = total(m, 1 / 60, 4);
    expect(yaw).toBeGreaterThan(2 * 0.15 * 0.97);
    expect(yaw).toBeLessThanOrEqual(2 * 0.15 + 1e-9);
    expect(pitch).toBeLessThan(-1 * 0.15 * 0.97);
    expect(m.active).toBe(false);
  });

  it('引き継ぐ角速度に上限を掛けない（元の慣性が決めた値のまま）', () => {
    const m = new ResidualMotion();
    m.setRotation(9, 0, true);
    expect(m.orbit).toBe(true);
    const s = m.step(1 / 60);
    expect(s.dYaw).toBeCloseTo(9 * 0.15 * (1 - Math.exp(-1 / 60 / 0.15)), 9);
  });

  it('小さすぎる速度・角速度は残さない', () => {
    const m = new ResidualMotion();
    m.addVelocity(new Vector3(1e-6, 0, 0));
    m.setRotation(0.001, 0, false);
    expect(m.active).toBe(false);
    expect(m.step(0.1).translation.length()).toBe(0);
  });

  it('stop・stopRotation・blockPitch', () => {
    const m = new ResidualMotion();
    m.addVelocity(new Vector3(1, 0, 0));
    m.setRotation(1, 1, false);
    m.blockPitch();
    expect(m.step(0.1).dPitch).toBe(0);
    m.stopRotation();
    expect(m.rotating).toBe(false);
    expect(m.moving).toBe(true);
    m.stop();
    expect(m.active).toBe(false);
  });

  it('setRotation は、いまの回転を置き換える（小さければ回転は残らない）', () => {
    const m = new ResidualMotion();
    m.setRotation(2, 0, false);
    m.setRotation(0, 0, true);
    expect(m.rotating).toBe(false);
  });

  it('dt が 0・負・非有限なら、何も動かさず、状態も進めない', () => {
    const m = new ResidualMotion();
    m.addVelocity(new Vector3(1, 0, 0));
    m.setRotation(1, 0, false);
    for (const dt of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const s = m.step(dt);
      expect(s.translation.length()).toBe(0);
      expect([s.dYaw, s.dPitch]).toEqual([0, 0]);
    }
    expect(m.step(0.1).translation.x).toBeGreaterThan(0);
  });

  it('不正な速度（NaN）は足さない。速度は足し合わせる', () => {
    const m = new ResidualMotion();
    m.addVelocity(new Vector3(Number.NaN, 0, 0));
    expect(m.moving).toBe(false);
    m.addVelocity(new Vector3(1, 0, 0));
    m.addVelocity(new Vector3(0, 2, 0));
    const s = m.step(1e-9);
    expect(s.translation.y / s.translation.x).toBeCloseTo(2, 6);
  });
});
