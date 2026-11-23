/**
 * クリックとドラッグの判別、ダブルクリックの判定。DOM に依存しない（座標と時刻だけを受け取る）。
 *
 * - クリック: 左ボタンを押してから離すまで、押した位置からのずれが一度も `dragThresholdPx` を超えなかった操作。
 *   途中で閾値を超えたら、その押下はドラッグ（視点の回転）で、元の位置へ戻して離してもクリックにしない。
 * - ダブルクリック: クリックが `doubleClickMs` 以内・`doubleClickPx` 以内に続いたとき、2 回目のクリック。
 *   3 回目は新しい 1 回目として数える（三連打で 2 回飛ばない）。
 */

export interface GestureOptions {
  /** これを超えて動いたらドラッグ（CSS ピクセル）。既定 4 */
  dragThresholdPx?: number;
  /** ダブルクリックとみなす間隔（ミリ秒）。既定 400 */
  doubleClickMs?: number;
  /** ダブルクリックとみなす 2 回のクリックの位置のずれ（CSS ピクセル）。既定 6 */
  doubleClickPx?: number;
}

export type PointerRelease =
  | { kind: 'click'; x: number; y: number; double: boolean }
  | { kind: 'drag' }
  | null;

export class PointerGesture {
  private readonly dragThreshold: number;
  private readonly doubleMs: number;
  private readonly doublePx: number;
  private pointerId: number | null = null;
  private downX = 0;
  private downY = 0;
  private _dragging = false;
  private lastClick: { x: number; y: number; t: number } | null = null;

  constructor(options: GestureOptions = {}) {
    this.dragThreshold = options.dragThresholdPx ?? 4;
    this.doubleMs = options.doubleClickMs ?? 400;
    this.doublePx = options.doubleClickPx ?? 6;
  }

  /** ボタンを押している最中か。 */
  get pressed(): boolean {
    return this.pointerId !== null;
  }

  /** 押している最中に閾値を超えて動いたか（ドラッグ中）。 */
  get dragging(): boolean {
    return this._dragging;
  }

  /** 左ボタン（button 0）の押下だけを扱う。ほかのボタンや、すでに押している間の押下は無視する。 */
  down(pointerId: number, button: number, x: number, y: number): void {
    if (button !== 0 || this.pointerId !== null) return;
    this.pointerId = pointerId;
    this.downX = x;
    this.downY = y;
    this._dragging = false;
  }

  /** 押している最中の移動。ドラッグになったら true を返す（その移動で初めて閾値を超えたときだけ）。 */
  move(pointerId: number, x: number, y: number): boolean {
    if (pointerId !== this.pointerId || this._dragging) return false;
    if (Math.hypot(x - this.downX, y - this.downY) > this.dragThreshold) {
      this._dragging = true;
      return true;
    }
    return false;
  }

  /** 離した。クリックなら位置とダブルクリックかどうかを返す。 */
  up(pointerId: number, x: number, y: number, timeMs: number): PointerRelease {
    if (pointerId !== this.pointerId) return null;
    this.move(pointerId, x, y);
    const dragged = this._dragging;
    this.pointerId = null;
    this._dragging = false;
    if (dragged) {
      this.lastClick = null;
      return { kind: 'drag' };
    }
    const prev = this.lastClick;
    const double = prev !== null && timeMs - prev.t <= this.doubleMs && timeMs >= prev.t &&
      Math.hypot(x - prev.x, y - prev.y) <= this.doublePx;
    this.lastClick = double ? null : { x, y, t: timeMs };
    return { kind: 'click', x, y, double };
  }

  /** 押下を取り消す（pointercancel やフォーカスを失ったとき）。 */
  cancel(): void {
    this.pointerId = null;
    this._dragging = false;
  }
}
