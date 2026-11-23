import { describe, expect, it } from 'vitest';
import { LABEL_COLORS } from '../render/palette';
import { chipText, clusterColor, formatLocation } from './format';

describe('clusterColor', () => {
  it('多数派ラベルのパレット色。ラベルがなければ id で引く', () => {
    expect(clusterColor({ id: 4, majorityLabel: 3 })).toBe(LABEL_COLORS[3]);
    expect(clusterColor({ id: 4, majorityLabel: null })).toBe(LABEL_COLORS[4]);
    expect(clusterColor({ id: 4, majorityLabel: 13 })).toBe(LABEL_COLORS[3]);
    expect(clusterColor({ id: 12, majorityLabel: null })).toBe(LABEL_COLORS[2]);
  });
  it('クラスタで色分けするデータセットでは id の色（点の色と一致）', () => {
    expect(clusterColor({ id: 13, majorityLabel: null }, 'cluster')).toBe(LABEL_COLORS[3]);
    expect(clusterColor({ id: 4, majorityLabel: 3 }, 'cluster')).toBe(LABEL_COLORS[4]);
  });
});

describe('chipText', () => {
  it('代表の単語があれば · で区切り、なければ name', () => {
    expect(chipText({ name: 'nodes、node、operators', terms: ['nodes', 'node', 'operators'] })).toBe('nodes · node · operators');
    expect(chipText({ name: '3' })).toBe('3');
    expect(chipText({ name: 'C1', terms: [] })).toBe('C1');
  });
});

describe('formatLocation', () => {
  it('内部は「現在地: 3 のクラスタ」', () => {
    expect(formatLocation({ kind: 'inside', id: 7, distance: 0.1 }, '3', null)).toEqual({ kind: 'inside', text: '現在地: 3 のクラスタ' });
  });
  it('外は最寄りの名前と方向だけ（距離は文面に入れない）', () => {
    const v = formatLocation({ kind: 'nearest', id: 1, distance: 0.4249 }, '7', { arrow: '↗', word: '右上' });
    expect(v).toEqual({ kind: 'nearest', text: '最寄り: 7 のクラスタ ↗ 右上' });
    const near = formatLocation({ kind: 'nearest', id: 1, distance: 0.0123 }, '7', { arrow: '↗', word: '右上' });
    expect(near?.text).toBe(v?.text); // 距離が変わっても文面は変わらない
  });
  it('方向がなければ名前だけ', () => {
    expect(formatLocation({ kind: 'nearest', id: 1, distance: 1 }, '7', null)?.text).toBe('最寄り: 7 のクラスタ');
  });
  it('クラスタがなければ null', () => {
    expect(formatLocation({ kind: 'none' }, '', null)).toBeNull();
  });
});
