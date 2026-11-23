import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WHEEL_GESTURE_GAP_MS,
  DEFAULT_WHEEL_GESTURE_LIMIT_NOTCHES,
  DISCRETE_WHEEL_PIXEL_MIN,
  isDiscreteWheelDelta,
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

  it('ノッチ扱い（discrete）のイベントは、連続しても累積の上限を受けない', () => {
    const g = new WheelGestureLimiter();
    let total = 0;
    for (let i = 0; i < 20; i++) total += g.consume(1, i * 16, true);
    expect(total).toBe(20);
    let down = 0;
    for (let i = 0; i < 20; i++) down += g.consume(-1, 1000 + i * 16, true);
    expect(down).toBe(-20);
  });

  it('ノッチ扱いのイベントにも、1 回のイベントで 3 ノッチまでの上限は掛かる', () => {
    const g = new WheelGestureLimiter();
    expect(g.consume(10, 0, true)).toBe(MAX_WHEEL_EVENT_NOTCHES);
    expect(g.consume(-10, 10, true)).toBe(-MAX_WHEEL_EVENT_NOTCHES);
  });

  it('払いの頭のノッチ扱いのイベントは、その払いがタッチパッドと判明したあと、累積に数えられる', () => {
    const g = new WheelGestureLimiter();
    let notches = 0;
    for (let i = 0; i < 5; i++) notches += g.consume(1, i * 10, true);
    expect(notches).toBe(5);
    // 小さな移動量が続くと、先に反映した 5 ノッチを含めて 7 ノッチまで（残り 2 ノッチ）。
    let small = 0;
    for (let i = 0; i < 100; i++) small += g.consume(0.2, 100 + i * 16);
    expect(small).toBeCloseTo(DEFAULT_WHEEL_GESTURE_LIMIT_NOTCHES - 5, 9);
  });

  it('払いの頭のノッチ扱いのイベントが上限を越えていたら、戻さず、同じ向きの以降のイベントを反映しない', () => {
    const g = new WheelGestureLimiter();
    let applied = 0;
    for (let i = 0; i < 4; i++) applied += g.consume(3, i * 10, true);
    expect(applied).toBe(12);
    for (let i = 0; i < 50; i++) expect(g.consume(0.2, 40 + i * 16)).toBe(0);
    expect(g.consume(3, 40 + 50 * 16, true)).toBe(0);
    // 逆向きは累積を減らす向きなので反映される（累積 12 → 11）。
    expect(g.consume(-1, 40 + 51 * 16)).toBe(-1);
  });

  it('マウスのノッチだけの払い（小さなイベントが一度も来ない）は、何度続けても制限されない', () => {
    const g = new WheelGestureLimiter();
    let total = 0;
    for (let i = 0; i < 20; i++) total += g.consume(1, i * 50, true);
    expect(total).toBe(20);
  });

  it('払いの中に小さな移動量のイベントがあれば、その払いのノッチ扱いのイベントにも上限が掛かる', () => {
    const g = new WheelGestureLimiter();
    g.consume(0.2, 0); // タッチパッドの立ち上がり
    let total = 0.2;
    for (let i = 1; i < 40; i++) total += g.consume(1, i * 16, true); // 最速部分は 100 ピクセル級
    expect(total).toBeCloseTo(DEFAULT_WHEEL_GESTURE_LIMIT_NOTCHES, 9);
    // 払いが変われば、ノッチはまた制限なく効く。
    expect(g.consume(1, 40 * 16 + 1000, true)).toBe(1);
    expect(g.consume(1, 40 * 16 + 1010, true)).toBe(1);
  });

  it('0 ノッチのイベント（横スクロールなど）は 0 を返し、払いの継続時刻も累積も変えない', () => {
    const g = new WheelGestureLimiter();
    for (let i = 0; i < 100; i++) g.consume(0.2, i * 16);
    const last = 99 * 16;
    expect(g.consume(0, last + 100)).toBe(0);
    expect(g.consume(0, last + 200)).toBe(0);
    // 最後の有効なイベントから gapMs 以上あいているので、新しい払い
    expect(g.consume(0.2, last + 260)).toBeCloseTo(0.2, 12);
    // 0 ノッチのイベントでは払いは数え直されない
    const h = new WheelGestureLimiter();
    for (let i = 0; i < 100; i++) h.consume(0.2, i * 16);
    h.consume(0, last + 100);
    expect(h.consume(0.2, last + 120)).toBe(0);
  });

  it('isDiscreteWheelDelta: 行・ページ単位はノッチ、ピクセル単位は絶対値が 50 以上のときだけノッチ', () => {
    expect(DISCRETE_WHEEL_PIXEL_MIN).toBe(50);
    expect(isDiscreteWheelDelta(1, 3)).toBe(true);
    expect(isDiscreteWheelDelta(1, -1)).toBe(true);
    expect(isDiscreteWheelDelta(2, -1)).toBe(true);
    expect(isDiscreteWheelDelta(0, 100)).toBe(true);
    expect(isDiscreteWheelDelta(0, -120)).toBe(true);
    expect(isDiscreteWheelDelta(0, 50)).toBe(true);
    expect(isDiscreteWheelDelta(0, -50)).toBe(true);
    expect(isDiscreteWheelDelta(0, 49.9)).toBe(false);
    expect(isDiscreteWheelDelta(0, -12)).toBe(false);
    expect(isDiscreteWheelDelta(0, 0)).toBe(false);
  });
});
