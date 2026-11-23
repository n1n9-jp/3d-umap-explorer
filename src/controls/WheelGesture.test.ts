import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WHEEL_GESTURE_GAP_MS,
  DEFAULT_WHEEL_GESTURE_LIMIT_NOTCHES,
  MAX_WHEEL_EVENT_NOTCHES,
  WheelGestureLimiter,
} from './WheelGesture';

describe('WheelGestureLimiter', () => {
  it('上限までは入力をそのまま反映する（1 ノッチは 1 ノッチ）', () => {
    const g = new WheelGestureLimiter();
    expect(g.consume(1, 0)).toBe(1);
    expect(g.consume(-0.25, 16)).toBeCloseTo(-0.25, 12);
    expect(g.consume(2, 32)).toBeCloseTo(2, 12);
  });

  it('間隔があいたイベントは別の払いとして、毎回満額で反映する', () => {
    const g = new WheelGestureLimiter();
    let total = 0;
    for (let i = 0; i < 50; i++) total += g.consume(1, i * 500);
    expect(total).toBe(50);
  });

  it('連続したイベントの累積は上限で止まる', () => {
    const g = new WheelGestureLimiter();
    let total = 0;
    for (let i = 0; i < 200; i++) total += g.consume(0.5, i * 16);
    expect(total).toBeCloseTo(DEFAULT_WHEEL_GESTURE_LIMIT_NOTCHES, 12);
    expect(g.consume(0.5, 200 * 16)).toBe(0);
  });

  it('上限に達したあとでも、逆向きの入力はすぐ反映される', () => {
    const g = new WheelGestureLimiter();
    for (let i = 0; i < 100; i++) g.consume(1, i * 16);
    expect(g.consume(-1, 100 * 16)).toBe(-1);
  });

  it('間隔が gapMs 以上あくと累積を数え直す', () => {
    const g = new WheelGestureLimiter();
    for (let i = 0; i < 20; i++) g.consume(1, i * 16);
    const last = 19 * 16;
    expect(g.consume(1, last + DEFAULT_WHEEL_GESTURE_GAP_MS - 1)).toBe(0);
    expect(g.consume(1, last + 2 * DEFAULT_WHEEL_GESTURE_GAP_MS)).toBe(1);
  });

  it('1 回のイベントで受け付けるのは 3 ノッチまで', () => {
    const g = new WheelGestureLimiter();
    expect(g.consume(50, 0)).toBe(MAX_WHEEL_EVENT_NOTCHES);
    expect(g.consume(-50, 1000)).toBe(-MAX_WHEEL_EVENT_NOTCHES);
  });

  it('有限でない入力は 0 を返し、状態を変えない', () => {
    const g = new WheelGestureLimiter();
    g.consume(2, 0);
    expect(g.consume(NaN, 10)).toBe(0);
    expect(g.consume(Infinity, 20)).toBe(0);
    expect(g.consume(1, NaN)).toBe(0);
    expect(g.consume(1, 30)).toBe(1);
  });

  it('reset で進行中の払いを捨てる', () => {
    const g = new WheelGestureLimiter();
    for (let i = 0; i < 100; i++) g.consume(1, i * 16);
    g.reset();
    expect(g.consume(1, 100 * 16)).toBe(1);
  });
});
