/**
 * 検証用の故障の注入。検証スクリプト（scripts/verify/）が `window.__explorer.faults` から設定して、
 * 失敗したときの後始末と表示（表示の生成の失敗・単語の文字の生成の失敗・Worker の失敗）を確かめる。通常は何も起きない。
 * 値は、次に起こす失敗の回数（回数が尽きると以降は通常どおり）。
 */
export interface Faults {
  /** 次の `DatasetView` の生成を、最後（すべて作ったあと）で失敗させる回数 */
  view: number;
  /** 次の単語の文字の生成を失敗させる回数 */
  words: number;
  /** 次の UMAP の Worker を、読み込みに失敗する Worker にする回数 */
  worker: number;
}

export const faults: Faults = { view: 0, words: 0, worker: 0 };

/** `key` の回数が残っていれば 1 つ減らして true を返す（失敗を起こす）。 */
export function takeFault(key: keyof Faults): boolean {
  if (faults[key] <= 0) return false;
  faults[key]--;
  return true;
}
