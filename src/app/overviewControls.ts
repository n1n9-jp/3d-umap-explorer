import { Quaternion, Vector3 } from 'three';
import type { PerspectiveCamera } from 'three';
import { DEFAULT_WHEEL_GESTURE_LIMIT_NOTCHES, isDiscreteWheelDelta, WheelGestureLimiter } from '../controls/WheelGesture';

/**
 * 俯瞰モードのカメラ操作。点群の中心（pivot）のまわりを回り、ホイールで中心へ寄り・離れる。
 *
 * OrbitControls は毎フレーム `camera.lookAt(target)` で向きを決め直すため、飛行モードから
 * 切り替えた瞬間に、カメラが中心を向いていなければ視点が跳ぶ。ここでは回転を「中心まわりの剛体回転」
 * として位置と向きの両方へ同じように掛け、入った時点の位置と向きをそのまま引き継ぐ。
 * - ドラッグの左右: ワールドの +Y 軸まわりの回転（画面上の点群がドラッグへ追従する向き）
 * - ドラッグの上下: カメラの右軸まわりの回転。視線の仰角は ±MAX_PITCH に収める
 * どちらも視線の横傾き（roll）を生まないので、飛行モードへ戻しても視点は跳ばない。
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

  constructor(camera: PerspectiveCamera, domElement: HTMLElement, options: OverviewControlsOptions = {}) {
    this.camera = camera;
    this.domElement = domElement;
    this.rotateSpeed = options.rotateSpeed ?? 0.005;
    this.wheelFactor = options.wheelFactor ?? 1.15;
    this.wheelGesture = new WheelGestureLimiter({ limitNotches: overviewGestureLimitNotches(this.wheelFactor) });
    domElement.addEventListener('pointerdown', this.onPointerDown);
    domElement.addEventListener('pointermove', this.onPointerMove);
    domElement.addEventListener('pointerup', this.onPointerUp);
    domElement.addEventListener('pointercancel', this.onPointerUp);
    domElement.addEventListener('lostpointercapture', this.onPointerUp);
    domElement.addEventListener('wheel', this.onWheel, { passive: false });
  }

  get enabled(): boolean {
    return this._enabled;
  }

  set enabled(value: boolean) {
    if (value === this._enabled) return;
    this._enabled = value;
    if (!value) {
      this.endDrag();
      this.wheelGesture.reset();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.domElement.removeEventListener('pointerdown', this.onPointerDown);
    this.domElement.removeEventListener('pointermove', this.onPointerMove);
    this.domElement.removeEventListener('pointerup', this.onPointerUp);
    this.domElement.removeEventListener('pointercancel', this.onPointerUp);
    this.domElement.removeEventListener('lostpointercapture', this.onPointerUp);
    this.domElement.removeEventListener('wheel', this.onWheel);
    this.endDrag();
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
    if (!this._enabled || e.button !== 0 || this.dragPointerId !== null) return;
    this.dragPointerId = e.pointerId;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
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

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.dragPointerId) return;
    this.endDrag();
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
