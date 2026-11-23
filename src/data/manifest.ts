/** README の「データ形式」に対応する manifest.json の型と検証。 */

export interface DatasetManifest {
  name: string;
  count: number;
  positions: { file: string; dtype: 'float32'; components: 3 };
  labels: { file: string; dtype: 'uint8'; names: string[] };
  sprite: { file: string; cellSize: [number, number]; columns: number; rows: number };
  umap?: Record<string, unknown>;
  source?: Record<string, unknown>;
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
  return manifest;
}
