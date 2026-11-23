/**
 * ホイール入力を「ひと払い（ジェスチャー）」の単位で束ね、1 回の払いで反映するノッチ数に上限を設ける。
 *
 * マウスホイールは 1 ノッチ（約 100 ピクセル）ずつ離散的にイベントが届く。
 * タッチパッドの 2 本指スクロールは、小さな移動量のイベントが慣性つきで数十回続き、
 * 合計が 1000〜3000 ピクセル（10〜30 ノッチ相当）に達する。イベントごとに速度を乗算すると
 * タッチパッドでは 1 回の払いで速度が数倍〜十数倍に跳ねるので、
 * 「連続したイベントの列」を 1 つの払いとみなし、その中で反映できる累積ノッチ数を
 * ±`limitNotches` に制限する。
 *
 * - 払いの区切り: 直前のイベントから `gapMs` 以上あいたら新しい払いとして数え直す。
 * - 累積は符号つきで、上限に張りついた状態から逆向きに回せばすぐ戻る（不感帯を作らない）。
 * - 上限までは入力に比例する。1 ノッチ（100 ピクセル）はそのまま 1 ノッチとして反映する。
 *
 * DOM に依存しない。時刻は呼び出し側が渡す（`WheelEvent.timeStamp` を想定）。
 */

/** 1 回の払いで反映するノッチ数の上限。1.1^7 ≈ 1.95 倍。 */
export const DEFAULT_WHEEL_GESTURE_LIMIT_NOTCHES = 7;
/** 払いが途切れたとみなす、イベント間隔（ミリ秒）。 */
export const DEFAULT_WHEEL_GESTURE_GAP_MS = 150;
/** 1 回のイベントで受け付けるノッチ数の上限。 */
export const MAX_WHEEL_EVENT_NOTCHES = 3;

export interface WheelGestureOptions {
  limitNotches?: number;
  gapMs?: number;
}

export class WheelGestureLimiter {
  readonly limitNotches: number;
  readonly gapMs: number;

  private accumulated = 0;
  private lastTimeMs = Number.NEGATIVE_INFINITY;

  constructor(options: WheelGestureOptions = {}) {
    this.limitNotches = options.limitNotches ?? DEFAULT_WHEEL_GESTURE_LIMIT_NOTCHES;
    this.gapMs = options.gapMs ?? DEFAULT_WHEEL_GESTURE_GAP_MS;
  }

  /**
   * 時刻 `timeMs` に届いた `notches`（正で減速、負で加速）のうち、今回反映するノッチ数を返す。
   * 有限でない入力は 0 を返し、状態も変えない。
   */
  consume(notches: number, timeMs: number): number {
    if (!Number.isFinite(notches) || !Number.isFinite(timeMs)) return 0;
    if (timeMs - this.lastTimeMs >= this.gapMs) this.accumulated = 0;
    this.lastTimeMs = timeMs;

    const n = Math.min(MAX_WHEEL_EVENT_NOTCHES, Math.max(-MAX_WHEEL_EVENT_NOTCHES, notches));
    const before = this.accumulated;
    this.accumulated = Math.min(this.limitNotches, Math.max(-this.limitNotches, before + n));
    return this.accumulated - before;
  }

  /** 進行中の払いを捨てる。 */
  reset(): void {
    this.accumulated = 0;
    this.lastTimeMs = Number.NEGATIVE_INFINITY;
  }
}
