import { describe, expect, it } from 'vitest';
import { ManifestError, parseManifest } from './manifest';

export const validManifest = () => ({
  name: 'MNIST 10k',
  count: 10000,
  positions: { file: 'positions.f32', dtype: 'float32', components: 3 },
  labels: { file: 'labels.u8', dtype: 'uint8', names: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'] },
  sprite: { file: 'sprite.png', cellSize: [28, 28], columns: 100, rows: 100 },
  umap: { library: 'umap-learn 0.6.0' },
});

describe('parseManifest', () => {
  it('README の例をそのまま受け付ける', () => {
    const m = parseManifest(validManifest());
    expect(m.count).toBe(10000);
    expect(m.sprite.cellSize).toEqual([28, 28]);
    expect(m.labels.names).toHaveLength(10);
    expect(m.umap).toEqual({ library: 'umap-learn 0.6.0' });
  });

  it('対応していない dtype を拒否する', () => {
    const j = validManifest();
    j.positions.dtype = 'float64';
    expect(() => parseManifest(j)).toThrow(ManifestError);
  });

  it('アトラスのセルが点の数より少なければ拒否する', () => {
    const j = validManifest();
    j.sprite.rows = 99;
    expect(() => parseManifest(j)).toThrow(/セル数/);
  });

  it('count が正の整数でなければ拒否する', () => {
    expect(() => parseManifest({ ...validManifest(), count: 0 })).toThrow(ManifestError);
    expect(() => parseManifest({ ...validManifest(), count: 1.5 })).toThrow(ManifestError);
  });

  it('オブジェクトでない入力を拒否する', () => {
    expect(() => parseManifest(null)).toThrow(ManifestError);
    expect(() => parseManifest([])).toThrow(ManifestError);
  });
});
