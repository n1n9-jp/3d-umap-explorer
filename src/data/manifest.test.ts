import realManifestRaw from '../../public/data/mnist/manifest.json?raw';
import { describe, expect, it } from 'vitest';
import { MAX_LABELS, ManifestError, parseManifest } from './manifest';

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

  it(`ラベル名は ${MAX_LABELS} 個まで受け付け、それを超えると拒否する`, () => {
    const names = (n: number) => Array.from({ length: n }, (_, i) => String(i));
    const ok = validManifest();
    ok.labels.names = names(MAX_LABELS);
    expect(parseManifest(ok).labels.names).toHaveLength(MAX_LABELS);
    const ng = validManifest();
    ng.labels.names = names(MAX_LABELS + 1);
    expect(() => parseManifest(ng)).toThrow(ManifestError);
  });

  it('オブジェクトでない入力を拒否する', () => {
    expect(() => parseManifest(null)).toThrow(ManifestError);
    expect(() => parseManifest([])).toThrow(ManifestError);
  });
});

// ---------- 空間の構造 ----------

const realManifestJson = (): Record<string, any> => JSON.parse(realManifestRaw);

const structured = () => {
  const j: Record<string, any> = validManifest();
  j.count = 100;
  j.sprite = { file: 'sprite.png', cellSize: [28, 28], columns: 10, rows: 10 };
  j.bounds = { center: [0, 0, 0], radius: 1.5 };
  j.density = { k: 8, knnDistP05: 0.01, knnDistP50: 0.02, knnDistP95: 0.03 };
  j.overview = { axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] };
  j.clusters = {
    method: 'hdbscan',
    noise: 65535,
    levels: [
      {
        name: 'coarse',
        params: { minClusterSize: 10, minSamples: 5, maxClusterSize: null, selectionMethod: 'eom' },
        pointFile: 'clusters-coarse.u16',
        clusters: [
          { id: 0, name: '1', size: 30, medoid: 3, center: [0, 0, 0], radius: 0.1, bbox: [[-1, -1, -1], [1, 1, 1]], majorityLabel: 1, purity: 0.9, parent: null },
          { id: 1, name: '2', size: 20, medoid: 4, center: [0, 0, 0], radius: 0.1, bbox: [[-1, -1, -1], [1, 1, 1]], majorityLabel: 2, purity: 0.8, parent: null },
        ],
      },
      {
        name: 'fine',
        params: { minClusterSize: 5, minSamples: 2, maxClusterSize: 50, selectionMethod: 'eom' },
        pointFile: 'clusters-fine.u16',
        clusters: [
          { id: 0, name: '1', size: 12, medoid: 3, center: [0, 0, 0], radius: 0.1, bbox: [[-1, -1, -1], [1, 1, 1]], majorityLabel: 1, purity: 1, parent: 0 },
        ],
      },
    ],
  };
  return j;
};

describe('parseManifest: 空間の構造', () => {
  it('実物の public/data/mnist/manifest.json の構造を型付きで返す', () => {
    const m = parseManifest(realManifestJson());
    expect(m.bounds).toEqual({ center: [0, 0, 0], radius: 1.139497 });
    expect(m.density).toEqual({ k: 8, knnDistP05: 0.008562, knnDistP50: 0.015665, knnDistP95: 0.028776 });
    expect(m.overview?.axes).toHaveLength(3);
    expect(m.overview?.axes[0]).toEqual([0.935867, 0.243862, 0.254331]);

    const c = m.clusters!;
    expect(c.method).toBe('hdbscan');
    expect(c.noise).toBe(65535);
    expect(c.levels.map((l) => [l.name, l.pointFile, l.clusters.length])).toEqual([
      ['coarse', 'clusters-coarse.u16', 10],
      ['fine', 'clusters-fine.u16', 67],
    ]);
    expect(c.levels[0]!.params).toEqual({ minClusterSize: 200, minSamples: 5, maxClusterSize: 1500, selectionMethod: 'eom' });
    expect(c.levels[0]!.clusters[0]).toEqual({
      id: 0, name: '1', size: 1227, medoid: 1136, center: [0.87786, -0.365438, 0.117857], radius: 0.362873,
      bbox: [[0.729318, -0.539207, -0.264238], [0.992441, -0.218288, 0.528759]], majorityLabel: 1, purity: 0.920945, parent: null,
    });
    // 細かい階層は粗い階層のクラスタを parent に持つ
    const fineLast = c.levels[1]!.clusters[66]!;
    expect(fineLast.name).toBe('2 (5)');
    expect(fineLast.parent).toBe(3);
    expect(c.levels[1]!.clusters.every((k) => k.parent !== null && k.parent < 10)).toBe(true);
  });

  it('構造の項目がない manifest を読み込める', () => {
    const m = parseManifest(validManifest());
    expect(m.bounds).toBeUndefined();
    expect(m.density).toBeUndefined();
    expect(m.overview).toBeUndefined();
    expect(m.clusters).toBeUndefined();
  });

  it('ラベルのないデータセットの形（majorityLabel・purity・maxClusterSize が null）を読み込める', () => {
    const j = structured();
    for (const level of j.clusters.levels) {
      level.params.maxClusterSize = null;
      for (const k of level.clusters) { k.majorityLabel = null; k.purity = null; k.name = `C${k.id + 1}`; }
    }
    const m = parseManifest(j);
    expect(m.clusters!.levels[1]!.params.maxClusterSize).toBeNull();
    expect(m.clusters!.levels[0]!.clusters[1]).toMatchObject({ name: 'C2', majorityLabel: null, purity: null });
  });

  it('各項目の不正な形を、項目名つきのエラーにする', () => {
    const cases: Array<[string, (j: Record<string, any>) => void, RegExp]> = [
      ['bounds の半径が負', (j) => { j.bounds.radius = -1; }, /bounds\.radius/],
      ['bounds の center が3要素でない', (j) => { j.bounds.center = [0, 0]; }, /bounds\.center/],
      ['bounds がオブジェクトでない', (j) => { j.bounds = 1; }, /"bounds"/],
      ['density の k が不正', (j) => { j.density.k = 0; }, /density\.k/],
      ['density のパーセンタイルの順序が逆', (j) => { j.density.knnDistP05 = 1; }, /density/],
      ['overview の軸が2本', (j) => { j.overview.axes = [[1, 0, 0], [0, 1, 0]]; }, /overview\.axes/],
      ['overview の軸が単位ベクトルでない', (j) => { j.overview.axes[1] = [0, 2, 0]; }, /overview\.axes\[1\]/],
      ['clusters.levels が空', (j) => { j.clusters.levels = []; }, /clusters\.levels/],
      ['階層の pointFile がない', (j) => { delete j.clusters.levels[1].pointFile; }, /levels\[1\]\.pointFile/],
      ['階層の名前が重複', (j) => { j.clusters.levels[1].name = 'coarse'; }, /重複/],
      ['clusters.noise が範囲外', (j) => { j.clusters.noise = 70000; }, /clusters\.noise/],
      ['params.maxClusterSize が欠けている', (j) => { delete j.clusters.levels[0].params.maxClusterSize; }, /maxClusterSize/],
      ['クラスタの項目が欠けている（medoid）', (j) => { delete j.clusters.levels[0].clusters[1].medoid; }, /clusters\[1\]\.medoid/],
      ['クラスタの id が添字と一致しない', (j) => { j.clusters.levels[0].clusters[1].id = 5; }, /clusters\[1\]\.id/],
      ['クラスタの bbox の最小が最大を上回る', (j) => { j.clusters.levels[0].clusters[0].bbox = [[2, 0, 0], [1, 1, 1]]; }, /bbox/],
      ['majorityLabel だけが null', (j) => { j.clusters.levels[0].clusters[0].majorityLabel = null; }, /majorityLabel/],
      ['majorityLabel がラベルの範囲外', (j) => { j.clusters.levels[0].clusters[0].majorityLabel = 10; }, /majorityLabel/],
      ['purity が 1 を超える', (j) => { j.clusters.levels[0].clusters[0].purity = 1.5; }, /purity/],
      ['最も粗い階層の parent が null でない', (j) => { j.clusters.levels[0].clusters[0].parent = 0; }, /parent/],
      ['細かい階層の parent が粗い階層の範囲外', (j) => { j.clusters.levels[1].clusters[0].parent = 2; }, /levels\[1\]\.clusters\[0\]\.parent/],
      ['クラスタの size の合計が点の数を超える', (j) => { j.clusters.levels[0].clusters[0].size = 90; }, /size の合計/],
    ];
    for (const [title, mutate, pattern] of cases) {
      const j = structured();
      mutate(j);
      expect(() => parseManifest(j), title).toThrow(ManifestError);
      expect(() => parseManifest(j), title).toThrow(pattern);
    }
  });

  it('不正のない構造は受け付ける（上の変形の元データの健全性）', () => {
    expect(() => parseManifest(structured())).not.toThrow();
  });
});
