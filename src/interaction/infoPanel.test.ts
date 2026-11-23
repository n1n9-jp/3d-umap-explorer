import { describe, expect, it } from 'vitest';
import { clusterText, coarseClusterName, imageAltText, selectionAnnouncement } from './infoPanel';

describe('情報パネルの文言', () => {
  it('画像の代替テキストに数字が入る', () => {
    expect(imageAltText('6')).toBe('手書きの数字 6 の画像');
  });

  it('クラスタ名の表示（ノイズ・情報なし）', () => {
    expect(clusterText('くるっと丸い 6')).toBe('くるっと丸い 6');
    expect(clusterText(null)).toBe('なし（ノイズ）');
    expect(clusterText(undefined)).toBe('（情報なし）');
  });

  it('単語のデータセットでは、クラスタなしは「なし」、読み上げは「選択した単語」', () => {
    expect(clusterText(null, 'text')).toBe('なし');
    expect(clusterText('nodes、node、operators', 'text')).toBe('nodes、node、operators');
    expect(selectionAnnouncement('king', 42, 'なし', 'text')).toBe('選択した単語: king、番号 42、クラスタ なし');
    expect(selectionAnnouncement('6', 1, 'a')).toBe('選択した点: 6、番号 1、クラスタ a');
  });

  it('読み上げる文にラベル・番号・クラスタ名が入る', () => {
    const text = selectionAnnouncement('6', 123, 'なし（ノイズ）');
    expect(text).toContain('6');
    expect(text).toContain('123');
    expect(text).toContain('なし（ノイズ）');
  });

  it('coarseClusterName: ノイズは null、情報がなければ undefined', () => {
    const coarse = { ids: new Uint16Array([0, 65535]), names: ['a'], noise: 65535 };
    expect(coarseClusterName({ coarse }, 0)).toBe('a');
    expect(coarseClusterName({ coarse }, 1)).toBeNull();
    expect(coarseClusterName({ coarse: null }, 0)).toBeUndefined();
  });
});
