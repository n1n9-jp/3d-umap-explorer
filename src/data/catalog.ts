/**
 * データセットの一覧（`public/data/datasets.json`）と、URL パラメータ `?data=` の解釈。DOM に依存しない。
 *
 * `datasets.json` の形: `{ "default": "mnist", "datasets": [{ "id": "mnist", "name": "MNIST 10k", "dir": "data/mnist/" }] }`。
 * `?data=` は、一覧の id（`?data=word2vec-10k`）か、`public/` からの相対パス（`?data=data/mnist/`）で指定する。
 */

export interface DatasetEntry {
  /** URL の `?data=` に使う名前（英数字・`-`・`_`・`.`） */
  id: string;
  /** 選択欄に出す名前 */
  name: string;
  /** `public/` からの相対パス。末尾は `/` */
  dir: string;
}

export interface DatasetCatalog {
  datasets: DatasetEntry[];
  /** 既定のデータセットの id */
  defaultId: string;
}

/** 一覧が読めないときに使う一覧（MNIST だけ）。 */
export const FALLBACK_CATALOG: DatasetCatalog = {
  datasets: [{ id: 'mnist', name: 'MNIST 10k', dir: 'data/mnist/' }],
  defaultId: 'mnist',
};

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * データセットの場所を正規化する。先頭の `./` と `/` を外し、末尾を `/` にそろえる。
 * 別のオリジン（`https://…`・`//…`）や、`..` で `public/` の外へ出るパスは受け付けない（null）。
 */
export function normalizeDir(dir: string): string | null {
  let d = dir.trim();
  if (d === '' || /^[a-z][a-z0-9+.-]*:/i.test(d) || d.startsWith('//') || d.includes('\\')) return null;
  while (d.startsWith('./')) d = d.slice(2);
  d = d.replace(/^\/+/, '');
  if (d === '' || d.split('/').some((seg) => seg === '..')) return null;
  return d.endsWith('/') ? d : `${d}/`;
}

/** `datasets.json` の中身を検査する。不正なら Error を投げる。 */
export function parseCatalog(json: unknown): DatasetCatalog {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) throw new Error('datasets.json: 最上位がオブジェクトではありません');
  const o = json as Record<string, unknown>;
  if (!Array.isArray(o.datasets) || o.datasets.length === 0) throw new Error('datasets.json: "datasets" が空でない配列ではありません');
  const datasets: DatasetEntry[] = o.datasets.map((raw, i) => {
    const e = raw as Record<string, unknown> | null;
    const id = e?.id, name = e?.name, dir = e?.dir;
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new Error(`datasets.json: datasets[${i}].id が不正です`);
    if (typeof name !== 'string' || name === '') throw new Error(`datasets.json: datasets[${i}].name が空でない文字列ではありません`);
    const nd = typeof dir === 'string' ? normalizeDir(dir) : null;
    if (!nd) throw new Error(`datasets.json: datasets[${i}].dir が不正です`);
    return { id, name, dir: nd };
  });
  const ids = new Set<string>();
  for (const d of datasets) {
    if (ids.has(d.id)) throw new Error(`datasets.json: id "${d.id}" が重複しています`);
    ids.add(d.id);
  }
  const defaultId = o.default === undefined ? datasets[0]!.id : o.default;
  if (typeof defaultId !== 'string' || !ids.has(defaultId)) throw new Error('datasets.json: "default" が一覧の id ではありません');
  return { datasets, defaultId };
}

/** 開くデータセット。一覧にあれば `entry` を持つ。 */
export interface DatasetTarget {
  /** 読み込む場所（`public/` からの相対パス。末尾は `/`） */
  dir: string;
  /** 一覧の項目（一覧にないパスで指定したときは null） */
  entry: DatasetEntry | null;
}

/**
 * `?data=` の値を解釈する。値がなければ既定のデータセット。一覧の id と一致すればその項目、
 * そうでなければパスとして扱い、一覧の `dir` と一致すればその項目、一致しなければ一覧にないデータセット。
 * パスとしても不正（別のオリジンなど）なら Error を投げる。
 */
export function resolveDatasetParam(param: string | null, catalog: DatasetCatalog): DatasetTarget {
  if (param === null || param.trim() === '') {
    const entry = catalog.datasets.find((d) => d.id === catalog.defaultId) ?? catalog.datasets[0]!;
    return { dir: entry.dir, entry };
  }
  const value = param.trim();
  const byId = catalog.datasets.find((d) => d.id === value);
  if (byId) return { dir: byId.dir, entry: byId };
  if (!value.includes('/')) {
    const ids = catalog.datasets.map((d) => d.id).join('、');
    throw new Error(`データセット "${value}" は一覧にありません（一覧: ${ids}）`);
  }
  const dir = normalizeDir(value);
  if (!dir) throw new Error(`データセットの指定 "${value}" は使えません（一覧の id か、public/ からの相対パスで指定します）`);
  const byDir = catalog.datasets.find((d) => d.dir === dir);
  return { dir, entry: byDir ?? null };
}

/** URL の `?data=` に書く値。一覧にあれば id、なければパス。 */
export function datasetParamValue(target: DatasetTarget): string {
  return target.entry ? target.entry.id : target.dir;
}

/**
 * データセットを切り替えたあとの URL の検索部分。`data` を新しい値にし、前のデータセットの視点（`pos`・`look`）は外す。
 * 点の大きさ（`size`）もデータセットの点の間隔から決め直すので外す。ほかのパラメータは残す。
 */
export function searchForDataset(search: string, target: DatasetTarget): string {
  const q = new URLSearchParams(search);
  q.set('data', datasetParamValue(target));
  q.delete('pos');
  q.delete('look');
  q.delete('size');
  const s = q.toString().replace(/%2F/gi, '/');
  return `?${s}`;
}
