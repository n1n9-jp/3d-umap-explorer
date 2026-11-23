import { describe, expect, it } from 'vitest';
import { LABEL_COLORS } from '../render/palette';
import { appendHudHelp, clusterColor, formatLocation } from './format';

describe('clusterColor', () => {
  it('多数派ラベルのパレット色。ラベルがなければ id で引く', () => {
    expect(clusterColor({ id: 4, majorityLabel: 3 })).toBe(LABEL_COLORS[3]);
    expect(clusterColor({ id: 4, majorityLabel: null })).toBe(LABEL_COLORS[4]);
    expect(clusterColor({ id: 4, majorityLabel: 13 })).toBe(LABEL_COLORS[3]);
    expect(clusterColor({ id: 12, majorityLabel: null })).toBe(LABEL_COLORS[2]);
  });
});

describe('formatLocation', () => {
  it('内部は「現在地: 3 のクラスタ」', () => {
    expect(formatLocation({ kind: 'inside', id: 7, distance: 0.1 }, '3', null)).toEqual({ kind: 'inside', text: '現在地: 3 のクラスタ' });
  });
  it('外は最寄りの名前・方向・縁までの距離', () => {
    const v = formatLocation({ kind: 'nearest', id: 1, distance: 0.4249 }, '7', { arrow: '↗', word: '右上' });
    expect(v).toEqual({ kind: 'nearest', text: '最寄り: 7 のクラスタ  ↗ 右上 · 縁まで 0.42' });
  });
  it('クラスタがなければ null', () => {
    expect(formatLocation({ kind: 'none' }, '', null)).toBeNull();
  });
});

describe('appendHudHelp', () => {
  it('操作説明の行（3 行目）の末尾へ足す。ほかの行は変えない', () => {
    expect(appendHudHelp('a\nb\nc\nd', 'L 目印')).toBe('a\nb\nc / L 目印\nd');
  });
  it('行が足りなければそのまま', () => {
    expect(appendHudHelp('a\nb', 'L')).toBe('a\nb');
  });
});
