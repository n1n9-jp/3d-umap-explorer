import { describe, expect, it } from 'vitest';
import { computeBounds, loadDatasetArrays, resolveDataUrl, type FetchLike } from './loader';

function fakeFetch(files: Record<string, unknown>): FetchLike {
  return async (url: string) => {
    const body = files[url];
    if (body === undefined) return { ok: false, status: 404, json: async () => null, arrayBuffer: async () => new ArrayBuffer(0) };
    return {
      ok: true,
      status: 200,
      json: async () => body,
      arrayBuffer: async () => body as ArrayBuffer,
    };
  };
}

const manifest = {
  name: 'tiny',
  count: 2,
  positions: { file: 'positions.f32', dtype: 'float32', components: 3 },
  labels: { file: 'labels.u8', dtype: 'uint8', names: ['a', 'b'] },
  sprite: { file: 'sprite.png', cellSize: [28, 28], columns: 2, rows: 1 },
};

describe('resolveDataUrl', () => {
  it('末尾のスラッシュの有無によらず連結する', () => {
    expect(resolveDataUrl('data/mnist', 'a.bin')).toBe('data/mnist/a.bin');
    expect(resolveDataUrl('data/mnist/', 'a.bin')).toBe('data/mnist/a.bin');
  });
});

describe('loadDatasetArrays', () => {
  const positions = new Float32Array([1, 0, -0.5, -1, 0.5, 0]).buffer;

  it('manifest とバイナリを読み、境界を計算する', async () => {
    const d = await loadDatasetArrays('data/t/', fakeFetch({
      'data/t/manifest.json': manifest,
      'data/t/positions.f32': positions,
      'data/t/labels.u8': new Uint8Array([0, 1]).buffer,
    }));
    expect(d.positions).toHaveLength(6);
    expect(Array.from(d.labels)).toEqual([0, 1]);
    expect(d.bounds.min).toEqual([-1, 0, -0.5]);
    expect(d.bounds.max).toEqual([1, 0.5, 0]);
    expect(d.bounds.radius).toBeCloseTo(Math.hypot(1, 0, 0.5));
  });

  it('ラベルが names の範囲外ならエラー', async () => {
    await expect(loadDatasetArrays('data/t/', fakeFetch({
      'data/t/manifest.json': manifest,
      'data/t/positions.f32': positions,
      'data/t/labels.u8': new Uint8Array([0, 2]).buffer,
    }))).rejects.toThrow(/範囲外/);
  });

  it('ファイルがなければ HTTP ステータスつきのエラー', async () => {
    await expect(loadDatasetArrays('data/t/', fakeFetch({ 'data/t/manifest.json': manifest }))).rejects.toThrow(/404/);
  });
});

describe('computeBounds', () => {
  it('外接球の半径は原点からの最大距離', () => {
    expect(computeBounds(new Float32Array([0, 0, 0, 3, 4, 0])).radius).toBe(5);
  });
});
