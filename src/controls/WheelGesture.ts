/**
 * ホイール入力のうち、タッチパッドや慣性スクロールの「小さな移動量のイベント列」を
 * 「ひと払い（ジェスチャー）」の単位で束ね、1 回の払いで反映するノッチ数に上限を設ける。
 *
 * マウスホイールは 1 ノッチ（約 100 ピクセル、または 3 行、1 ページ）ずつ離散的にイベントが届く。
 * 一方、タッチパッドの 2 本指スクロールは、小さな移動量のイベントが慣性つきで数十回続き、
 * 合計が 1000〜3000 ピクセル（10〜30 ノッチ相当）に達する。イベントごとに速度を乗算すると
 * タッチパッドでは 1 回の払いで速度が数倍〜十数倍に跳ねるので、
 * 「連続したイベントの列」を 1 つの払いとみなし、その中で反映できる累積ノッチ数を
 * ±`limitNotches` に制限する。
 *
 * - マウスホイールの離散的なノッチ（`isDiscreteWheelDelta` が真のイベント）には、累積の上限を掛けない。
 *   1 ノッチをそのまま 1 ノッチとして反映する（連続して回せば 1.1^n 倍になる）。
 * - ただし、同じ払いの中に小さな移動量のイベントが 1 つでもあれば、その払いはタッチパッドとみなし、
 *   大きな移動量のイベント（タッチパッドの最速部分は 50 ピクセルを越えうる）にも上限を掛ける。
 *   小さなイベントが来る前に反映済みのノッチ扱いのイベントの分も、その払いの累積に数える。
 *   すでに上限を超えて反映した分は戻さず、同じ向きのそれ以降のイベントを反映しない。
 * - 払いの区切り: 直前のイベントから `gapMs` 以上あいたら新しい払いとして数え直す。
 *   移動量が 0 のイベント（横方向だけのスクロール）は、払いの継続として数えない。
 * - 累積は符号つきで、上限に張りついた状態から逆向きに回せばすぐ戻る（不感帯を作らない）。
 * - 上限までは入力に比例する。1 ノッチ（100 ピクセル）はそのまま 1 ノッチとして反映する。
 * - どちらの場合も、1 回のイベントで受け付けるのは `MAX_WHEEL_EVENT_NOTCHES` ノッチまで。
 *
 * DOM に依存しない。時刻は呼び出し側が渡す（`WheelEvent.timeStamp` を想定）。
 */

/** 1 回の払いで反映するノッチ数の上限。1.1^7 ≈ 1.95 倍。 */
export const DEFAULT_WHEEL_GESTURE_LIMIT_NOTCHES = 7;
/** 払いが途切れたとみなす、イベント間隔（ミリ秒）。 */
export const DEFAULT_WHEEL_GESTURE_GAP_MS = 150;
/** 1 回のイベントで受け付けるノッチ数の上限。 */
export const MAX_WHEEL_EVENT_NOTCHES = 3;

/** ピクセル単位のイベントを、マウスホイールの 1 ノッチと見なす `deltaY` の絶対値の下限。 */
export const DISCRETE_WHEEL_PIXEL_MIN = 50;

/**
 * このイベントが、マウスホイールの離散的なノッチと判断できる大きさかどうか。
 * 行単位・ページ単位のイベントか、ピクセル単位で `deltaY` の絶対値が `DISCRETE_WHEEL_PIXEL_MIN` 以上のもの。
 * `deltaMode`: 0 = ピクセル、1 = 行、2 = ページ。
 */
export function isDiscreteWheelDelta(deltaMode: number, deltaY: number): boolean {
  if (deltaMode === 1 || deltaMode === 2) return true;
  return Math.abs(deltaY) >= DISCRETE_WHEEL_PIXEL_MIN;
}

export interface WheelGestureOptions {
  limitNotches?: number;
  gapMs?: number;
}

export class WheelGestureLimiter {
  readonly limitNotches: number;
  readonly gapMs: number;

  /** 現在の払いで反映済みのノッチ数（符号つき）。ノッチ扱いのイベントを先に反映した分も含み、上限を超えうる。 */
  private accumulated = 0;
  /** 現在の払いに、小さな移動量のイベントが含まれているか。 */
  private hasSmallEvent = false;
  private lastTimeMs = Number.NEGATIVE_INFINITY;

  constructor(options: WheelGestureOptions = {}) {
    this.limitNotches = options.limitNotches ?? DEFAULT_WHEEL_GESTURE_LIMIT_NOTCHES;
    this.gapMs = options.gapMs ?? DEFAULT_WHEEL_GESTURE_GAP_MS;
  }

  /**
   * 時刻 `timeMs` に届いた `notches`（正で減速、負で加速）のうち、今回反映するノッチ数を返す。
   * `discrete` は、マウスホイールの離散的なノッチと判断できるイベントかどうか（`isDiscreteWheelDelta`）。
   * 有限でない入力は 0 を返し、状態も変えない。`notches` が 0 のイベントも状態を変えない。
   */
  consume(notches: number, timeMs: number, discrete = false): number {
    if (!Number.isFinite(notches) || !Number.isFinite(timeMs)) return 0;
    if (notches === 0) return 0;
    if (timeMs - this.lastTimeMs >= this.gapMs) {
      this.accumulated = 0;
      this.hasSmallEvent = false;
    }
    this.lastTimeMs = timeMs;

    const n = Math.min(MAX_WHEEL_EVENT_NOTCHES, Math.max(-MAX_WHEEL_EVENT_NOTCHES, notches));
    const before = this.accumulated;
    if (discrete && !this.hasSmallEvent) {
      // タッチパッドと判明する前の大きなイベントは、そのまま反映する。あとで払いがタッチパッドと
      // 分かったときに累積へ数えるため、反映した分を覚えておく。
      this.accumulated = before + n;
      return n;
    }
    this.hasSmallEvent = true;

    // 累積の許容範囲は ±limitNotches。すでに範囲の外へ反映してしまった分は戻さず、その位置までを許す。
    const lower = Math.min(-this.limitNotches, before);
    const upper = Math.max(this.limitNotches, before);
    const next = Math.min(upper, Math.max(lower, before + n));
    this.accumulated = next;
    return next - before;
  }

  /** 進行中の払いを捨てる。 */
  reset(): void {
    this.accumulated = 0;
    this.hasSmallEvent = false;
    this.lastTimeMs = Number.NEGATIVE_INFINITY;
  }
}
