/**
 * テスト（Vitest、Node で動く）から `public/` の配信用データを読む補助。アプリのコードからは使わない。
 * tsconfig は Node の型を含めないので、`node:fs` は型なしの動的 import で読む。
 */
import { parseManifest, type DatasetManifest } from '../data/manifest';
import type { FetchLike } from '../data/loader';

const FS_MODULE = 'node:fs/promises';

/** `public/` からの相対パスのファイルを読む。 */
export async function readPublicFile(rel: string): Promise<ArrayBuffer> {
  const { readFile } = await import(/* @vite-ignore */ FS_MODULE);
  const buf = (await readFile(new URL(`../../public/${rel}`, import.meta.url))) as Uint8Array;
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/** `public/` のファイルを返す fetch（`loadDatasetArrays` などに渡す）。 */
export const publicFetch: FetchLike = async (url: string) => {
  try {
    const body = await readPublicFile(url);
    return {
      ok: true, status: 200,
      json: async () => JSON.parse(new TextDecoder().decode(body)) as unknown,
      arrayBuffer: async () => body,
    };
  } catch {
    return { ok: false, status: 404, json: async () => null, arrayBuffer: async () => new ArrayBuffer(0) };
  }
};

export async function readManifest(dir: string): Promise<DatasetManifest> {
  return parseManifest(JSON.parse(new TextDecoder().decode(await readPublicFile(`${dir}/manifest.json`))));
}
