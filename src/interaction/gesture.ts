/**
 * クリックとドラッグの判別、ダブルクリックの判定。DOM に依存しない（座標と時刻だけを受け取る）。
 *
 * - クリック: 左ボタンだけを押してから離すまで、押した位置からのずれが一度も `dragThresholdPx` を超えなかった操作。
 *   途中で閾値を超えたら、その押下はドラッグ（視点の回転）で、元の位置へ戻して離してもクリックにしない。
 *   押している間にほかのボタン（右・中）が重なった押下は、クリックにしない（左を先に離しても、
 *   ブラウザは最後のボタンを離したときにだけ pointerup を出し、その button はほかのボタンになる）。
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
  /** 押している間に、左以外のボタンが重なったか */
  private chorded = false;
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

  /**
   * 左ボタン（button 0）の押下で始める。押している間の別のポインタの押下は無視する。
   * 押している最中の同じポインタの別のボタンの押下は、そのボタンが重なったことを覚える。
   * `buttons` は押しているボタンの集合（PointerEvent.buttons。左は 1）。左以外が含まれていれば重なりとみなす。
   */
  down(pointerId: number, button: number, x: number, y: number, buttons = 1): void {
    if (this.pointerId !== null) {
      if (pointerId === this.pointerId) this.chorded = true;
      return;
    }
    if (button !== 0) return;
    this.pointerId = pointerId;
    this.downX = x;
    this.downY = y;
    this._dragging = false;
    this.chorded = (buttons & ~1) !== 0;
  }

  /**
   * 押している最中の移動。ドラッグになったら true を返す（その移動で初めて閾値を超えたときだけ）。
   * `buttons`（PointerEvent.buttons）に左以外のボタンが含まれていれば、ボタンが重なったことを覚える。
   * ブラウザは 2 つ目のボタンの押下を、pointerdown ではなく pointermove で知らせる。
   * 左ボタンを押していない状態の移動（`buttons` に左が含まれない）が届いたときは、離した pointerup を取りこぼした
   * （capture が外れて要素の外で離した）ので、押下を破棄する。lostpointercapture は、capture の取得と解放の間に
   * ポインタイベントがないと出ないため、その取りこぼしをここで拾う。
   */
  move(pointerId: number, x: number, y: number, buttons?: number): boolean {
    if (pointerId !== this.pointerId) return false;
    if (buttons !== undefined && (buttons & 1) === 0) {
      this.cancel();
      return false;
    }
    if (buttons !== undefined && (buttons & ~1) !== 0) this.chorded = true;
    if (this._dragging) return false;
    if (Math.hypot(x - this.downX, y - this.downY) > this.dragThreshold) {
      this._dragging = true;
      return true;
    }
    return false;
  }

  /**
   * 離した。クリックなら位置とダブルクリックかどうかを返す。
   * `button` は離したボタン（PointerEvent.button）。左以外のとき、またはボタンが重なっていたときは、
   * クリックではなく、押下の取り消しとして null を返す（ダブルクリックの 1 回目も忘れる）。
   */
  up(pointerId: number, x: number, y: number, timeMs: number, button = 0): PointerRelease {
    if (pointerId !== this.pointerId) return null;
    this.move(pointerId, x, y);
    const dragged = this._dragging;
    const chorded = this.chorded || button !== 0;
    this.cancel();
    if (chorded) {
      this.lastClick = null;
      return null;
    }
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

  /**
   * 押下を取り消す（pointercancel・lostpointercapture・フォーカスを失ったとき）。
   * `pointerId` を渡すと、押しているポインタがそれと同じときだけ取り消す。省略するとどのポインタでも取り消す。
   */
  cancel(pointerId?: number): void {
    if (pointerId !== undefined && pointerId !== this.pointerId) return;
    this.pointerId = null;
    this._dragging = false;
    this.chorded = false;
  }
}
