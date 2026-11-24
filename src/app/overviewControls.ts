import { Quaternion, Vector3 } from 'three';
import type { PerspectiveCamera } from 'three';
import { DEFAULT_WHEEL_GESTURE_LIMIT_NOTCHES, isDiscreteWheelDelta, WheelGestureLimiter } from '../controls/WheelGesture';
import { eventTimeMs, OVERVIEW_INERTIA_TIME_CONSTANT, prefersReducedMotion, RotationInertia } from '../controls/RotationInertia';
import type { RotationInertiaOptions } from '../controls/RotationInertia';

/**
 * 俯瞰モードのカメラ操作。点群の中心（pivot）のまわりを回り、ホイールで中心へ寄り・離れる。
 *
 * OrbitControls は毎フレーム `camera.lookAt(target)` で向きを決め直すため、飛行モードから
 * 切り替えた瞬間に、カメラが中心を向いていなければ視点が跳ぶ。ここでは回転を「中心まわりの剛体回転」
 * として位置と向きの両方へ同じように掛け、入った時点の位置と向きをそのまま引き継ぐ。
 * - ドラッグの左右: ワールドの +Y 軸まわりの回転（画面上の点群がドラッグへ追従する向き）
 * - ドラッグの上下: カメラの右軸まわりの回転。視線の仰角は ±MAX_PITCH に収める
 * どちらも視線の横傾き（roll）を生まないので、飛行モードへ戻しても視点は跳ばない。
 * ドラッグを離したあとは、離す直前の速さで中心のまわりを回り続けて減速する（慣性。`RotationInertia`）。
 * ホイールとピンチは「目標の距離」だけを動かし、実際の距離は毎フレーム、対数の領域で目標へ近づく
 * （`approachLogDistance`）。回転は中心までの距離を変えないので、ドラッグと寄り・離れは両立する。
 * 毎フレーム `update(dt)` を呼ぶこと。
 */

export const OVERVIEW_MAX_PITCH = (89 * Math.PI) / 180;
export const OVERVIEW_MIN_DISTANCE = 0.002;
export const OVERVIEW_MAX_DISTANCE = 8;
/** 実際の距離が目標へ近づく速さの時定数（秒）。`ln d` の目標との差が、この時間で 1/e になる。 */
export const OVERVIEW_ZOOM_TIME_CONSTANT = 0.15;
/** ピンチ（ctrlKey つきのホイール）の `deltaY` 1 あたりの、距離の倍率の対数（`factor = exp(deltaY × この値)`）。 */
export const OVERVIEW_PINCH_RATE = 0.01;
/**
 * ピンチ 1 回のイベントで距離を変える倍率の上限（ホイール 1 ノッチの 1.15 倍の 3 つぶん）。マウスで Ctrl を押しながら
 * ホイールを回すと、1 ノッチ（deltaY = 100）で約 2.7 倍と強く動くので、それを抑える。トラックパッドのピンチは
 * 小さな deltaY（1 回あたり数〜十数）が連続して届くので、この上限には掛からず、手応えは変わらない。
 */
export const OVERVIEW_PINCH_MAX_FACTOR = 1.15 ** 3;
/** `ln d` の目標との差がこれを下回ったら、目標に一致させて止める（約 0.1%。時定数 0.15 秒で、約 0.7 秒後）。 */
export const OVERVIEW_ZOOM_STOP_LN = 1e-3;

const WORLD_UP = new Vector3(0, 1, 0);
const WORLD_X = new Vector3(1, 0, 0);

export interface OverviewPose {
  position: Vector3;
  quaternion: Quaternion;
}

/**
 * `pivot` を中心に、位置と向きを一緒に回す。`dYaw` は +Y まわり（正で反時計回り）、
 * `dPitch` はカメラの右軸まわり（正でカメラが下がり、視線が上を向く）。
 * 視線の仰角が ±OVERVIEW_MAX_PITCH を超える分は切り捨てる。入力は書き換えず、新しい姿勢を返す。
 */
export function orbitPose(pose: OverviewPose, pivot: Vector3, dYaw: number, dPitch: number): OverviewPose {
  const position = pose.position.clone();
  const quaternion = pose.quaternion.clone();
  const offset = position.clone().sub(pivot);

  if (dYaw !== 0) {
    const q = new Quaternion().setFromAxisAngle(WORLD_UP, dYaw);
    offset.applyQuaternion(q);
    quaternion.premultiply(q);
  }

  if (dPitch !== 0) {
    const forward = new Vector3(0, 0, -1).applyQuaternion(quaternion);
    const pitch = Math.asin(Math.min(1, Math.max(-1, forward.y)));
    const next = Math.min(OVERVIEW_MAX_PITCH, Math.max(-OVERVIEW_MAX_PITCH, pitch + dPitch));
    const applied = next - pitch;
    if (applied !== 0) {
      // 右軸は水平（roll が無いので）。向きの +X をそのまま使う。
      const right = WORLD_X.clone().applyQuaternion(quaternion);
      const q = new Quaternion().setFromAxisAngle(right, applied);
      offset.applyQuaternion(q);
      quaternion.premultiply(q);
    }
  }

  quaternion.normalize();
  return { position: pivot.clone().add(offset), quaternion };
}

/** `pivot` からの距離を `factor` 倍にする（位置だけ動かし、向きは変えない）。距離は範囲内に収める。 */
export function dollyPosition(
  position: Vector3,
  quaternion: Quaternion,
  pivot: Vector3,
  factor: number,
  minDistance = OVERVIEW_MIN_DISTANCE,
  maxDistance = OVERVIEW_MAX_DISTANCE,
): Vector3 {
  const offset = position.clone().sub(pivot);
  const distance = offset.length();
  // 中心と重なっているときは、視線の反対側へ退く向きを使う。
  const dir = distance > 1e-9 ? offset.multiplyScalar(1 / distance) : new Vector3(0, 0, 1).applyQuaternion(quaternion);
  const next = Math.min(maxDistance, Math.max(minDistance, Math.max(distance, minDistance) * factor));
  return pivot.clone().addScaledVector(dir, next);
}

/**
 * 距離の対数 `current` を、目標 `target` へ `dtSeconds` だけ近づける:
 * `current += (target − current) × (1 − exp(−dt/τ))`。解析解なので、刻み幅を分けても結果は同じ。
 * 差が `stopLn` 未満になったら（または `tau` が 0 以下なら）目標に一致させ、`done` を true にする。
 * `dtSeconds` が負・有限でないとき、0 のときは動かさない（`tau` が 0 以下なら、いつでも目標へ一致させる）。
 */
export function approachLogDistance(
  current: number,
  target: number,
  dtSeconds: number,
  tau: number,
  stopLn = OVERVIEW_ZOOM_STOP_LN,
): { value: number; done: boolean } {
  if (!(tau > 0)) return { value: target, done: true };
  if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) return { value: current, done: Math.abs(target - current) < stopLn };
  const next = current + (target - current) * (1 - Math.exp(-dtSeconds / tau));
  if (Math.abs(target - next) < stopLn) return { value: target, done: true };
  return { value: next, done: false };
}

/** 俯瞰モードの距離の状態（検証・表示用）。 */
export interface OverviewZoomState {
  /** 点群の中心（pivot）から、カメラまでの実際の距離。 */
  distance: number;
  /** ホイール・ピンチが決めた目標の距離。寄っている途中でなければ `distance` と同じ。 */
  targetDistance: number;
  /** 実際の距離が目標へ寄っている途中か。 */
  zooming: boolean;
}

export interface OverviewControlsOptions {
  /** ドラッグ 1 ピクセルあたりの回転量（ラジアン）。 */
  rotateSpeed?: number;
  /** ホイール 1 ノッチあたりの距離の倍率（正で離れる向きにこの値を掛ける）。 */
  wheelFactor?: number;
  /**
   * ドラッグを離したあとの回転の慣性。`timeConstant` を 0 以下にすると無効。
   * 省略すると、時定数 0.45 秒で、「動きを減らす」設定（`prefers-reduced-motion: reduce`）なら無効。
   */
  rotationInertia?: RotationInertiaOptions;
  /**
   * 距離が目標へ近づく速さの時定数（秒）。0 以下で、ホイール 1 回ごとに距離が 1 度に動く。
   * 省略すると、0.15 秒で、「動きを減らす」設定（`prefers-reduced-motion: reduce`）なら 0。
   */
  zoomTimeConstant?: number;
}

const PIXELS_PER_NOTCH = 100;
/** 対数を取るときの、距離の下限（中心と重なったカメラで `ln 0` にならないように）。 */
const TINY_DISTANCE = 1e-9;
const LINES_PER_NOTCH = 3;
/** 飛行モードの速度の倍率（1 ノッチあたり）。払いの上限を、飛行モードと同じ倍率の変化に揃える基準。 */
const FLY_WHEEL_FACTOR = 1.1;

/**
 * 1 回の払いで距離を変えられる倍率の上限が、飛行モードの速度（1.1^7 ≈ 1.95 倍）と同じになるノッチ数。
 * 俯瞰モードは 1 ノッチあたりの倍率が大きいので、ノッチ数そのものは飛行モードより少なくなる。
 */
export function overviewGestureLimitNotches(wheelFactor: number): number {
  if (!(wheelFactor > 1) || !Number.isFinite(wheelFactor)) return DEFAULT_WHEEL_GESTURE_LIMIT_NOTCHES;
  return (DEFAULT_WHEEL_GESTURE_LIMIT_NOTCHES * Math.log(FLY_WHEEL_FACTOR)) / Math.log(wheelFactor);
}

export class OverviewControls {
  readonly camera: PerspectiveCamera;
  readonly domElement: HTMLElement;
  readonly pivot = new Vector3();
  rotateSpeed: number;
  wheelFactor: number;

  private _enabled = false;
  private dragPointerId: number | null = null;
  private lastX = 0;
  private lastY = 0;
  private disposed = false;
  /** タッチパッドの 1 回の払いでの距離の変化を、飛行モードの速度と同じ倍率（約 1.95 倍）に制限する。 */
  private readonly wheelGesture: WheelGestureLimiter;
  private readonly inertia: RotationInertia;
  private readonly win: Window | null;
  /** 時定数を明示したときの値。null は自動（既定値。ただし「動きを減らす」設定なら 0）。 */
  private explicitZoomTimeConstant: number | null;
  /** 目標の距離の対数。寄っている途中でなければ null（その間、距離の持ち主はカメラの位置）。 */
  private zoomTargetLn: number | null = null;

  constructor(camera: PerspectiveCamera, domElement: HTMLElement, options: OverviewControlsOptions = {}) {
    this.camera = camera;
    this.domElement = domElement;
    this.rotateSpeed = options.rotateSpeed ?? 0.005;
    this.wheelFactor = options.wheelFactor ?? 1.15;
    this.wheelGesture = new WheelGestureLimiter({ limitNotches: overviewGestureLimitNotches(this.wheelFactor) });
    this.win = domElement.ownerDocument?.defaultView ?? (typeof window !== 'undefined' ? window : null);
    this.inertia = new RotationInertia({ defaultTimeConstant: OVERVIEW_INERTIA_TIME_CONSTANT, ...options.rotationInertia }, this.win);
    this.explicitZoomTimeConstant = options.zoomTimeConstant ?? null;
    domElement.addEventListener('pointerdown', this.onPointerDown);
    domElement.addEventListener('pointermove', this.onPointerMove);
    domElement.addEventListener('pointerup', this.onPointerUp);
    domElement.addEventListener('pointercancel', this.onPointerCancel);
    domElement.addEventListener('lostpointercapture', this.onPointerCancel);
    domElement.addEventListener('wheel', this.onWheel, { passive: false });
    this.win?.addEventListener('blur', this.onBlur);
  }

  get enabled(): boolean {
    return this._enabled;
  }

  set enabled(value: boolean) {
    if (value === this._enabled) return;
    this._enabled = value;
    if (!value) {
      this.endDrag();
      this.inertia.cancelDrag();
      this.inertia.stop();
      this.wheelGesture.reset();
      this.zoomTargetLn = null;
    }
  }

  /**
   * 距離が目標へ近づく速さの時定数（秒）。0 以下で、ホイールもピンチも 1 度に距離を動かす。
   * 代入しなければ既定の 0.15 秒（「動きを減らす」設定なら 0）。`null` を代入すると、その既定へ戻す。
   */
  get zoomTimeConstant(): number {
    if (this.explicitZoomTimeConstant !== null) return this.explicitZoomTimeConstant;
    return prefersReducedMotion(this.win) ? 0 : OVERVIEW_ZOOM_TIME_CONSTANT;
  }

  set zoomTimeConstant(value: number | null) {
    if (value === null) this.explicitZoomTimeConstant = null;
    else if (Number.isFinite(value)) this.explicitZoomTimeConstant = value;
  }

  /** 中心（pivot）からカメラまでの実際の距離。 */
  get distance(): number {
    return this.camera.position.distanceTo(this.pivot);
  }

  /** ホイール・ピンチが決めた目標の距離。寄っている途中でなければ、実際の距離と同じ。 */
  get targetDistance(): number {
    return this.zoomTargetLn !== null ? Math.exp(this.zoomTargetLn) : this.distance;
  }

  /** 実際の距離が目標へ寄っている途中なら true。 */
  get isZooming(): boolean {
    return this.zoomTargetLn !== null;
  }

  zoomState(): OverviewZoomState {
    return { distance: this.distance, targetDistance: this.targetDistance, zooming: this.isZooming };
  }

  /** 寄っている途中の距離の変化を止める（位置と向きはそのまま。目標は今の距離になる）。 */
  stopZoom(): void {
    this.zoomTargetLn = null;
  }

  /**
   * ドラッグを離したあとの回転の慣性の時定数（秒）。0 以下で無効。
   * 代入しなければ既定の 0.45 秒（「動きを減らす」設定なら無効）。`null` を代入すると、その既定へ戻す。
   */
  get rotationTimeConstant(): number {
    return this.inertia.timeConstant;
  }

  set rotationTimeConstant(value: number | null) {
    this.inertia.timeConstant = value;
  }

  /** 回転の慣性で回っている最中なら true。 */
  get isRotatingByInertia(): boolean {
    return this.inertia.active;
  }

  /**
   * 慣性で回っている角速度（ラジアン/秒）。ヨーは正で反時計回り、ピッチは正で視線が上を向く向き（`orbitPose` の符号）。
   * モードの切り替えで無効にする前に読み、呼び出し側が減衰させ続けるために使う。回っていなければ 0。
   */
  getResidualRotation(): { yawRate: number; pitchRate: number } {
    const active = this.inertia.active;
    return { yawRate: active ? this.inertia.yawRate : 0, pitchRate: active ? this.inertia.pitchRate : 0 };
  }

  /**
   * 押下 `e`（pointerdown）が、回転の慣性を止めた押下か。点のクリックの判定が、慣性を止めるための押下を
   * クリックに数えないために使う。カメラ操作とそのリスナーの登録順によらず、同じ答えになる
   * （先にこちらが止めたときは覚えた押下と比べ、まだ止めていないときは、回っていれば true）。
   */
  pressStopsInertia(e: Event): boolean {
    return this._enabled && this.inertia.isStoppedBy(e);
  }

  /** 回転の慣性を止める（位置と向きはそのまま）。 */
  stopRotationInertia(): void {
    this.inertia.stop();
  }

  /**
   * `dtSeconds` だけ進める。回転の慣性か、目標の距離への近づきでカメラが動いたら true。
   * 回転は点群の中心（pivot）のまわりで、中心までの距離は変わらない。仰角は ±89° に収まる。
   * 距離は、中心から見たカメラの向きと視線の向きを変えずに、対数の領域で目標へ近づく。
   */
  update(dtSeconds: number): boolean {
    if (!this._enabled || this.disposed) return false;
    let moved = false;
    const inertia = this.inertia;
    if (inertia.active && inertia.step(dtSeconds)) {
      const { dYaw, dPitch } = inertia;
      const pitchBefore = this.pitch();
      this.apply(orbitPose({ position: this.camera.position, quaternion: this.camera.quaternion }, this.pivot, dYaw, dPitch));
      // 仰角が ±89° に当たったら、そのぶんの角速度は捨てる（上下の端で回り続けない）
      if (dPitch !== 0 && Math.abs(this.pitch() - (pitchBefore + dPitch)) > 1e-12) inertia.blockPitch();
      moved = true;
    }
    if (this.zoomTargetLn !== null && this.stepZoom(dtSeconds)) moved = true;
    return moved;
  }

  /** 実際の距離を目標へ `dtSeconds` だけ近づける。カメラが動いたら true。 */
  private stepZoom(dtSeconds: number): boolean {
    const target = this.zoomTargetLn;
    if (target === null) return false;
    const tau = this.zoomTimeConstant;
    if (tau > 0 && !(Number.isFinite(dtSeconds) && dtSeconds > 0)) return false;
    const current = Math.log(Math.max(this.distance, TINY_DISTANCE));
    const { value, done } = approachLogDistance(current, target, dtSeconds, tau);
    if (done) this.zoomTargetLn = null;
    this.setDistance(Math.exp(value));
    return true;
  }

  /** 中心から見たカメラの向きと、視線の向きは変えずに、中心までの距離を `distance` にする。 */
  private setDistance(distance: number): void {
    const offset = this.camera.position.clone().sub(this.pivot);
    const current = offset.length();
    // 中心と重なっているときは、視線の反対側へ退く向きを使う。
    const dir = current > 1e-9 ? offset.multiplyScalar(1 / current) : new Vector3(0, 0, 1).applyQuaternion(this.camera.quaternion);
    this.camera.position.copy(this.pivot).addScaledVector(dir, distance);
    this.camera.updateMatrixWorld();
  }

  /**
   * 目標の距離を `factor` 倍にする。目標は、寄っている途中ならその目標、そうでなければ今の距離を基準にし、
   * 距離の範囲（最小・最大）に収める。時定数が 0 以下なら、実際の距離も 1 度に動かす。
   */
  private zoomBy(factor: number): void {
    if (!(factor > 0) || !Number.isFinite(factor)) return;
    const base = this.zoomTargetLn !== null ? Math.exp(this.zoomTargetLn) : Math.max(this.distance, OVERVIEW_MIN_DISTANCE);
    const target = Math.min(OVERVIEW_MAX_DISTANCE, Math.max(OVERVIEW_MIN_DISTANCE, base * factor));
    if (!(this.zoomTimeConstant > 0)) {
      this.zoomTargetLn = null;
      this.setDistance(target);
      return;
    }
    const targetLn = Math.log(target);
    // 範囲の端で、すでに目標の距離にいるなら、寄っている途中にはしない
    if (this.zoomTargetLn === null && Math.abs(targetLn - Math.log(Math.max(this.distance, TINY_DISTANCE))) < OVERVIEW_ZOOM_STOP_LN) return;
    this.zoomTargetLn = targetLn;
  }

  private pitch(): number {
    const forward = new Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    return Math.asin(Math.min(1, Math.max(-1, forward.y)));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.domElement.removeEventListener('pointerdown', this.onPointerDown);
    this.domElement.removeEventListener('pointermove', this.onPointerMove);
    this.domElement.removeEventListener('pointerup', this.onPointerUp);
    this.domElement.removeEventListener('pointercancel', this.onPointerCancel);
    this.domElement.removeEventListener('lostpointercapture', this.onPointerCancel);
    this.domElement.removeEventListener('wheel', this.onWheel);
    this.win?.removeEventListener('blur', this.onBlur);
    this.endDrag();
    this.inertia.cancelDrag();
    this.inertia.stop();
    this.zoomTargetLn = null;
  }

  private apply(pose: OverviewPose): void {
    this.camera.position.copy(pose.position);
    this.camera.quaternion.copy(pose.quaternion);
    this.camera.updateMatrixWorld();
  }

  private endDrag(): void {
    const id = this.dragPointerId;
    this.dragPointerId = null;
    if (id !== null && typeof this.domElement.releasePointerCapture === 'function') {
      try {
        this.domElement.releasePointerCapture(id);
      } catch {
        // すでに解放済み
      }
    }
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (!this._enabled) return;
    // 慣性で回っている間にポインタを押したら止める（どのボタンでも）。止めた押下は覚えて、
    // クリックの判定（`pressStopsInertia`）が「回転を止めるための押下」を点のクリックに数えないようにする
    this.inertia.stopByPress(e);
    if (e.button !== 0 || this.dragPointerId !== null) return;
    this.dragPointerId = e.pointerId;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.inertia.beginDrag(e.clientX, e.clientY, eventTimeMs(e));
    try {
      this.domElement.setPointerCapture(e.pointerId);
    } catch {
      // 合成イベントなどでキャプチャできない場合は無視
    }
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (!this._enabled || e.pointerId !== this.dragPointerId) return;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.inertia.dragMove(e.clientX, e.clientY, eventTimeMs(e));
    // 右へドラッグすると点群が右へ回り込み（カメラは左へ）、下へドラッグすると点群の上面がこちらへ傾く。
    this.apply(
      orbitPose(
        { position: this.camera.position, quaternion: this.camera.quaternion },
        this.pivot,
        -dx * this.rotateSpeed,
        -dy * this.rotateSpeed,
      ),
    );
  };

  /** 離した。離す直前の動きが速ければ、その速さで回り続ける。 */
  private readonly onPointerUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.dragPointerId) return;
    this.endDrag();
    this.inertia.endDrag(eventTimeMs(e), this.rotateSpeed, e.clientX, e.clientY);
  };

  /** 押下の取り消し（pointercancel・lostpointercapture）。慣性は付けない。 */
  private readonly onPointerCancel = (e: PointerEvent): void => {
    if (e.pointerId !== this.dragPointerId) return;
    this.inertia.cancelDrag();
    this.endDrag();
  };

  /** ウィンドウがフォーカスを失った。ドラッグも慣性も捨てる。 */
  private readonly onBlur = (): void => {
    this.endDrag();
    this.inertia.cancelDrag();
    this.inertia.stop();
  };

  private readonly onWheel = (e: WheelEvent): void => {
    if (!this._enabled) return;
    e.preventDefault();
    // ピンチ操作（ctrlKey つきのホイール）は、ページのズームは止めて、距離を変える。広げる（deltaY < 0）と近づく。
    // 払いの上限（タッチパッドとマウスの判別）は、通常のホイールのためのもので、ピンチには掛けない。
    if (e.ctrlKey) {
      if (e.deltaY === 0 || !Number.isFinite(e.deltaY)) return;
      this.zoomBy(Math.exp(clampPinchLn(e.deltaY * OVERVIEW_PINCH_RATE)));
      return;
    }
    // 横方向だけのスクロールは、距離の変更ではなく、払いの継続にも数えない。
    if (e.deltaY === 0) return;
    let notches: number;
    switch (e.deltaMode) {
      case 1:
        notches = e.deltaY / LINES_PER_NOTCH;
        break;
      case 2:
        notches = e.deltaY;
        break;
      default:
        notches = e.deltaY / PIXELS_PER_NOTCH;
    }
    const timeMs = typeof e.timeStamp === 'number' ? e.timeStamp : performance.now();
    const effective = this.wheelGesture.consume(notches, timeMs, isDiscreteWheelDelta(e.deltaMode, e.deltaY));
    if (effective === 0) return;
    // 下へ回す（正）と離れ、上へ回す（負）と近づく。
    this.zoomBy(Math.pow(this.wheelFactor, effective));
  };
}

/** ピンチ 1 回のイベントの倍率の対数を、`±ln(OVERVIEW_PINCH_MAX_FACTOR)` に収める。 */
function clampPinchLn(ln: number): number {
  const max = Math.log(OVERVIEW_PINCH_MAX_FACTOR);
  return Math.min(max, Math.max(-max, ln));
}
