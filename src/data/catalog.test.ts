import { describe, expect, it } from 'vitest';
import realCatalogRaw from '../../public/data/datasets.json?raw';
import { FALLBACK_CATALOG, datasetParamValue, normalizeDir, parseCatalog, resolveDatasetParam, searchForDataset } from './catalog';

const catalog = parseCatalog(JSON.parse(realCatalogRaw));

describe('parseCatalog', () => {
  it('実物の datasets.json を読み込める', () => {
    expect(catalog.defaultId).toBe('mnist');
    expect(catalog.datasets.map((d) => d.id)).toEqual(['mnist', 'word2vec-10k']);
    expect(catalog.datasets[1]!.dir).toBe('data/word2vec-10k/');
  });

  it('dir の末尾を / にそろえ、default がなければ先頭', () => {
    const c = parseCatalog({ datasets: [{ id: 'a', name: 'A', dir: 'data/a' }] });
    expect(c).toEqual({ defaultId: 'a', datasets: [{ id: 'a', name: 'A', dir: 'data/a/' }] });
  });

  it('不正な一覧を拒否する', () => {
    expect(() => parseCatalog(null)).toThrow();
    expect(() => parseCatalog({ datasets: [] })).toThrow(/datasets/);
    expect(() => parseCatalog({ datasets: [{ id: 'a b', name: 'A', dir: 'd/' }] })).toThrow(/id/);
    expect(() => parseCatalog({ datasets: [{ id: 'a', name: '', dir: 'd/' }] })).toThrow(/name/);
    expect(() => parseCatalog({ datasets: [{ id: 'a', name: 'A', dir: 'https://x/' }] })).toThrow(/dir/);
    expect(() => parseCatalog({ datasets: [{ id: 'a', name: 'A', dir: 'd/' }, { id: 'a', name: 'B', dir: 'e/' }] })).toThrow(/重複/);
    expect(() => parseCatalog({ default: 'z', datasets: [{ id: 'a', name: 'A', dir: 'd/' }] })).toThrow(/default/);
  });
});

describe('normalizeDir', () => {
  it('先頭の ./ と / を外し、末尾を / にする', () => {
    expect(normalizeDir('data/mnist')).toBe('data/mnist/');
    expect(normalizeDir('./data/mnist/')).toBe('data/mnist/');
    expect(normalizeDir('/data/mnist/')).toBe('data/mnist/');
  });

  it('別のオリジンや public/ の外へのパスは null', () => {
    for (const bad of ['https://example.com/d/', '//example.com/d/', 'javascript:alert(1)', '../secret/', 'data/../../x', '', '  ', 'a\\b']) {
      expect(normalizeDir(bad)).toBeNull();
    }
  });
});

describe('resolveDatasetParam', () => {
  it('値がなければ既定のデータセット', () => {
    expect(resolveDatasetParam(null, catalog)).toEqual({ dir: 'data/mnist/', entry: catalog.datasets[0] });
    expect(resolveDatasetParam('', catalog).entry?.id).toBe('mnist');
  });

  it('id で指定できる', () => {
    expect(resolveDatasetParam('word2vec-10k', catalog)).toEqual({ dir: 'data/word2vec-10k/', entry: catalog.datasets[1] });
  });

  it('これまでのパスの形（data/mnist/）でも指定でき、一覧の項目と対応づける', () => {
    expect(resolveDatasetParam('data/mnist/', catalog).entry?.id).toBe('mnist');
    expect(resolveDatasetParam('data/word2vec-10k', catalog).entry?.id).toBe('word2vec-10k');
  });

  it('一覧にないパスは、項目なしのデータセット', () => {
    expect(resolveDatasetParam('data/other/', catalog)).toEqual({ dir: 'data/other/', entry: null });
  });

  it('/ を含まず一覧の id でもない値は、一覧にないことを示すエラー', () => {
    expect(() => resolveDatasetParam('no-such-id', catalog)).toThrow(/no-such-id.*一覧にありません/);
  });

  it('別のオリジンは拒否する', () => {
    expect(() => resolveDatasetParam('https://example.com/data/', catalog)).toThrow(/使えません/);
  });

  it('予備の一覧でも働く', () => {
    expect(resolveDatasetParam(null, FALLBACK_CATALOG).dir).toBe('data/mnist/');
  });
});

describe('URL の更新', () => {
  it('一覧にあれば id、なければパスを書き、前の視点と点の大きさを外してほかのパラメータは残す', () => {
    const w = resolveDatasetParam('word2vec-10k', catalog);
    expect(datasetParamValue(w)).toBe('word2vec-10k');
    expect(searchForDataset('?data=data/mnist/&pos=1,2,3&look=0,0,0&size=0.01&x=1', w)).toBe('?data=word2vec-10k&x=1');
    expect(searchForDataset('', resolveDatasetParam('data/other', catalog))).toBe('?data=data/other/');
  });
});
