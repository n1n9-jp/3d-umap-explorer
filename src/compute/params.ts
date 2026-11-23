/**
 * UMAP のパラメータの型・範囲・URL での表し方。メインスレッドからも読むので、計算本体（Wasm）には依存しない。
 */

/** 利用者が決める UMAP のパラメータ。 */
export interface UmapParams {
  /** 近傍数（umap-learn の n_neighbors と同じく自分自身を数える） */
  nNeighbors: number;
  /** 小数第 2 位まで */
  minDist: number;
  seed: number;
}

/** パラメータの範囲（パネルと URL の検証に使う）。 */
export const UMAP_LIMITS = {
  nNeighbors: { min: 5, max: 50 },
  minDist: { min: 0, max: 0.99, step: 0.01 },
  seed: { min: 0, max: 2147483647 },
} as const;

/** エポック数。1 万点では 200 で質が変わらない（spike の計測。atlas の既定 500 より 6 割短い） */
export const UMAP_EPOCHS = 200;
/** 1 チャンクのエポック数。中断が効くまでの最大の遅れと、途中の座標を読める間隔になる */
export const UMAP_CHUNK_EPOCHS = 5;

/** URL のパラメータ名（近傍数・min_dist・乱数の種） */
export const URL_KEYS = { nNeighbors: 'nn', minDist: 'md', seed: 'seed' } as const;

/** 結果を保持するときの鍵。 */
export function paramsKey(p: UmapParams): string {
  return `nn=${p.nNeighbors}&md=${p.minDist.toFixed(2)}&seed=${p.seed}`;
}

/** パラメータが範囲内か（min_dist は小数第 2 位に丸めた値で返す）。範囲外なら null。 */
export function validParams(nNeighbors: number, minDist: number, seed: number, maxNeighbors: number = UMAP_LIMITS.nNeighbors.max): UmapParams | null {
  const nMax = Math.min(UMAP_LIMITS.nNeighbors.max, maxNeighbors);
  if (!Number.isInteger(nNeighbors) || nNeighbors < UMAP_LIMITS.nNeighbors.min || nNeighbors > nMax) return null;
  if (!Number.isFinite(minDist) || minDist < UMAP_LIMITS.minDist.min || minDist > UMAP_LIMITS.minDist.max) return null;
  if (!Number.isInteger(seed) || seed < UMAP_LIMITS.seed.min || seed > UMAP_LIMITS.seed.max) return null;
  return { nNeighbors, minDist: Math.round(minDist * 100) / 100, seed };
}

/**
 * URL の検索文字列から nn・md・seed を読む。3 つのどれもなければ null。どれかがあって不正なら `{ error }`。
 * seed を省くと 42 ではなく不正とする（URL だけで結果が決まるように、3 つそろえて書く）。
 */
export function parseUrlParams(search: string): UmapParams | { error: string } | null {
  const q = new URLSearchParams(search);
  const raw = [q.get(URL_KEYS.nNeighbors), q.get(URL_KEYS.minDist), q.get(URL_KEYS.seed)];
  if (raw.every((v) => v === null)) return null;
  if (raw.some((v) => v === null || v.trim() === '')) return { error: 'nn・md・seed の 3 つを指定してください' };
  const p = validParams(Number(raw[0]), Number(raw[1]), Number(raw[2]));
  if (!p) return { error: `nn は ${UMAP_LIMITS.nNeighbors.min}〜${UMAP_LIMITS.nNeighbors.max} の整数、md は 0〜0.99、seed は 0 以上の整数です` };
  return p;
}

/** URL の検索文字列へ nn・md・seed を書く（null なら外す）。ほかのパラメータは保つ。 */
export function searchWithParams(search: string, p: UmapParams | null): string {
  const q = new URLSearchParams(search);
  if (p) {
    q.set(URL_KEYS.nNeighbors, String(p.nNeighbors));
    q.set(URL_KEYS.minDist, String(p.minDist));
    q.set(URL_KEYS.seed, String(p.seed));
  } else {
    q.delete(URL_KEYS.nNeighbors);
    q.delete(URL_KEYS.minDist);
    q.delete(URL_KEYS.seed);
  }
  const s = q.toString().replace(/%2F/gi, '/').replace(/%2C/gi, ',');
  return s ? `?${s}` : '';
}

/** パラメータの表示（パネル・選択欄の横・保持している結果の一覧で共通）。 */
export function formatUmapParams(p: UmapParams): string {
  return `近傍数 ${p.nNeighbors}・min_dist ${p.minDist.toFixed(2)}・種 ${p.seed}`;
}

/** 事前計算の埋め込みの説明（manifest の `umap`）。例: `事前計算（umap-learn 0.6.0・近傍数 15・min_dist 0.10・種 42）` */
export function describePrecomputed(umap: Record<string, unknown> | undefined, withLibrary = true): string {
  const u = umap ?? {};
  const parts: string[] = [];
  if (withLibrary && typeof u.library === 'string') parts.push(u.library);
  if (typeof u.nNeighbors === 'number') parts.push(`近傍数 ${u.nNeighbors}`);
  if (typeof u.minDist === 'number') parts.push(`min_dist ${u.minDist.toFixed(2)}`);
  if (typeof u.randomState === 'number') parts.push(`種 ${u.randomState}`);
  return parts.length ? `事前計算（${parts.join('・')}）` : '事前計算';
}

/** ブラウザで計算した埋め込みの説明（`short` ではエポック数を省く）。 */
export function describeComputed(p: UmapParams, short = false): string {
  return short ? `ブラウザで計算（${formatUmapParams(p)}）` : `ブラウザで計算（${formatUmapParams(p)}・${UMAP_EPOCHS} エポック）`;
}

/** 常に見える表示（データセットの選択欄の横）の文面。 */
export function embeddingStatusText(current: { kind: 'precomputed'; umap?: Record<string, unknown> } | { kind: 'computed'; params: UmapParams }): string {
  return `埋め込み: ${current.kind === 'computed' ? describeComputed(current.params, true) : describePrecomputed(current.umap, false)}`;
}
