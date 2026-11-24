import { describe, expect, it } from 'vitest';
import { TOP_BAR_BOTTOM_MARGIN, TOP_BAR_GAP, TOP_BAR_MIN_HEIGHT, topBarHeight } from './topLayout';

const box = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });

describe('topBarHeight', () => {
  it('下の UI と横の範囲が重ならなければ、画面の下端の余白まで', () => {
    const h = topBarHeight({ viewportHeight: 800, top: 10, columns: [box(900, 10, 1268, 300)], obstacles: [box(12, 700, 700, 790)] });
    expect(h).toBe(800 - TOP_BAR_BOTTOM_MARGIN - 10);
  });

  it('横の範囲が重なる下の UI（右下のミニマップなど）の上端の手前まで', () => {
    const h = topBarHeight({ viewportHeight: 800, top: 10, columns: [box(900, 10, 1268, 300)], obstacles: [box(1050, 580, 1268, 790), box(12, 700, 700, 790)] });
    expect(h).toBe(580 - TOP_BAR_GAP - 10);
  });

  it('列のどれか 1 つでも重なれば避ける。いちばん高い上端に合わせる', () => {
    const h = topBarHeight({
      viewportHeight: 740, top: 10,
      columns: [box(100, 80, 348, 120), box(10, 130, 348, 400)],
      obstacles: [box(12, 560, 340, 730), box(12, 520, 300, 552), box(250, 600, 348, 730)],
    });
    expect(h).toBe(520 - TOP_BAR_GAP - 10);
  });

  it('大きさのない矩形は無視する。下限より低くはしない', () => {
    expect(topBarHeight({ viewportHeight: 800, top: 10, columns: [box(0, 0, 100, 100)], obstacles: [box(0, 50, 100, 50)] })).toBe(780);
    expect(topBarHeight({ viewportHeight: 100, top: 10, columns: [box(0, 0, 100, 100)], obstacles: [box(0, 20, 100, 90)] })).toBe(TOP_BAR_MIN_HEIGHT);
  });
});
