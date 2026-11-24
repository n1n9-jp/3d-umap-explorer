import { Quaternion, Vector3 } from 'three';
import type { PerspectiveCamera } from 'three';
import { DEFAULT_WHEEL_GESTURE_LIMIT_NOTCHES, isDiscreteWheelDelta, WheelGestureLimiter } from '../controls/WheelGesture';
import { eventTimeMs, OVERVIEW_INERTIA_TIME_CONSTANT, RotationInertia } from '../controls/RotationInertia';
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
 * 毎フレーム `update(dt)` を呼ぶこと。
 */

export const OVERVIEW_MAX_PITCH = (89 * Math.PI) / 180;
export const OVERVIEW_MIN_DISTANCE = 0.002;
export const OVERVIEW_MAX_DISTANCE = 8;

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
}

const PIXELS_PER_NOTCH = 100;
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

  constructor(camera: PerspectiveCamera, domElement: HTMLElement, options: OverviewControlsOptions = {}) {
    this.camera = camera;
    this.domElement = domElement;
    this.rotateSpeed = options.rotateSpeed ?? 0.005;
    this.wheelFactor = options.wheelFactor ?? 1.15;
    this.wheelGesture = new WheelGestureLimiter({ limitNotches: overviewGestureLimitNotches(this.wheelFactor) });
    this.win = domElement.ownerDocument?.defaultView ?? (typeof window !== 'undefined' ? window : null);
    this.inertia = new RotationInertia({ defaultTimeConstant: OVERVIEW_INERTIA_TIME_CONSTANT, ...options.rotationInertia }, this.win);
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
    }
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
   * `dtSeconds` だけ進める。慣性で回ってカメラが動いたら true。
   * 回転は点群の中心（pivot）のまわりで、中心までの距離は変わらない。仰角は ±89° に収まる。
   */
  update(dtSeconds: number): boolean {
    const inertia = this.inertia;
    if (!this._enabled || this.disposed || !inertia.active) return false;
    if (!inertia.step(dtSeconds)) return false;
    const { dYaw, dPitch } = inertia;
    const pitchBefore = this.pitch();
    this.apply(orbitPose({ position: this.camera.position, quaternion: this.camera.quaternion }, this.pivot, dYaw, dPitch));
    // 仰角が ±89° に当たったら、そのぶんの角速度は捨てる（上下の端で回り続けない）
    if (dPitch !== 0 && Math.abs(this.pitch() - (pitchBefore + dPitch)) > 1e-12) inertia.blockPitch();
    return true;
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
    // ピンチ操作（ctrlKey つきのホイール）はページのズームに当たる操作で、距離の変更ではない。
    if (e.ctrlKey) return;
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
    const position = dollyPosition(this.camera.position, this.camera.quaternion, this.pivot, Math.pow(this.wheelFactor, effective));
    this.camera.position.copy(position);
    this.camera.updateMatrixWorld();
  };
}
