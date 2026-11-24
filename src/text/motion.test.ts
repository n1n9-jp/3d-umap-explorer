import { describe, expect, it } from 'vitest';
import {
  BASE_INTERVAL_MS, COST_FACTOR, FAST_INTERVAL_MS, FAST_MOTION_PX, MAX_MOTION_MARGIN_PX, maxAnchorDisplacement, motionMarginPx, selectIntervalMs,
} from './motion';

describe('選び直しの間隔', () => {
  it('動きが小さければ基本の間隔', () => {
    expect(selectIntervalMs(0, 1)).toBe(BASE_INTERVAL_MS);
    expect(selectIntervalMs(FAST_MOTION_PX - 0.1, 1)).toBe(BASE_INTERVAL_MS);
  });
  it('動きが大きければ短くする。選び直しが軽ければ下限は FAST_INTERVAL_MS', () => {
    expect(selectIntervalMs(FAST_MOTION_PX, 1)).toBe(FAST_INTERVAL_MS);
    expect(selectIntervalMs(500, 2)).toBe(FAST_INTERVAL_MS);
  });
  it('選び直しが重いときは、その時間の COST_FACTOR 倍以上を空ける（ただし基本の間隔を超えない）', () => {
    expect(selectIntervalMs(500, 10)).toBeCloseTo(COST_FACTOR * 10);
    expect(selectIntervalMs(500, 40)).toBe(BASE_INTERVAL_MS);
  });
  it('NaN や負の時間でも壊れない', () => {
    expect(selectIntervalMs(NaN, 1)).toBe(BASE_INTERVAL_MS);
    expect(selectIntervalMs(500, NaN)).toBe(FAST_INTERVAL_MS);
    expect(selectIntervalMs(500, -3)).toBe(FAST_INTERVAL_MS);
  });
});

describe('障害物との間隔の余裕', () => {
  it('動いていなければ 0', () => {
    expect(motionMarginPx(0, 100)).toBe(0);
    expect(motionMarginPx(10, 0)).toBe(0);
  });
  it('速さ × 0.1 秒。上限がある', () => {
    expect(motionMarginPx(20, 100)).toBeCloseTo(20); // 200 px/s × 0.1 s
    expect(motionMarginPx(1000, 100)).toBe(MAX_MOTION_MARGIN_PX);
  });
  it('選び直しの直後（経過がごく短い）でも、速さを過大に見積もらない', () => {
    expect(motionMarginPx(5, 1)).toBeLessThanOrEqual(MAX_MOTION_MARGIN_PX);
    expect(motionMarginPx(5, 1)).toBeCloseTo(5 / (FAST_INTERVAL_MS / 2 / 1000) * 0.1);
  });
});

describe('基準点の移動量', () => {
  it('最大の移動量を返す。カメラの後ろへ回った点は大きな値', () => {
    const before = [{ x: 0, y: 0 }, { x: 10, y: 10 }];
    expect(maxAnchorDisplacement(before, [{ x: 3, y: 4 }, { x: 10, y: 10 }])).toBe(5);
    expect(maxAnchorDisplacement(before, [{ x: 3, y: 4 }, null])).toBeGreaterThan(1000);
    expect(maxAnchorDisplacement([], [])).toBe(0);
  });
});
