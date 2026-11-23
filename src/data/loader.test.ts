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

describe('loadDatasetArrays: 空間の構造', () => {
  const positions = new Float32Array([1, 0, -0.5, -1, 0.5, 0]).buffer;
  const u16 = (...v: number[]) => new Uint16Array(v).buffer;
  const cluster = (id: number, parent: number | null) => ({
    id, name: `C${id + 1}`, size: 1, medoid: id, center: [0, 0, 0], radius: 0.1,
    bbox: [[-1, -1, -1], [1, 1, 1]], majorityLabel: null, purity: null, parent,
  });
  const structured = {
    ...manifest,
    bounds: { center: [0, 0.1, 0], radius: 2 },
    clusters: {
      method: 'hdbscan',
      noise: 65535,
      levels: [
        { name: 'coarse', params: { minClusterSize: 1, minSamples: 1, maxClusterSize: null, selectionMethod: 'eom' },
          pointFile: 'clusters-coarse.u16', clusters: [cluster(0, null)] },
        { name: 'fine', params: { minClusterSize: 1, minSamples: 1, maxClusterSize: null, selectionMethod: 'eom' },
          pointFile: 'clusters-fine.u16', clusters: [cluster(0, 0), cluster(1, 0)] },
      ],
    },
  };
  const files = (coarse: ArrayBuffer, fine: ArrayBuffer) => ({
    'data/t/manifest.json': structured,
    'data/t/positions.f32': positions,
    'data/t/labels.u8': new Uint8Array([0, 1]).buffer,
    'data/t/clusters-coarse.u16': coarse,
    'data/t/clusters-fine.u16': fine,
  });

  it('各階層の pointFile を読み、noise を許す', async () => {
    const d = await loadDatasetArrays('data/t/', fakeFetch(files(u16(0, 65535), u16(1, 0))));
    expect(d.clusterAssignments?.map((a) => a.level)).toEqual(['coarse', 'fine']);
    expect(d.clusterAssignments?.[0]?.ids).toBeInstanceOf(Uint16Array);
    expect(Array.from(d.clusterAssignments![0]!.ids)).toEqual([0, 65535]);
    expect(Array.from(d.clusterAssignments![1]!.ids)).toEqual([1, 0]);
  });

  it('構造のない manifest では clusterAssignments を返さない', async () => {
    const d = await loadDatasetArrays('data/t/', fakeFetch({
      'data/t/manifest.json': manifest,
      'data/t/positions.f32': positions,
      'data/t/labels.u8': new Uint8Array([0, 1]).buffer,
    }));
    expect(d.clusterAssignments).toBeUndefined();
  });

  it('pointFile の長さが合わなければエラー', async () => {
    await expect(loadDatasetArrays('data/t/', fakeFetch(files(u16(0), u16(1, 0)))))
      .rejects.toThrow(/clusters-coarse\.u16.*バイト長/);
    await expect(loadDatasetArrays('data/t/', fakeFetch(files(u16(0, 0), u16(1, 0, 0)))))
      .rejects.toThrow(/clusters-fine\.u16.*バイト長/);
  });

  it('クラスタの id が範囲外（noise 以外）ならエラー', async () => {
    // coarse のクラスタは 1 個なので id 1 は範囲外、fine は 2 個なので id 2 は範囲外
    await expect(loadDatasetArrays('data/t/', fakeFetch(files(u16(0, 1), u16(1, 0)))))
      .rejects.toThrow(/clusters-coarse\.u16.*点 1.*範囲外/);
    await expect(loadDatasetArrays('data/t/', fakeFetch(files(u16(0, 0), u16(2, 0)))))
      .rejects.toThrow(/clusters-fine\.u16.*点 0.*範囲外/);
    await expect(loadDatasetArrays('data/t/', fakeFetch(files(u16(0, 0), u16(65534, 0)))))
      .rejects.toThrow(/範囲外/);
  });

  it('pointFile が取得できなければ HTTP ステータスつきのエラー', async () => {
    const f: Record<string, unknown> = files(u16(0, 0), u16(0, 0));
    delete f['data/t/clusters-fine.u16'];
    await expect(loadDatasetArrays('data/t/', fakeFetch(f))).rejects.toThrow(/clusters-fine\.u16.*404/);
  });

  it('bounds は manifest の値を使い、min/max は座標から計算する', async () => {
    const d = await loadDatasetArrays('data/t/', fakeFetch(files(u16(0, 0), u16(0, 1))));
    expect(d.bounds.center).toEqual([0, 0.1, 0]);
    expect(d.bounds.radius).toBe(2);
    expect(d.bounds.min).toEqual([-1, 0, -0.5]);
    expect(d.bounds.max).toEqual([1, 0.5, 0]);
  });

  it('manifest に bounds がなければ座標から計算する（原点中心）', async () => {
    const f: Record<string, unknown> = files(u16(0, 0), u16(0, 1));
    const { bounds: _omitted, ...withoutBounds } = structured;
    f['data/t/manifest.json'] = withoutBounds;
    const d = await loadDatasetArrays('data/t/', fakeFetch(f));
    expect(d.bounds.center).toEqual([0, 0, 0]);
    expect(d.bounds.radius).toBeCloseTo(Math.hypot(1, 0, 0.5));
  });
});

describe('computeBounds', () => {
  it('外接球の半径は原点からの最大距離', () => {
    expect(computeBounds(new Float32Array([0, 0, 0, 3, 4, 0])).radius).toBe(5);
  });
});
