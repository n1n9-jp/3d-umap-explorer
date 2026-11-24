import { describe, expect, it } from 'vitest';
import { SCROLLBAR_ALLOWANCE, TOP_BAR_BOTTOM_MARGIN, TOP_BAR_GAP, TOP_BAR_MIN_HEIGHT, columnBox, topBarHeight, type Box } from './topLayout';

const box = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });

describe('topBarHeight', () => {
  it('列がない（表示されている要素がない）ときは、画面の下端の余白まで', () => {
    expect(topBarHeight({ viewportHeight: 800, top: 10, column: null, obstacles: [box(12, 700, 700, 790), box(1050, 580, 1268, 790)] })).toBe(800 - TOP_BAR_BOTTOM_MARGIN - 10);
  });

  it('下の UI と横の範囲が重ならなければ、画面の下端の余白まで', () => {
    const h = topBarHeight({ viewportHeight: 800, top: 10, column: box(900, 10, 1268, 300), obstacles: [box(12, 700, 700, 790)] });
    expect(h).toBe(800 - TOP_BAR_BOTTOM_MARGIN - 10);
  });

  it('横の範囲が重なる下の UI（右下のミニマップなど）の上端の手前まで', () => {
    const h = topBarHeight({ viewportHeight: 800, top: 10, column: box(900, 10, 1268, 300), obstacles: [box(1050, 580, 1268, 790), box(12, 700, 700, 790)] });
    expect(h).toBe(580 - TOP_BAR_GAP - 10);
  });

  it('重なる下の UI が複数あれば、いちばん高い上端に合わせる', () => {
    const h = topBarHeight({
      viewportHeight: 740, top: 10,
      column: box(100, 10, 348, 400),
      obstacles: [box(12, 560, 340, 730), box(12, 520, 300, 552), box(250, 600, 348, 730)],
    });
    expect(h).toBe(520 - TOP_BAR_GAP - 10);
  });

  it('接しているだけ（端が同じ）の下の UI は、重なりに数えない', () => {
    const h = topBarHeight({ viewportHeight: 800, top: 10, column: box(500, 10, 900, 300), obstacles: [box(100, 500, 500, 790), box(900, 500, 1200, 790)] });
    expect(h).toBe(800 - TOP_BAR_BOTTOM_MARGIN - 10);
  });

  it('大きさのない矩形は無視する。下限より低くはしない', () => {
    expect(topBarHeight({ viewportHeight: 800, top: 10, column: box(0, 0, 100, 100), obstacles: [box(0, 50, 100, 50)] })).toBe(780);
    expect(topBarHeight({ viewportHeight: 100, top: 10, column: box(0, 0, 100, 100), obstacles: [box(0, 20, 100, 90)] })).toBe(TOP_BAR_MIN_HEIGHT);
  });
});

describe('columnBox', () => {
  const frame = box(329, 10, 1268, 790);

  it('表示されている要素がなければ null', () => {
    expect(columnBox({ frame, switcherWidth: null, panelWidths: [], panelsRow: true, panelGap: 8 })).toBeNull();
  });

  it('右端は列の枠の右端。左端は、最も幅の広い要素の幅とスクロールバーの余裕の分だけ左', () => {
    const b = columnBox({ frame, switcherWidth: 720, panelWidths: [300, 346], panelsRow: true, panelGap: 8 })!;
    expect(b.right).toBe(1268);
    expect(b.left).toBe(1268 - 720 - SCROLLBAR_ALLOWANCE);
    expect(b.top).toBe(10);
    expect(b.bottom).toBe(790);
  });

  it('パネルを横に並べるときは幅と間隔の合計、縦に重ねるときは広いほう', () => {
    expect(columnBox({ frame, switcherWidth: 100, panelWidths: [300, 560], panelsRow: true, panelGap: 8 })!.left).toBe(1268 - (300 + 8 + 560) - SCROLLBAR_ALLOWANCE);
    expect(columnBox({ frame, switcherWidth: 100, panelWidths: [300, 560], panelsRow: false, panelGap: 8 })!.left).toBe(1268 - 560 - SCROLLBAR_ALLOWANCE);
    expect(columnBox({ frame, switcherWidth: null, panelWidths: [346], panelsRow: true, panelGap: 8 })!.left).toBe(1268 - 346 - SCROLLBAR_ALLOWANCE);
  });

  it('列の枠より左へは出ない', () => {
    expect(columnBox({ frame, switcherWidth: 2000, panelWidths: [], panelsRow: true, panelGap: 8 })!.left).toBe(329);
  });
});

describe('高さの決め直しが落ち着くこと（スクロールバーによる幅の変化との循環）', () => {
  // パネルは中身が収まらないとき（高さ < CONTENT）だけスクロールバーが出て、右端をそろえたまま幅が SB 増える（矩形の左端が SB だけ左へ動く）。
  // 障害物（HUD）の右端は、スクロールバーのないパネルの左端のすぐ左にある（スクロールバーが出ると重なる）。
  // HUD の上端は、重なったときの高さ（232）が CONTENT より低くなる位置。
  const SB = 15, PANEL_W = 346, CONTENT = 300, RIGHT = 1268, TOP = 10;
  const frame = box(329, TOP, RIGHT, 790);
  const hud = box(12, 250, RIGHT - PANEL_W - 5, 790);
  const scrolls = (barHeight: number) => barHeight < CONTENT;
  /** 矩形（getBoundingClientRect）から求めた範囲: スクロールバーが出ると、左端が左へ動く */
  const byRect = (h: number): Box => box(RIGHT - PANEL_W - (scrolls(h) ? SB : 0), TOP, RIGHT, TOP + h);
  /** スクロールバーを含まない幅から求めた範囲（`columnBox`）: スクロールバーの有無に依らない */
  const byWidth = (_h: number): Box => columnBox({ frame, switcherWidth: null, panelWidths: [PANEL_W], panelsRow: true, panelGap: 8 })!;
  const step = (h: number, column: (h: number) => Box) => topBarHeight({ viewportHeight: 800, top: TOP, column: column(h), obstacles: [hud] });
  const settle = (start: number, column: (h: number) => Box) => { let h = start; for (let i = 0; i < 10; i++) h = step(h, column); return h; };
  const starts = [780, 400, 299, 100, 50];

  it('前提: 矩形から求めると、高さの 2 つの値のどちらにも留まりうる（スクロールバーが出ると重なって低く、出なければ重ならず高い）', () => {
    expect(new Set(starts.map((h) => settle(h, byRect))).size).toBeGreaterThan(1);
  });

  it('スクロールバーを含まない幅から求めると、始めの高さによらず、同じ高さに落ち着く', () => {
    const results = new Set(starts.map((h) => settle(h, byWidth)));
    expect(results.size).toBe(1);
    const h = [...results][0]!;
    expect(step(h, byWidth)).toBe(h); // 落ち着いた高さから決め直しても変わらない
  });
});
