import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, DOTS_ONLY_MAX_RADIUS_PX, DOTS_ONLY_PARAMS } from './pointCloud';
import { dotDiameterPx } from './pointSize';
import { fragmentShader, highlightVertexShader } from './shaders';
import { DEFAULT_TEXT_SIZE } from '../text/selection';

describe('画像のないデータセットの丸い点の大きさ', () => {
  const dotRadius = DOTS_ONLY_PARAMS.dotRadius!;

  it('シェーダと強調表示の輪が、同じ式（半径 = min(比 × 1 辺, 上限)）を使う', () => {
    expect(fragmentShader).toContain('float radiusPx = min(uDotRadius.x * vPx, uDotRadius.y);');
    expect(highlightVertexShader).toContain('min(uDotRadius.x * shownPx, uDotRadius.y)');
  });

  it('直径の上限が、単語の文字の高さの下限より小さい（丸い点が単語の文字より目立たない）', () => {
    expect(dotRadius[1]).toBe(DOTS_ONLY_MAX_RADIUS_PX);
    const maxDiameter = dotDiameterPx(1e6, dotRadius);
    expect(maxDiameter).toBe(2 * DOTS_ONLY_MAX_RADIUS_PX);
    expect(maxDiameter).toBeLessThan(DEFAULT_TEXT_SIZE.minPx);
  });

  it('最小サイズから上限までは、近い（画面上で大きい）点ほど大きい（奥行きの手がかりを残す）', () => {
    const min = dotDiameterPx(DEFAULT_PARAMS.minPixelSize, dotRadius);
    expect(min).toBe(DEFAULT_PARAMS.minPixelSize);
    const sizes = [3, 4, 6, 8, 10];
    const d = sizes.map((s) => dotDiameterPx(s, dotRadius));
    for (let k = 1; k < d.length; k++) expect(d[k]!).toBeGreaterThan(d[k - 1]!);
    // 上限は最小サイズの 3 倍以上（近い点と遠い点の差が見て分かる）
    expect(dotDiameterPx(1e6, dotRadius) / min).toBeGreaterThanOrEqual(3);
  });

  it('単語の文字を出している点（倍率 0）は消える', () => {
    expect(dotDiameterPx(20, dotRadius, 0)).toBe(0);
  });

  it('画像のあるデータセット（MNIST）の既定値は変えない', () => {
    expect(DEFAULT_PARAMS.dotRadius).toEqual([0.4, 2.2]);
  });
});
