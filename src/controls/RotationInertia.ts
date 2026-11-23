/**
 * ドラッグで視点を回したあとの回転の慣性。DOM にも three.js にも依存せず、
 * ポインタの座標と時刻から「離したときの回転の速さ」を求め、その速さで回り続けて減速するまでを受け持つ。
 *
 * - ドラッグ中の回転は呼び出し側がポインタの動きにそのまま追従させる（ここでは遅れを入れない）。
 * - 離したときの速さは、離す直前の短い時間（既定 90 ミリ秒）のポインタの動きから求める。
 *   ポインタを止めてから離したとき・動かさずに離したとき（クリック）は、慣性を付けない。
 * - 慣性は角速度が指数的に減る（時定数 `timeConstant`）。1 回の `step` の回転量は解析解なので、
 *   刻み幅によらず総回転量は同じ（`v0 · τ · (1 − e^(−T/τ))`）。
 * - 角速度が `stopSpeed` を下回ったら、完全に止める（微小な回転を続けて、カメラが動いている扱いが終わらない、
 *   ということを防ぐ）。
 */

/** 減速の時定数（秒）。0 以下で慣性なし。 */
export const DEFAULT_INERTIA_TIME_CONSTANT = 0.3;
/** 慣性の最初の角速度の上限（ラジアン/秒）。時定数 0.3 秒で、最大でも約 69°（1.2 ラジアン）しか回らない。 */
export const DEFAULT_INERTIA_MAX_SPEED = 4;
/** 角速度がこれを下回ったら完全に止める（ラジアン/秒。約 1.1°/秒）。 */
export const DEFAULT_INERTIA_STOP_SPEED = 0.02;
/** 離したときの速さを求める、離す直前の時間（秒）。 */
export const DEFAULT_RELEASE_WINDOW_SECONDS = 0.09;
/** 離したときのポインタの速さがこれ未満なら、慣性を付けない（CSS ピクセル/秒）。 */
export const DEFAULT_MIN_RELEASE_SPEED_PX = 80;
/** 押した位置からこの距離を超えて動かなかった操作は、クリックとして慣性を付けない（CSS ピクセル）。 */
export const DEFAULT_INERTIA_DRAG_THRESHOLD_PX = 4;

export interface RotationInertiaOptions {
  /** 減速の時定数（秒）。0 以下で無効。省略すると、`prefers-reduced-motion: reduce` なら無効、そうでなければ 0.3。 */
  timeConstant?: number;
  /** 慣性の最初の角速度の上限（ラジアン/秒）。 */
  maxSpeed?: number;
  /** 角速度がこれを下回ったら完全に止める（ラジアン/秒）。 */
  stopSpeed?: number;
  /** 離したときの速さを求める、離す直前の時間（秒）。 */
  releaseWindowSeconds?: number;
  /** 離したときのポインタの速さがこれ未満なら、慣性を付けない（CSS ピクセル/秒）。 */
  minReleaseSpeedPx?: number;
  /** この距離を超えて動かさなかった押下は、クリックとして慣性を付けない（CSS ピクセル）。 */
  dragThresholdPx?: number;
}

/** OS・ブラウザの「視差効果を減らす」（`prefers-reduced-motion: reduce`）が有効か。判定できなければ false。 */
export function prefersReducedMotion(win: Pick<Window, 'matchMedia'> | null | undefined): boolean {
  try {
    return typeof win?.matchMedia === 'function' && win.matchMedia('(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    return false;
  }
}

/** イベントの時刻（ミリ秒）。`timeStamp` がなければ現在時刻。 */
export function eventTimeMs(e: { timeStamp?: number }): number {
  const t = e.timeStamp;
  return typeof t === 'number' && Number.isFinite(t) && t > 0 ? t : performance.now();
}

interface Sample {
  /** 区間の始まり・終わり（ミリ秒）。区間は直前の標本（または押した時刻）から、この標本まで。 */
  t0: number;
  t1: number;
  dx: number;
  dy: number;
}

/** 標本として覚えておく時間（ミリ秒）。速さを求める時間幅より十分長ければよい。 */
const KEEP_MS = 500;
/** 区間の長さの下限（ミリ秒）。同じ時刻に届いた動きで 0 除算にならないようにする。 */
const MIN_SAMPLE_MS = 1;
/** 速さを求める時間幅の下限（ミリ秒）。ごく短いドラッグで速さが跳ね上がらないようにする。 */
const MIN_WINDOW_MS = 16;

/**
 * 離す直前のポインタの速さ（CSS ピクセル/秒）を求める。
 * 1 回の移動イベントの動きは、直前のイベントから今回までの区間で一様に起きたとみなし、
 * そのうち窓（離す時刻の手前 `windowSeconds`）に入る分だけを数える。ブラウザが移動イベントを
 * フレームごとにまとめて届けても、動いた速さを過大に見積もらない。
 */
export class DragVelocityTracker {
  private readonly windowMs: number;
  private readonly dragThreshold: number;
  private samples: Sample[] = [];
  private active = false;
  private downX = 0;
  private downY = 0;
  private downT = 0;
  private lastX = 0;
  private lastY = 0;
  private lastT = 0;
  private dragged = false;

  constructor(windowSeconds = DEFAULT_RELEASE_WINDOW_SECONDS, dragThresholdPx = DEFAULT_INERTIA_DRAG_THRESHOLD_PX) {
    this.windowMs = Math.max(MIN_WINDOW_MS, windowSeconds * 1000);
    this.dragThreshold = dragThresholdPx;
  }

  begin(x: number, y: number, timeMs: number): void {
    this.samples = [];
    this.active = true;
    this.dragged = false;
    this.downX = this.lastX = x;
    this.downY = this.lastY = y;
    this.downT = this.lastT = timeMs;
  }

  move(x: number, y: number, timeMs: number): void {
    if (!this.active) return;
    const t1 = Math.max(timeMs, this.lastT);
    const dx = x - this.lastX;
    const dy = y - this.lastY;
    if (dx !== 0 || dy !== 0) {
      this.samples.push({ t0: this.lastT, t1, dx, dy });
    }
    this.lastX = x;
    this.lastY = y;
    this.lastT = t1;
    if (!this.dragged && Math.hypot(x - this.downX, y - this.downY) > this.dragThreshold) this.dragged = true;
    const oldest = t1 - KEEP_MS;
    while (this.samples.length > 0 && this.samples[0].t1 < oldest) this.samples.shift();
  }

  /**
   * 離したときのポインタの速さ（CSS ピクセル/秒）。ドラッグと判定されなかった押下（クリック）なら null。
   * 呼んだあとは、次の `begin` まで何も覚えていない状態になる。
   */
  release(timeMs: number): { vx: number; vy: number } | null {
    const { active, dragged } = this;
    this.active = false;
    const samples = this.samples;
    this.samples = [];
    if (!active || !dragged) return null;

    const end = Math.max(timeMs, this.lastT);
    const windowMs = Math.min(this.windowMs, Math.max(MIN_WINDOW_MS, end - this.downT));
    const start = end - windowMs;
    let sx = 0;
    let sy = 0;
    for (const s of samples) {
      const span = Math.max(MIN_SAMPLE_MS, s.t1 - s.t0);
      // 区間 [t1 − span, t1] のうち、窓に入る長さ
      const overlap = Math.min(s.t1, end) - Math.max(s.t1 - span, start);
      if (overlap <= 0) continue;
      const share = Math.min(1, overlap / span);
      sx += s.dx * share;
      sy += s.dy * share;
    }
    return { vx: (sx * 1000) / windowMs, vy: (sy * 1000) / windowMs };
  }

  cancel(): void {
    this.active = false;
    this.samples = [];
  }
}

/**
 * 回転の慣性の状態と積分。ヨー（`yaw`）とピッチ（`pitch`）の角速度を持つ。
 * 回転の向きの約束は呼び出し側と同じで、正のヨーは左、正のピッチは上（`FlyMotion.rotateBy` と同じ）。
 */
export class RotationInertia {
  /** 時定数を明示したときの値。null は自動（既定値。ただし「動きを減らす」設定なら無効）。 */
  private explicitTimeConstant: number | null;
  maxSpeed: number;
  stopSpeed: number;
  minReleaseSpeedPx: number;

  /** `step` が返した、直近の回転量（ラジアン）。 */
  dYaw = 0;
  dPitch = 0;

  private readonly tracker: DragVelocityTracker;
  private readonly win: Pick<Window, 'matchMedia'> | null;
  private vYaw = 0;
  private vPitch = 0;
  private _active = false;

  constructor(options: RotationInertiaOptions = {}, win: Pick<Window, 'matchMedia'> | null = null) {
    this.explicitTimeConstant = options.timeConstant ?? null;
    this.maxSpeed = options.maxSpeed ?? DEFAULT_INERTIA_MAX_SPEED;
    this.stopSpeed = options.stopSpeed ?? DEFAULT_INERTIA_STOP_SPEED;
    this.minReleaseSpeedPx = options.minReleaseSpeedPx ?? DEFAULT_MIN_RELEASE_SPEED_PX;
    this.tracker = new DragVelocityTracker(options.releaseWindowSeconds, options.dragThresholdPx);
    this.win = win;
  }

  /** 実際に使う時定数（秒）。0 以下は無効。省略したときは、「動きを減らす」設定なら 0、そうでなければ既定値。 */
  get timeConstant(): number {
    if (this.explicitTimeConstant !== null) return this.explicitTimeConstant;
    return prefersReducedMotion(this.win) ? 0 : DEFAULT_INERTIA_TIME_CONSTANT;
  }

  /** 時定数を決める。0 以下で無効。null で自動（既定値、「動きを減らす」設定なら無効）に戻す。NaN は無視する。 */
  set timeConstant(value: number | null) {
    if (value === null) this.explicitTimeConstant = null;
    else if (Number.isFinite(value)) this.explicitTimeConstant = value;
    if (!(this.timeConstant > 0)) this.stop();
  }

  get enabled(): boolean {
    return this.timeConstant > 0;
  }

  /** 慣性で回っている最中か。 */
  get active(): boolean {
    return this._active;
  }

  /** 現在の角速度（ラジアン/秒）。 */
  get speed(): number {
    return Math.hypot(this.vYaw, this.vPitch);
  }

  // ---- ドラッグ ----

  /** 押した。慣性を止めて、速さの計測を始める。 */
  beginDrag(x: number, y: number, timeMs: number): void {
    this.stop();
    this.tracker.begin(x, y, timeMs);
  }

  dragMove(x: number, y: number, timeMs: number): void {
    this.tracker.move(x, y, timeMs);
  }

  /**
   * 離した。離す直前の動きから角速度を求めて、慣性を始める。始まったら true。
   * `radiansPerPixel` は、ドラッグ 1 ピクセルあたりの回転量。ドラッグと同じく、右へ動かすと負のヨー、
   * 下へ動かすと負のピッチ（右・下を向く）になる。
   */
  endDrag(timeMs: number, radiansPerPixel: number): boolean {
    const v = this.tracker.release(timeMs);
    if (!v || !this.enabled) return false;
    if (Math.hypot(v.vx, v.vy) < this.minReleaseSpeedPx) return false;
    return this.start(-v.vx * radiansPerPixel, -v.vy * radiansPerPixel);
  }

  /** 押下の取り消し（pointercancel など）。慣性は付けない。 */
  cancelDrag(): void {
    this.tracker.cancel();
  }

  // ---- 慣性 ----

  /** 角速度（ラジアン/秒）を指定して慣性を始める。上限を超える分は切り、`stopSpeed` 未満なら始めない。 */
  start(yawRate: number, pitchRate: number): boolean {
    this.stop();
    if (!this.enabled || !Number.isFinite(yawRate) || !Number.isFinite(pitchRate)) return false;
    const speed = Math.hypot(yawRate, pitchRate);
    if (!(speed > this.stopSpeed)) return false;
    const k = speed > this.maxSpeed ? this.maxSpeed / speed : 1;
    this.vYaw = yawRate * k;
    this.vPitch = pitchRate * k;
    this._active = true;
    return true;
  }

  /** 慣性を止める。 */
  stop(): void {
    this.vYaw = 0;
    this.vPitch = 0;
    this.dYaw = 0;
    this.dPitch = 0;
    this._active = false;
  }

  /**
   * `dtSeconds` だけ進める。回転量を `dYaw`・`dPitch` に書いて、回すべきなら true。
   * 角速度が `stopSpeed` を下回ったら、この回転を最後に完全に止める。
   */
  step(dtSeconds: number): boolean {
    this.dYaw = 0;
    this.dPitch = 0;
    if (!this._active) return false;
    if (!Number.isFinite(dtSeconds) || dtSeconds < 0) return false;
    const tau = this.timeConstant;
    if (!(tau > 0)) {
      this.stop();
      return false;
    }
    if (dtSeconds === 0) return false;
    const decay = Math.exp(-dtSeconds / tau);
    const gain = tau * (1 - decay);
    this.dYaw = this.vYaw * gain;
    this.dPitch = this.vPitch * gain;
    this.vYaw *= decay;
    this.vPitch *= decay;
    if (this.speed < this.stopSpeed) this.finish();
    return true;
  }

  /** 回転の制限（ピッチの上限・下限）に当たったとき、ピッチの角速度を捨てる。残りがなければ止まる。 */
  blockPitch(): void {
    this.vPitch = 0;
    if (this._active && this.speed < this.stopSpeed) this.finish();
  }

  /** 角速度を捨てて、止まった状態にする（直近の回転量は残す）。 */
  private finish(): void {
    this.vYaw = 0;
    this.vPitch = 0;
    this._active = false;
  }
}
