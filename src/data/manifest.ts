/** README の「データ形式」に対応する manifest.json の型と検証。 */

export type Vec3 = [number, number, number];

/**
 * ラベル名の数の上限。ラベルは uint8 で持つので 0..255 の 256 個。
 * 描画（src/render/）はラベル色を 10 色の繰り返しで割り当て、この範囲のどのラベルも同じ式で色を引く。
 */
export const MAX_LABELS = 256;

/** 全点を含む球（`center` はバウンディングボックスの中心）。 */
export interface ManifestBounds {
  center: Vec3;
  radius: number;
}

/** 各点の k 近傍までの平均距離の、全点でのパーセンタイル。周囲の疎密の目安。 */
export interface ManifestDensity {
  k: number;
  knnDistP05: number;
  knnDistP50: number;
  knnDistP95: number;
}

/** 座標の主成分分析の第 1〜第 3 軸（単位ベクトル）。 */
export interface ManifestOverview {
  axes: [Vec3, Vec3, Vec3];
}

/**
 * 元の高次元空間での k 近傍グラフ（README の「近傍グラフ（`knn`）と埋め込みの質（`quality`）」）。
 * ブラウザでの UMAP の再計算（src/compute/）が、この機能を開いたときにだけ取得する。
 */
export interface ManifestKnn {
  k: number;
  metric: 'euclidean' | 'cosine';
  /** 自分自身を含むか（常に false） */
  includesSelf: false;
  exact: boolean;
  indices: { file: string; dtype: 'uint16' | 'uint32' };
  distances: { file: string; dtype: 'float32' };
}

export interface ClusterParams {
  minClusterSize: number;
  minSamples: number;
  /** null は上限なし */
  maxClusterSize: number | null;
  selectionMethod: string;
}

export interface ClusterInfo {
  /** 階層内で 0 から連番（`clusters` 配列の添字と一致し、pointFile の値と対応する） */
  id: number;
  name: string;
  /** 代表の単語（`manifest.text` があって `manifest.labels` がないデータセットだけ）。最大 3 語 */
  terms?: string[];
  size: number;
  /** 代表点の番号 */
  medoid: number;
  center: Vec3;
  radius: number;
  /** [最小x,y,z] と [最大x,y,z] */
  bbox: [Vec3, Vec3];
  /** ラベルのないデータセットでは null（`purity` も null） */
  majorityLabel: number | null;
  purity: number | null;
  /** 一つ粗い階層のクラスタ id。最も粗い階層では null */
  parent: number | null;
}

export interface ClusterLevel {
  name: string;
  params: ClusterParams;
  /** 点ごとのクラスタ id（Uint16、長さ count）のファイル名 */
  pointFile: string;
  clusters: ClusterInfo[];
}

export interface ManifestClusters {
  method: string;
  /** どのクラスタにも属さない点の値 */
  noise: number;
  /** 粗い階層から細かい階層の順 */
  levels: ClusterLevel[];
}

/** 点が何を表すか。`image`: 各点が画像（`sprite` を持つ）、`text`: 各点が単語などの文字列（`text` を持つ）。 */
export type DatasetKind = 'image' | 'text';

export interface DatasetManifest {
  name: string;
  /** manifest の `kind`。書かれていなければ、`sprite` があれば image、`text` があれば text とみなす（どちらもなければ text） */
  kind: DatasetKind;
  count: number;
  positions: { file: string; dtype: 'float32'; components: 3 };
  /** 任意。ないデータセットでは、点はクラスタで色分けする */
  labels?: { file: string; dtype: 'uint8'; names: string[] };
  /** 任意。画像アトラス */
  sprite?: { file: string; cellSize: [number, number]; columns: number; rows: number };
  /** 任意。点ごとの表示用の文字列（JSON の文字列の配列） */
  text?: { file: string };
  umap?: Record<string, unknown>;
  source?: Record<string, unknown>;
  /** 空間の構造（任意。ある場合は検証済み） */
  bounds?: ManifestBounds;
  density?: ManifestDensity;
  overview?: ManifestOverview;
  clusters?: ManifestClusters;
  /** 任意。元の高次元空間での k 近傍グラフ（ファイルは、使うときに `src/data/knn.ts` で読む） */
  knn?: ManifestKnn;
}

export class ManifestError extends Error {
  constructor(message: string) {
    super(`manifest.json: ${message}`);
    this.name = 'ManifestError';
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function requireRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = parent[key];
  if (!isRecord(v)) throw new ManifestError(`"${key}" がオブジェクトではありません`);
  return v;
}

function requireString(parent: Record<string, unknown>, key: string, path: string): string {
  const v = parent[key];
  if (typeof v !== 'string' || v.length === 0) throw new ManifestError(`"${path}" が空でない文字列ではありません`);
  return v;
}

function requirePositiveInt(parent: Record<string, unknown>, key: string, path: string): number {
  const v = parent[key];
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
    throw new ManifestError(`"${path}" が正の整数ではありません`);
  }
  return v;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function parseVec3(v: unknown, path: string): Vec3 {
  if (!Array.isArray(v) || v.length !== 3 || !v.every(isFiniteNumber)) {
    throw new ManifestError(`"${path}" が有限な数3つの配列ではありません`);
  }
  return [v[0] as number, v[1] as number, v[2] as number];
}

function requireNonNegative(v: unknown, path: string): number {
  if (!isFiniteNumber(v) || v < 0) throw new ManifestError(`"${path}" が 0 以上の有限な数ではありません`);
  return v;
}

function requireIntInRange(v: unknown, path: string, minInclusive: number, maxExclusive: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < minInclusive || v >= maxExclusive) {
    throw new ManifestError(`"${path}" が ${minInclusive} 以上 ${maxExclusive} 未満の整数ではありません`);
  }
  return v;
}

function recordAt(v: unknown, path: string): Record<string, unknown> {
  if (!isRecord(v)) throw new ManifestError(`"${path}" がオブジェクトではありません`);
  return v;
}

function arrayAt(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) throw new ManifestError(`"${path}" が配列ではありません`);
  return v;
}

function parseBounds(v: unknown): ManifestBounds {
  const o = recordAt(v, 'bounds');
  return { center: parseVec3(o.center, 'bounds.center'), radius: requireNonNegative(o.radius, 'bounds.radius') };
}

function parseDensity(v: unknown): ManifestDensity {
  const o = recordAt(v, 'density');
  const k = requirePositiveInt(o, 'k', 'density.k');
  const knnDistP05 = requireNonNegative(o.knnDistP05, 'density.knnDistP05');
  const knnDistP50 = requireNonNegative(o.knnDistP50, 'density.knnDistP50');
  const knnDistP95 = requireNonNegative(o.knnDistP95, 'density.knnDistP95');
  if (!(knnDistP05 <= knnDistP50 && knnDistP50 <= knnDistP95)) {
    throw new ManifestError('"density" の knnDistP05 <= knnDistP50 <= knnDistP95 が成り立っていません');
  }
  return { k, knnDistP05, knnDistP50, knnDistP95 };
}

function parseOverview(v: unknown): ManifestOverview {
  const o = recordAt(v, 'overview');
  const axes = arrayAt(o.axes, 'overview.axes');
  if (axes.length !== 3) throw new ManifestError('"overview.axes" が3本の軸ではありません');
  const parsed = axes.map((a, i) => {
    const vec = parseVec3(a, `overview.axes[${i}]`);
    if (Math.abs(Math.hypot(vec[0], vec[1], vec[2]) - 1) > 1e-3) {
      throw new ManifestError(`"overview.axes[${i}]" が単位ベクトルではありません`);
    }
    return vec;
  });
  return { axes: [parsed[0] as Vec3, parsed[1] as Vec3, parsed[2] as Vec3] };
}

function parseClusterParams(v: unknown, path: string): ClusterParams {
  const o = recordAt(v, path);
  const maxClusterSize = o.maxClusterSize === null ? null : requirePositiveInt(o, 'maxClusterSize', `${path}.maxClusterSize`);
  return {
    minClusterSize: requirePositiveInt(o, 'minClusterSize', `${path}.minClusterSize`),
    minSamples: requirePositiveInt(o, 'minSamples', `${path}.minSamples`),
    maxClusterSize,
    selectionMethod: requireString(o, 'selectionMethod', `${path}.selectionMethod`),
  };
}

function parseCluster(
  v: unknown, path: string, index: number, count: number, labelCount: number, parentCount: number | null,
): ClusterInfo {
  const o = recordAt(v, path);
  if (o.id !== index) throw new ManifestError(`"${path}.id" が配列の添字 ${index} と一致しません`);
  const size = requireIntInRange(o.size, `${path}.size`, 1, count + 1);
  const medoid = requireIntInRange(o.medoid, `${path}.medoid`, 0, count);

  const rawBbox = arrayAt(o.bbox, `${path}.bbox`);
  if (rawBbox.length !== 2) throw new ManifestError(`"${path}.bbox" が [最小, 最大] の2要素ではありません`);
  const bboxMin = parseVec3(rawBbox[0], `${path}.bbox[0]`);
  const bboxMax = parseVec3(rawBbox[1], `${path}.bbox[1]`);
  if (bboxMin.some((m, a) => m > (bboxMax[a] as number))) {
    throw new ManifestError(`"${path}.bbox" の最小が最大を上回っています`);
  }

  let majorityLabel: number | null = null;
  let purity: number | null = null;
  if (o.majorityLabel !== null || o.purity !== null) {
    majorityLabel = requireIntInRange(o.majorityLabel, `${path}.majorityLabel`, 0, labelCount);
    if (!isFiniteNumber(o.purity) || o.purity < 0 || o.purity > 1) {
      throw new ManifestError(`"${path}.purity" が 0 以上 1 以下の数ではありません`);
    }
    purity = o.purity;
  }

  let parent: number | null = null;
  if (parentCount === null) {
    if (o.parent !== null) throw new ManifestError(`"${path}.parent" は最も粗い階層では null です`);
  } else {
    parent = requireIntInRange(o.parent, `${path}.parent`, 0, parentCount);
  }

  let terms: string[] | undefined;
  if (o.terms !== undefined) {
    const raw = arrayAt(o.terms, `${path}.terms`);
    if (!raw.every((t) => typeof t === 'string')) throw new ManifestError(`"${path}.terms" が文字列の配列ではありません`);
    terms = raw as string[];
  }

  return {
    id: index,
    name: requireString(o, 'name', `${path}.name`),
    ...(terms ? { terms } : {}),
    size,
    medoid,
    center: parseVec3(o.center, `${path}.center`),
    radius: requireNonNegative(o.radius, `${path}.radius`),
    bbox: [bboxMin, bboxMax],
    majorityLabel,
    purity,
    parent,
  };
}

function parseClusters(v: unknown, count: number, labelCount: number): ManifestClusters {
  const o = recordAt(v, 'clusters');
  const method = requireString(o, 'method', 'clusters.method');
  const noise = requireIntInRange(o.noise, 'clusters.noise', 0, 65536);
  const rawLevels = arrayAt(o.levels, 'clusters.levels');
  if (rawLevels.length === 0) throw new ManifestError('"clusters.levels" が空です');

  const levels: ClusterLevel[] = [];
  rawLevels.forEach((rawLevel, li) => {
    const path = `clusters.levels[${li}]`;
    const lo = recordAt(rawLevel, path);
    const name = requireString(lo, 'name', `${path}.name`);
    if (levels.some((l) => l.name === name)) throw new ManifestError(`"${path}.name" "${name}" が重複しています`);
    const params = parseClusterParams(lo.params, `${path}.params`);
    const pointFile = requireString(lo, 'pointFile', `${path}.pointFile`);
    const rawClusters = arrayAt(lo.clusters, `${path}.clusters`);
    // id は点ごとのファイルの値で、noise の値と衝突できない
    if (rawClusters.length > noise) {
      throw new ManifestError(`"${path}.clusters" の数 ${rawClusters.length} が clusters.noise ${noise} 以上です`);
    }
    const parentCount = li === 0 ? null : (levels[li - 1] as ClusterLevel).clusters.length;
    const clusters = rawClusters.map((c, ci) =>
      parseCluster(c, `${path}.clusters[${ci}]`, ci, count, labelCount, parentCount));
    const total = clusters.reduce((sum, c) => sum + c.size, 0);
    if (total > count) throw new ManifestError(`"${path}.clusters" の size の合計 ${total} が点の数 ${count} を上回っています`);
    levels.push({ name, params, pointFile, clusters });
  });
  return { method, noise, levels };
}

function parseKnn(v: unknown, count: number): ManifestKnn {
  const o = recordAt(v, 'knn');
  const k = requirePositiveInt(o, 'k', 'knn.k');
  if (k >= count) throw new ManifestError(`"knn.k" ${k} が点の数 ${count} 以上です`);
  if (o.metric !== 'euclidean' && o.metric !== 'cosine') throw new ManifestError('"knn.metric" は "euclidean" か "cosine" です');
  if (o.includesSelf !== false) throw new ManifestError('"knn.includesSelf" は false のみ対応しています');
  if (typeof o.exact !== 'boolean') throw new ManifestError('"knn.exact" が真偽値ではありません');
  const indices = recordAt(o.indices, 'knn.indices');
  const distances = recordAt(o.distances, 'knn.distances');
  const indicesFile = requireString(indices, 'file', 'knn.indices.file');
  const distancesFile = requireString(distances, 'file', 'knn.distances.file');
  if (indices.dtype !== 'uint16' && indices.dtype !== 'uint32') throw new ManifestError('"knn.indices.dtype" は "uint16" か "uint32" です');
  if (indices.dtype === 'uint16' && count > 65536) throw new ManifestError('"knn.indices.dtype" が uint16 ですが、点の数が 65536 を超えています');
  if (distances.dtype !== 'float32') throw new ManifestError('"knn.distances.dtype" は "float32" のみ対応しています');
  return {
    k, metric: o.metric, includesSelf: false, exact: o.exact,
    indices: { file: indicesFile, dtype: indices.dtype }, distances: { file: distancesFile, dtype: 'float32' },
  };
}

/** JSON をパースした値を検証し、型付きの manifest を返す。不正なら ManifestError を投げる。 */
export function parseManifest(json: unknown): DatasetManifest {
  if (!isRecord(json)) throw new ManifestError('最上位がオブジェクトではありません');

  const name = typeof json.name === 'string' ? json.name : 'dataset';
  const count = requirePositiveInt(json, 'count', 'count');

  const positions = requireRecord(json, 'positions');
  const posFile = requireString(positions, 'file', 'positions.file');
  if (positions.dtype !== 'float32') throw new ManifestError('"positions.dtype" は "float32" のみ対応しています');
  if (positions.components !== 3) throw new ManifestError('"positions.components" は 3 のみ対応しています');

  let labels: DatasetManifest['labels'];
  if (json.labels !== undefined) {
    const lo = requireRecord(json, 'labels');
    const labFile = requireString(lo, 'file', 'labels.file');
    if (lo.dtype !== 'uint8') throw new ManifestError('"labels.dtype" は "uint8" のみ対応しています');
    const names = lo.names;
    if (!Array.isArray(names) || names.length === 0 || !names.every((n) => typeof n === 'string')) {
      throw new ManifestError('"labels.names" が文字列の配列ではありません');
    }
    if (names.length > MAX_LABELS) throw new ManifestError(`"labels.names" は ${MAX_LABELS} 個までです`);
    labels = { file: labFile, dtype: 'uint8', names: names as string[] };
  }

  let sprite: DatasetManifest['sprite'];
  if (json.sprite !== undefined) {
    const so = requireRecord(json, 'sprite');
    const spriteFile = requireString(so, 'file', 'sprite.file');
    const cell = so.cellSize;
    if (
      !Array.isArray(cell) || cell.length !== 2 ||
      !cell.every((c) => typeof c === 'number' && Number.isInteger(c) && c > 0)
    ) {
      throw new ManifestError('"sprite.cellSize" が正の整数2つの配列ではありません');
    }
    const columns = requirePositiveInt(so, 'columns', 'sprite.columns');
    const rows = requirePositiveInt(so, 'rows', 'sprite.rows');
    if (columns * rows < count) {
      throw new ManifestError(`アトラスのセル数 ${columns}x${rows} が点の数 ${count} より少なくなっています`);
    }
    sprite = { file: spriteFile, cellSize: [cell[0] as number, cell[1] as number], columns, rows };
  }

  let text: DatasetManifest['text'];
  if (json.text !== undefined) {
    const to = requireRecord(json, 'text');
    text = { file: requireString(to, 'file', 'text.file') };
  }

  let kind: DatasetKind;
  if (json.kind !== undefined) {
    if (json.kind !== 'image' && json.kind !== 'text') throw new ManifestError('"kind" は "image" か "text" です');
    kind = json.kind;
    if (kind === 'image' && !sprite) throw new ManifestError('"kind" が "image" なのに "sprite" がありません');
    if (kind === 'text' && !text) throw new ManifestError('"kind" が "text" なのに "text" がありません');
  } else {
    kind = sprite ? 'image' : 'text';
  }

  const manifest: DatasetManifest = {
    name,
    kind,
    count,
    positions: { file: posFile, dtype: 'float32', components: 3 },
    ...(labels ? { labels } : {}),
    ...(sprite ? { sprite } : {}),
    ...(text ? { text } : {}),
  };
  if (isRecord(json.umap)) manifest.umap = json.umap;
  if (isRecord(json.source)) manifest.source = json.source;
  if (json.bounds !== undefined) manifest.bounds = parseBounds(json.bounds);
  if (json.density !== undefined) manifest.density = parseDensity(json.density);
  if (json.overview !== undefined) manifest.overview = parseOverview(json.overview);
  if (json.clusters !== undefined) manifest.clusters = parseClusters(json.clusters, count, labels?.names.length ?? 0);
  if (json.knn !== undefined) manifest.knn = parseKnn(json.knn, count);
  return manifest;
}
