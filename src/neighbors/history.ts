/**
 * 選択の履歴（DOM に依存しない）。近傍をたどって選択を移したあと、1 つ前の選択へ戻るために使う。
 *
 * - 選択が、点 A から別の点 B へ移ると、A を履歴に積む（解除や、同じ点の選び直しでは積まない）。
 * - 戻る操作（`back`）は、履歴の最後の点を取り出して返す。戻った先の選択は、履歴に積まない（`record` に `back: true`）。
 * - 解除（null）は記録しない。解除のあとに別の点を選ぶと、解除の前に選んでいた点を積む。
 * - 長さは `limit` 個まで（古いものから捨てる）。データセットを切り替えたら `clear` で空にする。
 */
export const HISTORY_LIMIT = 100;

export class SelectionHistory {
  private readonly stack: number[] = [];
  private current: number | null = null;
  private readonly limit: number;

  constructor(limit = HISTORY_LIMIT) {
    this.limit = Math.max(1, Math.floor(limit));
  }

  /** 選択が `next` に変わったことを記録する。`back` は、戻る操作による変化か。 */
  record(next: number | null, options: { back?: boolean } = {}): void {
    const prev = this.current;
    if (next === null) return; // 解除の前の点は、次に別の点を選んだときに積む
    if (!options.back && prev !== null && prev !== next) {
      this.stack.push(prev);
      if (this.stack.length > this.limit) this.stack.splice(0, this.stack.length - this.limit);
    }
    this.current = next;
  }

  /** 戻れるか。 */
  get canGoBack(): boolean {
    return this.stack.length > 0;
  }

  /** 戻る先（取り出さない）。なければ null。 */
  peek(): number | null {
    return this.stack.length ? this.stack[this.stack.length - 1]! : null;
  }

  /** 戻る先を取り出す。なければ null。続けて `record(i, { back: true })` で、戻った先を記録する。 */
  back(): number | null {
    return this.stack.pop() ?? null;
  }

  get length(): number {
    return this.stack.length;
  }

  /** 履歴の中身（古い順。検証用） */
  entries(): number[] {
    return [...this.stack];
  }

  clear(): void {
    this.stack.length = 0;
    this.current = null;
  }
}
