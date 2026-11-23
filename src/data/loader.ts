import { decodeFloat32LE, decodeUint16LE, decodeUint8 } from './binary';
import { parseManifest, type DatasetManifest } from './manifest';

/**
 * 座標の境界。`min`/`max` は全点を含む軸平行の箱（常に座標から計算）。
 * `center` と `radius` は全点を含む球で、manifest に `bounds` があればその値、なければ原点中心・最大距離を使う。
 */
export interface DatasetBounds {
  min: [number, number, number];
  max: [number, number, number];
  center: [number, number, number];
  radius: number;
}

/** 点ごとのクラスタ id（manifest.clusters.levels[i] に対応）。 */
export interface ClusterAssignment {
  /** 階層の名前（`manifest.clusters.levels[i].name`） */
  level: string;
  /** 長さ count。値は階層内のクラスタ id（`manifest.clusters.noise` はクラスタなし） */
  ids: Uint16Array;
}

export interface DatasetArrays {
  manifest: DatasetManifest;
  /** 長さ 3 * count */
  positions: Float32Array;
  /** manifest.labels があるときのみ。長さ count、値は manifest.labels.names の添字 */
  labels?: Uint8Array;
  /** manifest.text があるときのみ。長さ count。点 i の表示用の文字列 */
  text?: string[];
  /** 座標の境界（全点を含む軸平行の箱と外接球） */
  bounds: DatasetBounds;
  /** manifest.clusters があるときのみ。`manifest.clusters.levels` と同じ順 */
  clusterAssignments?: ClusterAssignment[];
}

export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; arrayBuffer(): Promise<ArrayBuffer> }>;

/** baseUrl の末尾をスラッシュにそろえ、ファイル名を連結する。 */
export function resolveDataUrl(baseUrl: string, file: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return base + file;
}

async function fetchOk(fetchImpl: FetchLike, url: string) {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`${url} の取得に失敗しました（HTTP ${res.status}）`);
  return res;
}

/** JSON を取得する。JSON として読めなければ（存在しない場所で HTML が返る場合など）、ファイル名つきのエラーにする。 */
async function fetchJson(fetchImpl: FetchLike, url: string): Promise<unknown> {
  const res = await fetchOk(fetchImpl, url);
  try {
    return await res.json();
  } catch {
    throw new Error(`${url} を JSON として読めません（データセットの場所が正しいか確かめてください）`);
  }
}

/** 座標から境界を計算する。球は原点中心で、原点から最も遠い点までを半径とする。 */
export function computeBounds(positions: Float32Array): DatasetBounds {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let r2 = 0;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i] as number, y = positions[i + 1] as number, z = positions[i + 2] as number;
    if (x < min[0]) min[0] = x; if (x > max[0]) max[0] = x;
    if (y < min[1]) min[1] = y; if (y > max[1]) max[1] = y;
    if (z < min[2]) min[2] = z; if (z > max[2]) max[2] = z;
    const d = x * x + y * y + z * z;
    if (d > r2) r2 = d;
  }
  return { min, max, center: [0, 0, 0], radius: Math.sqrt(r2) };
}

/** text.json の中身（長さ count の文字列の配列）を検査する。 */
export function parseTextArray(json: unknown, count: number, file: string): string[] {
  if (!Array.isArray(json)) throw new Error(`${file}: 文字列の配列ではありません`);
  if (json.length !== count) throw new Error(`${file}: 長さ ${json.length} が点の数 ${count} と一致しません`);
  for (let i = 0; i < json.length; i++) {
    if (typeof json[i] !== 'string') throw new Error(`${file}: 点 ${i} の値が文字列ではありません`);
  }
  return json as string[];
}

/** manifest と数値バイナリを読み込む（画像は含まない。DOM に依存しないのでテストできる）。 */
export async function loadDatasetArrays(baseUrl: string, fetchImpl: FetchLike = fetch): Promise<DatasetArrays> {
  const manifest = parseManifest(await fetchJson(fetchImpl, resolveDataUrl(baseUrl, 'manifest.json')));
  const fetchBuffer = (file: string) => fetchOk(fetchImpl, resolveDataUrl(baseUrl, file)).then((r) => r.arrayBuffer());
  const levels = manifest.clusters?.levels ?? [];
  const labelsFile = manifest.labels?.file;
  const textFile = manifest.text?.file;
  const [posBuf, labBuf, textJson, ...clusterBufs] = await Promise.all([
    fetchBuffer(manifest.positions.file),
    labelsFile ? fetchBuffer(labelsFile) : Promise.resolve(null),
    textFile ? fetchJson(fetchImpl, resolveDataUrl(baseUrl, textFile)) : Promise.resolve(null),
    ...levels.map((level) => fetchBuffer(level.pointFile)),
  ]);
  const positions = decodeFloat32LE(posBuf as ArrayBuffer, manifest.count * 3, manifest.positions.file);
  let labels: Uint8Array | undefined;
  if (manifest.labels && labBuf) {
    labels = decodeUint8(labBuf as ArrayBuffer, manifest.count, manifest.labels.file);
    const nLabels = manifest.labels.names.length;
    for (let i = 0; i < labels.length; i++) {
      if ((labels[i] as number) >= nLabels) {
        throw new Error(`${manifest.labels.file}: 点 ${i} のラベル ${labels[i]} が labels.names の範囲外です`);
      }
    }
  }
  const text = textFile ? parseTextArray(textJson, manifest.count, textFile) : undefined;
  for (let i = 0; i < positions.length; i++) {
    if (!Number.isFinite(positions[i])) throw new Error(`${manifest.positions.file}: 有限でない値があります（添字 ${i}）`);
  }
  const computed = computeBounds(positions);
  const bounds: DatasetBounds = manifest.bounds
    ? { min: computed.min, max: computed.max, center: [...manifest.bounds.center], radius: manifest.bounds.radius }
    : computed;
  const result: DatasetArrays = { manifest, positions, bounds };
  if (labels) result.labels = labels;
  if (text) result.text = text;
  if (manifest.clusters) {
    const { noise } = manifest.clusters;
    result.clusterAssignments = levels.map((level, li) => {
      const ids = decodeUint16LE(clusterBufs[li] as ArrayBuffer, manifest.count, level.pointFile);
      const clusterCount = level.clusters.length;
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i] as number;
        if (id !== noise && id >= clusterCount) {
          throw new Error(
            `${level.pointFile}: 点 ${i} のクラスタ id ${id} が範囲外です（クラスタは ${clusterCount} 個、noise は ${noise}）`,
          );
        }
      }
      return { level: level.name, ids };
    });
  }
  return result;
}

/** アトラス画像をブラウザで読み込む。 */
export async function loadAtlasImage(baseUrl: string, sprite: NonNullable<DatasetManifest['sprite']>): Promise<ImageBitmap> {
  const url = resolveDataUrl(baseUrl, sprite.file);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} の取得に失敗しました（HTTP ${res.status}）`);
  // flipY なし・色空間変換なし（輝度をそのまま形として使う）
  return createImageBitmap(await res.blob(), { imageOrientation: 'none', colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
}

/** アトラス外周の平均輝度（0..1）を測る。インクの向きの判定に使う。 */
export function measureBorderLuma(image: ImageBitmap): number {
  const w = image.width, h = image.height;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return 1;
  ctx.drawImage(image, 0, 0);
  const strips = [ctx.getImageData(0, 0, w, 1), ctx.getImageData(0, h - 1, w, 1), ctx.getImageData(0, 0, 1, h), ctx.getImageData(w - 1, 0, 1, h)];
  let sum = 0, n = 0;
  for (const s of strips) {
    for (let i = 0; i < s.data.length; i += 4) {
      sum += ((s.data[i] as number) * 0.299 + (s.data[i + 1] as number) * 0.587 + (s.data[i + 2] as number) * 0.114) / 255;
      n++;
    }
  }
  return n ? sum / n : 1;
}
