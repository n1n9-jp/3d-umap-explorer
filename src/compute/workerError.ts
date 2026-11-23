/**
 * UMAP の Worker の失敗を、パネルに出す文にする。メインスレッドからも読むので、計算本体（Wasm）には依存しない。
 *
 * UMAP の本体は WebAssembly（SIMD 命令を使う）なので、SIMD に対応していないブラウザでは、Worker の読み込みか、
 * 計算の始めの Wasm の読み込みで失敗する。原因が分かるよう、その旨を添える。
 */

/** SIMD に対応していないブラウザで失敗することの説明（失敗の原因が Wasm らしいときに添える） */
export const WASM_SIMD_HINT = 'WebAssembly の SIMD に対応していないブラウザでは、UMAP の再計算を使えません';

/** 失敗の文が Wasm の読み込み・実行の失敗らしいか。 */
export function looksLikeWasmFailure(message: string): boolean {
  return /webassembly|wasm|simd|v128|compileerror|linkerror/i.test(message);
}

/**
 * Worker 自体のエラー（`onerror`。スクリプトの読み込みの失敗や、捕まえていない例外）の文。`detail` は、ブラウザが渡す文（空のことがある）。
 * 読み込みの失敗は文が空になりやすく、Wasm の SIMD に対応していないブラウザでも起きるので、常にその旨を添える。
 */
export function describeWorkerError(detail: string | null | undefined): string {
  const d = (detail ?? '').trim();
  return `UMAP を計算する Worker を読み込めないか、途中で止まりました${d ? `（${d}）` : ''}。${WASM_SIMD_HINT}`;
}

/** Worker が捕まえて返したエラーの文。Wasm の失敗らしいときだけ、SIMD の説明を添える。 */
export function describeComputeError(message: string): string {
  return looksLikeWasmFailure(message) ? `${message}。${WASM_SIMD_HINT}` : message;
}
