import { decodeFloat32LE, decodeUint8 } from './binary';
import { parseManifest, type DatasetManifest } from './manifest';

export interface DatasetArrays {
  manifest: DatasetManifest;
  /** 長さ 3 * count */
  positions: Float32Array;
  /** 長さ count、値は manifest.labels.names の添字 */
  labels: Uint8Array;
  /** 座標の境界（全点を含む軸平行の箱と、原点中心の外接球半径） */
  bounds: { min: [number, number, number]; max: [number, number, number]; radius: number };
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

export function computeBounds(positions: Float32Array): DatasetArrays['bounds'] {
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
  return { min, max, radius: Math.sqrt(r2) };
}

/** manifest と数値バイナリを読み込む（画像は含まない。DOM に依存しないのでテストできる）。 */
export async function loadDatasetArrays(baseUrl: string, fetchImpl: FetchLike = fetch): Promise<DatasetArrays> {
  const manifest = parseManifest(await (await fetchOk(fetchImpl, resolveDataUrl(baseUrl, 'manifest.json'))).json());
  const [posBuf, labBuf] = await Promise.all([
    fetchOk(fetchImpl, resolveDataUrl(baseUrl, manifest.positions.file)).then((r) => r.arrayBuffer()),
    fetchOk(fetchImpl, resolveDataUrl(baseUrl, manifest.labels.file)).then((r) => r.arrayBuffer()),
  ]);
  const positions = decodeFloat32LE(posBuf, manifest.count * 3, manifest.positions.file);
  const labels = decodeUint8(labBuf, manifest.count, manifest.labels.file);
  const nLabels = manifest.labels.names.length;
  for (let i = 0; i < labels.length; i++) {
    if ((labels[i] as number) >= nLabels) {
      throw new Error(`${manifest.labels.file}: 点 ${i} のラベル ${labels[i]} が labels.names の範囲外です`);
    }
  }
  for (let i = 0; i < positions.length; i++) {
    if (!Number.isFinite(positions[i])) throw new Error(`${manifest.positions.file}: 有限でない値があります（添字 ${i}）`);
  }
  return { manifest, positions, labels, bounds: computeBounds(positions) };
}

/** アトラス画像をブラウザで読み込む。 */
export async function loadAtlasImage(baseUrl: string, manifest: DatasetManifest): Promise<ImageBitmap> {
  const url = resolveDataUrl(baseUrl, manifest.sprite.file);
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
