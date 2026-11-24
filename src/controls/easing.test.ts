import { describe, expect, it } from 'vitest';
import {
  FLIGHT_CARRY_LIMIT,
  FLIGHT_DURATION_MAX_FACTOR,
  FLIGHT_DURATION_MIN_FACTOR,
  FLIGHT_EXCESS_LIMIT,
  FLIGHT_EXCESS_TIME_CONSTANT,
  flightCarry,
  flightCarryDerivative,
  flightEase,
  flightEaseDerivative,
  flightExcess,
  flightExcessDerivative,
  flightExcessTimeConstant,
  reducedFlightDuration,
  scaledFlightDuration,
} from './easing';

describe('flightEase: f(t) = 1 − (1−t)³(1+3t)', () => {
  it('f(0)=0、f(1)=1、範囲外は端に丸める', () => {
    expect(flightEase(0)).toBe(0);
    expect(flightEase(1)).toBe(1);
    expect(flightEase(-1)).toBe(0);
    expect(flightEase(2)).toBe(1);
  });

  it('式のとおりの値（t=0.5 で 1 − 0.125 × 2.5）', () => {
    expect(flightEase(0.5)).toBeCloseTo(1 - 0.125 * 2.5, 12);
    expect(flightEase(0.2)).toBeCloseTo(1 - 0.8 ** 3 * 1.6, 12);
  });

  it('始めと終わりの速さが 0（f′(0)=f′(1)=0）。差分でも確かめる', () => {
    expect(flightEaseDerivative(0)).toBe(0);
    expect(flightEaseDerivative(1)).toBe(0);
    const h = 1e-6;
    expect((flightEase(h) - flightEase(0)) / h).toBeLessThan(1e-4);
    expect((flightEase(1) - flightEase(1 - h)) / h).toBeLessThan(1e-4);
  });

  it('導関数 12t(1−t)² が、差分の傾きと一致する', () => {
    const h = 1e-6;
    for (const t of [0.05, 0.2, 1 / 3, 0.5, 0.8, 0.95]) {
      const slope = (flightEase(t + h) - flightEase(t - h)) / (2 * h);
      expect(flightEaseDerivative(t)).toBeCloseTo(slope, 5);
    }
  });

  it('単調増加で、速さの山は t = 1/3（短く出て、長く減速して止まる）', () => {
    let prev = -1;
    let peakAt = 0;
    let peak = -1;
    for (let i = 0; i <= 1000; i++) {
      const t = i / 1000;
      const v = flightEase(t);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
      const d = flightEaseDerivative(t);
      if (d > peak) {
        peak = d;
        peakAt = t;
      }
    }
    expect(peakAt).toBeCloseTo(1 / 3, 2);
    expect(peak).toBeCloseTo(16 / 9, 3);
    // 減速の側が長い: 速さのピークから止まるまでが、動き出しからピークまでより長い
    expect(1 - peakAt).toBeGreaterThan(peakAt * 1.9);
  });
});

describe('scaledFlightDuration', () => {
  const R = 1.2;
  const formula = (base: number, d: number) =>
    Math.min(base * 1.8, Math.max(base * 0.8, base * (0.8 + 0.25 * Math.log2(1 + d / (0.25 * R)))));

  it('式のとおり（上下限の間では連続）', () => {
    for (const d of [0.1, 0.3, 0.6, 1, 2, 3.5]) {
      expect(scaledFlightDuration(1000, d, R)).toBeCloseTo(formula(1000, d), 9);
    }
    // d = 0.25R で log2(2) = 1 → 1.05 倍、d = R で log2(5) → 約 1.38 倍
    expect(scaledFlightDuration(800, 0.25 * R, R)).toBeCloseTo(800 * 1.05, 9);
    expect(scaledFlightDuration(800, R, R)).toBeCloseTo(800 * (0.8 + 0.25 * Math.log2(5)), 9);
  });

  it('d=0 で下限（0.8 倍）、遠いほど長くなって上限（1.8 倍）に収まる', () => {
    expect(scaledFlightDuration(1000, 0, R)).toBeCloseTo(1000 * FLIGHT_DURATION_MIN_FACTOR, 9);
    expect(scaledFlightDuration(1000, 1e6, R)).toBeCloseTo(1000 * FLIGHT_DURATION_MAX_FACTOR, 9);
    let prev = 0;
    for (let d = 0; d <= 6; d += 0.1) {
      const t = scaledFlightDuration(600, d, R);
      expect(t).toBeGreaterThanOrEqual(600 * 0.8 - 1e-9);
      expect(t).toBeLessThanOrEqual(600 * 1.8 + 1e-9);
      expect(t).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = t;
    }
  });

  it('半径が使えない・基準が 0 のときは伸縮しない／0 のまま', () => {
    for (const r of [undefined, null, 0, -1, Number.NaN, Infinity]) expect(scaledFlightDuration(800, 2, r)).toBe(800);
    expect(scaledFlightDuration(0, 2, R)).toBe(0);
    expect(scaledFlightDuration(800, Number.NaN, R)).toBeCloseTo(800 * 0.8, 9);
  });
});

describe('reducedFlightDuration', () => {
  it('動きを減らす設定なら 0.5 倍、そうでなければそのまま', () => {
    expect(reducedFlightDuration(800, true)).toBe(400);
    expect(reducedFlightDuration(800, false)).toBe(800);
  });
});

describe('flightCarry: g(t) = t(1−t)⁴（始めの速度の引き継ぎの形）', () => {
  it('g(0)=g(1)=0、g′(0)=1、g′(1)=0、最大は t=1/5 で 0.08192', () => {
    expect(flightCarry(0)).toBe(0);
    expect(flightCarry(1)).toBe(0);
    expect(flightCarryDerivative(0)).toBe(1);
    expect(flightCarryDerivative(1)).toBe(0);
    expect(flightCarry(0.2)).toBeCloseTo(0.08192, 12);
    for (let i = 0; i <= 1000; i++) expect(flightCarry(i / 1000)).toBeLessThanOrEqual(0.08192 + 1e-15);
  });

  it('導関数 (1−t)³(1−5t) が、差分の傾きと一致する', () => {
    const h = 1e-6;
    for (const t of [0.05, 0.2, 0.4, 0.7, 0.95]) {
      expect(flightCarryDerivative(t)).toBeCloseTo((flightCarry(t + h) - flightCarry(t - h)) / (2 * h), 6);
    }
  });

  it('上限 c の範囲では、進む方向の成分が終点を越えない: c·g(t) ≤ 1 − f(t)（すべての t で）', () => {
    for (let i = 1; i < 10000; i++) {
      const t = i / 10000;
      expect(FLIGHT_CARRY_LIMIT * flightCarry(t)).toBeLessThanOrEqual(1 - flightEase(t) + 1e-15);
    }
  });
});

describe('flightExcess: 上限を超えた分の速度の項 h = τ(1−e^(−s/τ))(1−f(t))', () => {
  const T = 0.6;
  it('h(0)=h(1)=0、dh/ds(0)=1、dh/ds(1)=0、0 ≤ h ≤ τ', () => {
    for (const tau of [0.12, 0.01, 1e-4]) {
      expect(flightExcess(0, T, tau)).toBe(0);
      expect(flightExcess(1, T, tau)).toBe(0);
      expect(flightExcessDerivative(0, T, tau)).toBe(1);
      expect(flightExcessDerivative(1, T, tau)).toBe(0);
      expect(flightExcessDerivative(1 - 1e-9, T, tau)).toBeLessThan(1e-6);
      for (let i = 0; i <= 1000; i++) {
        const h = flightExcess(i / 1000, T, tau);
        expect(h).toBeGreaterThanOrEqual(0);
        expect(h).toBeLessThanOrEqual(tau);
      }
    }
    expect(flightExcess(0.5, T, 0)).toBe(0);
    expect(flightExcessDerivative(0, T, 0)).toBe(0);
  });

  it('導関数が、経過秒についての差分の傾きと一致する', () => {
    const h = 1e-7;
    for (const tau of [0.12, 0.03]) {
      for (const t of [0.01, 0.1, 0.3, 0.6, 0.95]) {
        const s = t * T;
        const num = (flightExcess((s + h) / T, T, tau) - flightExcess((s - h) / T, T, tau)) / (2 * h);
        expect(flightExcessDerivative(t, T, tau)).toBeCloseTo(num, 6);
      }
    }
  });

  it('時定数は min(0.12, 0.4·k·L / |w|)。近づく向きでは k = cos θ、離れる向き・真横では k = 1。L が 0 なら 0', () => {
    expect(FLIGHT_EXCESS_TIME_CONSTANT).toBe(0.12);
    expect(flightExcessTimeConstant(0.1, 1, 1)).toBe(0.12);
    expect(flightExcessTimeConstant(2, 0.05, 1)).toBeCloseTo((FLIGHT_EXCESS_LIMIT * 0.05) / 2, 15);
    expect(flightExcessTimeConstant(2, 0.05, 0.5)).toBeCloseTo((FLIGHT_EXCESS_LIMIT * 0.5 * 0.05) / 2, 15);
    expect(flightExcessTimeConstant(2, 0.05, 0)).toBeCloseTo((FLIGHT_EXCESS_LIMIT * 0.05) / 2, 15);
    expect(flightExcessTimeConstant(2, 0.05, -0.7)).toBeCloseTo((FLIGHT_EXCESS_LIMIT * 0.05) / 2, 15);
    expect(flightExcessTimeConstant(2, 0, 1)).toBe(0);
    expect(flightExcessTimeConstant(0, 1, 1)).toBe(0);
    expect(flightExcessTimeConstant(Number.NaN, 1, 1)).toBe(0);
  });
});
