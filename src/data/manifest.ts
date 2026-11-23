/** README の「データ形式」に対応する manifest.json の型と検証。 */

export type Vec3 = [number, number, number];

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

export interface DatasetManifest {
  name: string;
  count: number;
  positions: { file: string; dtype: 'float32'; components: 3 };
  labels: { file: string; dtype: 'uint8'; names: string[] };
  sprite: { file: string; cellSize: [number, number]; columns: number; rows: number };
  umap?: Record<string, unknown>;
  source?: Record<string, unknown>;
  /** 空間の構造（任意。ある場合は検証済み） */
  bounds?: ManifestBounds;
  density?: ManifestDensity;
  overview?: ManifestOverview;
  clusters?: ManifestClusters;
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

  return {
    id: index,
    name: requireString(o, 'name', `${path}.name`),
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

/** JSON をパースした値を検証し、型付きの manifest を返す。不正なら ManifestError を投げる。 */
export function parseManifest(json: unknown): DatasetManifest {
  if (!isRecord(json)) throw new ManifestError('最上位がオブジェクトではありません');

  const name = typeof json.name === 'string' ? json.name : 'dataset';
  const count = requirePositiveInt(json, 'count', 'count');

  const positions = requireRecord(json, 'positions');
  const posFile = requireString(positions, 'file', 'positions.file');
  if (positions.dtype !== 'float32') throw new ManifestError('"positions.dtype" は "float32" のみ対応しています');
  if (positions.components !== 3) throw new ManifestError('"positions.components" は 3 のみ対応しています');

  const labels = requireRecord(json, 'labels');
  const labFile = requireString(labels, 'file', 'labels.file');
  if (labels.dtype !== 'uint8') throw new ManifestError('"labels.dtype" は "uint8" のみ対応しています');
  const names = labels.names;
  if (!Array.isArray(names) || names.length === 0 || !names.every((n) => typeof n === 'string')) {
    throw new ManifestError('"labels.names" が文字列の配列ではありません');
  }
  if (names.length > 256) throw new ManifestError('"labels.names" は 256 個までです');

  const sprite = requireRecord(json, 'sprite');
  const spriteFile = requireString(sprite, 'file', 'sprite.file');
  const cell = sprite.cellSize;
  if (
    !Array.isArray(cell) || cell.length !== 2 ||
    !cell.every((c) => typeof c === 'number' && Number.isInteger(c) && c > 0)
  ) {
    throw new ManifestError('"sprite.cellSize" が正の整数2つの配列ではありません');
  }
  const columns = requirePositiveInt(sprite, 'columns', 'sprite.columns');
  const rows = requirePositiveInt(sprite, 'rows', 'sprite.rows');
  if (columns * rows < count) {
    throw new ManifestError(`アトラスのセル数 ${columns}x${rows} が点の数 ${count} より少なくなっています`);
  }

  const manifest: DatasetManifest = {
    name,
    count,
    positions: { file: posFile, dtype: 'float32', components: 3 },
    labels: { file: labFile, dtype: 'uint8', names: names as string[] },
    sprite: { file: spriteFile, cellSize: [cell[0] as number, cell[1] as number], columns, rows },
  };
  if (isRecord(json.umap)) manifest.umap = json.umap;
  if (isRecord(json.source)) manifest.source = json.source;
  if (json.bounds !== undefined) manifest.bounds = parseBounds(json.bounds);
  if (json.density !== undefined) manifest.density = parseDensity(json.density);
  if (json.overview !== undefined) manifest.overview = parseOverview(json.overview);
  if (json.clusters !== undefined) manifest.clusters = parseClusters(json.clusters, count, names.length);
  return manifest;
}
