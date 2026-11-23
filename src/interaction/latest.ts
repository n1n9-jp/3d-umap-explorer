/**
 * 非同期の要求のうち、最新のものの結果だけを使うための道具。DOM に依存しない。
 */

/** 発行した順に番号を振り、最後に発行した要求（かつ無効化されていないもの）の結果だけを渡す。 */
export class LatestOnly {
  private seq = 0;

  /** `promise` の結果を、これより後に別の要求が発行されず、無効化もされていなければ `apply` へ渡す。 */
  issue<T>(promise: Promise<T>, apply: (value: T) => void, onError?: (err: unknown) => void): void {
    const s = ++this.seq;
    promise.then(
      (v) => { if (s === this.seq) apply(v); },
      (e: unknown) => { if (s === this.seq) onError?.(e); },
    );
  }

  /** 発行済みの要求の結果をすべて捨てる。 */
  invalidate(): void {
    this.seq++;
  }
}

export type PickFn = (x: number, y: number) => Promise<number | null>;

/**
 * ホバー中の点を追う。カーソルの移動は記録だけして、`frame()` ごとに最大 1 回だけ特定の要求を出す。
 * 古い要求の結果は使わない。`suspend()` の間（ドラッグ中・カメラの移動中）は要求を出さず、ホバーを外す。
 * `resume()` で、最後のカーソル位置に対してもう一度特定する（視点が変わって下の点が変わっているため）。
 */
export class HoverTracker {
  private readonly pick: PickFn;
  private readonly onChange: (index: number | null) => void;
  private readonly latest = new LatestOnly();
  private cursor: { x: number; y: number } | null = null;
  private dirty = false;
  private _suspended = false;
  private _hovered: number | null = null;

  constructor(pick: PickFn, onChange: (index: number | null) => void) {
    this.pick = pick;
    this.onChange = onChange;
  }

  get hovered(): number | null {
    return this._hovered;
  }

  get suspended(): boolean {
    return this._suspended;
  }

  /** 最後に知らされたカーソル位置（画面外へ出たら null）。 */
  get position(): { x: number; y: number } | null {
    return this.cursor;
  }

  move(x: number, y: number): void {
    this.cursor = { x, y };
    this.dirty = true;
  }

  /** カーソルが画面から出た。 */
  leave(): void {
    this.cursor = null;
    this.dirty = false;
    this.latest.invalidate();
    this.set(null);
  }

  suspend(): void {
    if (this._suspended) return;
    this._suspended = true;
    this.latest.invalidate();
    this.set(null);
  }

  resume(): void {
    if (!this._suspended) return;
    this._suspended = false;
    if (this.cursor) this.dirty = true;
  }

  /** 1 フレームに 1 回呼ぶ。必要なら特定の要求を 1 つ出す。出したら true。 */
  frame(): boolean {
    if (this._suspended || !this.dirty || !this.cursor) return false;
    this.dirty = false;
    const { x, y } = this.cursor;
    this.latest.issue(this.pick(x, y), (index) => {
      if (!this._suspended) this.set(index);
    }, () => this.set(null));
    return true;
  }

  private set(index: number | null): void {
    if (index === this._hovered) return;
    this._hovered = index;
    this.onChange(index);
  }
}
