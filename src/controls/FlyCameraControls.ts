import { EventDispatcher, Euler, Vector3 } from 'three';
import type { PerspectiveCamera } from 'three';
import { FlyMotion, createMoveInput } from './FlyMotion';
import type { FlyMotionOptions, FlyPose, FlyToOptions, MoveInput } from './FlyMotion';
import { isDiscreteWheelDelta, WheelGestureLimiter } from './WheelGesture';
import { eventTimeMs, RotationInertia } from './RotationInertia';
import type { RotationInertiaOptions } from './RotationInertia';

export type { FlyPose, FlyToOptions } from './FlyMotion';

export interface FlyCameraControlsOptions extends FlyMotionOptions {
  /** ドラッグ 1 ピクセルあたりの回転量（ラジアン）。 */
  rotateSpeed?: number;
  /**
   * ドラッグを離したあとの回転の慣性。`timeConstant` を 0 以下にすると無効。
   * 省略すると、時定数 0.3 秒で、「動きを減らす」設定（`prefers-reduced-motion: reduce`）なら無効。
   */
  rotationInertia?: RotationInertiaOptions;
}

export interface FlyCameraControlsEventMap {
  /** カメラの位置または向きが変わった。 */
  change: object;
  /** 移動速度が変わった。 */
  speedchange: { speed: number };
}

/** 1 ノッチ相当のホイール量。 */
const PIXELS_PER_NOTCH = 100;
const LINES_PER_NOTCH = 3;

/** keydown / keyup が届かなくなる（macOS で Cmd を押している間など）ので、押下状態を信用できなくなるキー。 */
const META_CODES = new Set(['MetaLeft', 'MetaRight']);

const KEY_MAP: Record<string, keyof MoveInput | undefined> = {
  KeyW: 'forward',
  ArrowUp: 'forward',
  KeyS: 'backward',
  ArrowDown: 'backward',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  KeyE: 'up',
  KeyQ: 'down',
};

/**
 * キーイベントの発生元の要素。シャドウDOM 内で発生したイベントは、外側のリスナーから見ると
 * `target` がシャドウホストに付け替えられるので、`composedPath()` の先頭（実際の発生元）を使う。
 * `composedPath` が無い・空のときは `target` を使う。
 */
function eventOrigin(e: Event): EventTarget | null {
  const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
  return path[0] ?? e.target ?? null;
}

function isMetaKey(e: KeyboardEvent): boolean {
  return META_CODES.has(e.code) || e.key === 'Meta';
}

function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as Partial<HTMLElement> | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable === true) return true;
  const ce = typeof el.getAttribute === 'function' ? el.getAttribute('contenteditable') : null;
  return ce !== null && ce !== undefined && ce.toLowerCase() !== 'false';
}

/**
 * 点群の内部を飛び回るための一人称の飛行カメラ操作。
 *
 * - 移動: W/S 前後、A/D 左右、E/Q 上下（ワールド）、矢印キーは WASD と同じ
 * - 視点: 左ボタンのドラッグ（ドラッグした向きへ視線が動く）。離したあとも、離す直前の速さで回り続けて
 *   指数的に減速する（慣性。`RotationInertia`）。ポインタの押下・`flyTo`・`setPose`・無効化・フォーカスの喪失で止まる
 * - 速度: ホイール（乗算的。1 ノッチ ≈ 1.1 倍。連続したイベントは 1 回の払いとみなし、
 *   1 回の払いで変わる倍率は約 2 倍までに抑える。ピンチ（ctrlKey つき）は速度を変えない）
 * - 自動移動: `flyTo`
 *
 * カメラは親を持たない（ワールド座標で直接動かせる）ものとする。
 * 毎フレーム `update(dt)` を呼ぶこと。運動の積分は `FlyMotion` が受け持つ。
 */
export class FlyCameraControls extends EventDispatcher<FlyCameraControlsEventMap> {
  readonly camera: PerspectiveCamera;
  readonly domElement: HTMLElement;
  /** ドラッグ 1 ピクセルあたりの回転量（ラジアン）。 */
  rotateSpeed: number;

  private readonly motion: FlyMotion;
  private readonly input: MoveInput = createMoveInput();
  private readonly win: Window;
  private readonly euler = new Euler(0, 0, 0, 'YXZ');
  private readonly dirTmp = new Vector3();
  private readonly wheelGesture = new WheelGestureLimiter();
  private readonly inertia: RotationInertia;

  private _enabled = true;
  private dragPointerId: number | null = null;
  private lastX = 0;
  private lastY = 0;
  private prevTouchAction: string | null = null;
  private disposed = false;

  constructor(camera: PerspectiveCamera, domElement: HTMLElement, options: FlyCameraControlsOptions = {}) {
    super();
    this.camera = camera;
    this.domElement = domElement;
    this.rotateSpeed = options.rotateSpeed ?? 0.0025;
    this.motion = new FlyMotion(options);
    this.win = domElement.ownerDocument?.defaultView ?? window;
    this.inertia = new RotationInertia(options.rotationInertia, this.win);

    camera.updateMatrixWorld();
    this.motion.position.copy(camera.getWorldPosition(new Vector3()));
    this.motion.setDirection(camera.getWorldDirection(this.dirTmp));
    // 構築時の向きは dirty 扱いにしない（update 前に動いたと報告しない）。
    this.motion.step(0, this.input);

    this.domElement.addEventListener('pointerdown', this.onPointerDown);
    this.domElement.addEventListener('pointermove', this.onPointerMove);
    this.domElement.addEventListener('pointerup', this.onPointerUp);
    this.domElement.addEventListener('pointercancel', this.onPointerCancel);
    this.domElement.addEventListener('lostpointercapture', this.onPointerCancel);
    this.domElement.addEventListener('wheel', this.onWheel, { passive: false });
    this.win.addEventListener('keydown', this.onKeyDown);
    this.win.addEventListener('keyup', this.onKeyUp);
    this.win.addEventListener('blur', this.onBlur);
    if (this.domElement.style) {
      this.prevTouchAction = this.domElement.style.touchAction;
      this.domElement.style.touchAction = 'none';
    }
  }

  // ---- 設定 ----

  get enabled(): boolean {
    return this._enabled;
  }

  set enabled(value: boolean) {
    if (value === this._enabled) return;
    this._enabled = value;
    if (!value) this.releaseInputs();
  }

  /** 基準速度（単位/秒）。`minSpeed`〜`maxSpeed` に丸められる。 */
  get speed(): number {
    return this.motion.speed;
  }

  set speed(value: number) {
    const before = this.motion.speed;
    this.motion.speed = value;
    if (this.motion.speed !== before) this.dispatchSpeedChange();
  }

  /**
   * 実際の移動速度に掛ける係数（既定 1、正の有限値）。密度に応じた自動調整など、外部が使う。
   * ユーザーが決める `speed` とは別に持ち、`speed`・`speedchange` には影響しない。
   * 正の有限値以外を代入しても無視する。`flyTo` の所要時間には影響しない。
   */
  get speedScale(): number {
    return this.motion.speedScale;
  }

  set speedScale(value: number) {
    this.motion.speedScale = value;
  }

  get minSpeed(): number {
    return this.motion.minSpeed;
  }

  set minSpeed(value: number) {
    this.motion.minSpeed = value;
    this.speed = this.motion.speed;
  }

  get maxSpeed(): number {
    return this.motion.maxSpeed;
  }

  set maxSpeed(value: number) {
    this.motion.maxSpeed = value;
    this.speed = this.motion.speed;
  }

  /** 目標速度へ近づく指数応答の時定数（秒）。 */
  get timeConstant(): number {
    return this.motion.timeConstant;
  }

  set timeConstant(value: number) {
    this.motion.timeConstant = value;
  }

  /**
   * ドラッグを離したあとの回転の慣性の時定数（秒）。0 以下で無効。
   * 代入しなければ既定の 0.3 秒（「動きを減らす」設定なら無効）。`null` を代入すると、その既定へ戻す。
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

  /** 回転の慣性を止める（向きはそのまま）。 */
  stopRotationInertia(): void {
    this.inertia.stop();
  }

  /** 自動移動の最中なら true。 */
  get isFlying(): boolean {
    return this.motion.isFlying;
  }

  // ---- 姿勢 ----

  setPose(position: Vector3, lookAt: Vector3): void {
    this.inertia.stop();
    this.motion.setPose(position, lookAt);
    this.syncCamera();
    this.dispatchEvent({ type: 'change' });
  }

  getPose(): FlyPose {
    return this.motion.getPose();
  }

  /**
   * `target` を注視する位置へ自動移動する。カメラと `target` を結ぶ線上で、
   * `target` から `distance` だけ手前に着く。既定は 600 ミリ秒、ease-out quartic。
   * 移動中にキー移動やドラッグ回転をすると中断する（ホイールは中断しない）。
   */
  flyTo(target: Vector3, options?: FlyToOptions): void {
    if (!this._enabled || this.disposed) return;
    this.inertia.stop();
    this.motion.flyTo(target, options);
  }

  cancelFlyTo(): void {
    this.motion.cancelFlyTo();
  }

  // ---- 毎フレーム ----

  /**
   * `dtSeconds` だけ進めてカメラへ反映する。カメラが動いたら true。
   * `dtSeconds` が NaN・負・無限大なら、何も変えずに false を返す。
   */
  update(dtSeconds: number): boolean {
    if (!this._enabled || this.disposed) return false;
    this.stepInertia(dtSeconds);
    const moved = this.motion.step(dtSeconds, this.input);
    if (moved) {
      this.syncCamera();
      this.dispatchEvent({ type: 'change' });
    }
    return moved;
  }

  /** すべてのリスナーを外す。以降 `update` は何もしない。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.domElement.removeEventListener('pointerdown', this.onPointerDown);
    this.domElement.removeEventListener('pointermove', this.onPointerMove);
    this.domElement.removeEventListener('pointerup', this.onPointerUp);
    this.domElement.removeEventListener('pointercancel', this.onPointerCancel);
    this.domElement.removeEventListener('lostpointercapture', this.onPointerCancel);
    this.domElement.removeEventListener('wheel', this.onWheel);
    this.win.removeEventListener('keydown', this.onKeyDown);
    this.win.removeEventListener('keyup', this.onKeyUp);
    this.win.removeEventListener('blur', this.onBlur);
    if (this.domElement.style && this.prevTouchAction !== null) {
      this.domElement.style.touchAction = this.prevTouchAction;
    }
    this.releaseInputs();
  }

  // ---- 内部 ----

  /** 慣性の回転を進める。移動の積分の前に回すので、同じフレームの移動も新しい向きで行う。 */
  private stepInertia(dtSeconds: number): void {
    const inertia = this.inertia;
    if (!inertia.active) return;
    // 1 回の update で進める時間は、移動と同じ上限に収める（タブ復帰時の跳躍を防ぐ）
    const dt = Math.min(dtSeconds, this.motion.maxDeltaTime);
    if (!inertia.step(dt)) return;
    const pitchBefore = this.motion.pitch;
    this.motion.rotateBy(inertia.dYaw, inertia.dPitch);
    // ピッチが ±89° に当たったら、そのぶんの角速度は捨てる（上下の端で回り続けない）
    if (inertia.dPitch !== 0 && Math.abs(this.motion.pitch - (pitchBefore + inertia.dPitch)) > 1e-12) inertia.blockPitch();
  }

  private syncCamera(): void {
    this.camera.position.copy(this.motion.position);
    this.euler.set(this.motion.pitch, this.motion.yaw, 0, 'YXZ');
    this.camera.quaternion.setFromEuler(this.euler);
    this.camera.updateMatrixWorld();
  }

  private dispatchSpeedChange(): void {
    this.dispatchEvent({ type: 'speedchange', speed: this.motion.speed });
  }

  /** キー押下状態・ドラッグ・速度・自動移動を捨てる。 */
  private releaseInputs(): void {
    this.clearKeys();
    this.endDrag();
    this.inertia.stop();
    this.wheelGesture.reset();
    this.motion.stop();
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
    // 慣性で回っている間にポインタを押したら止める（どのボタンでも）
    this.inertia.stop();
    if (e.button !== 0 || this.dragPointerId !== null) return;
    this.dragPointerId = e.pointerId;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.inertia.beginDrag(e.clientX, e.clientY, eventTimeMs(e));
    if (typeof this.domElement.setPointerCapture === 'function') {
      try {
        this.domElement.setPointerCapture(e.pointerId);
      } catch {
        // 合成イベントなどでキャプチャできない場合は無視
      }
    }
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (!this._enabled || e.pointerId !== this.dragPointerId) return;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.inertia.dragMove(e.clientX, e.clientY, eventTimeMs(e));
    // 右へドラッグで右を向く、下へドラッグで下を向く。
    this.motion.rotateBy(-dx * this.rotateSpeed, -dy * this.rotateSpeed);
  };

  /** 離した。離す直前の動きが速ければ、その速さで回り続ける。 */
  private readonly onPointerUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.dragPointerId) return;
    this.endDrag();
    this.inertia.endDrag(eventTimeMs(e), this.rotateSpeed);
  };

  /** 押下の取り消し（pointercancel・lostpointercapture）。慣性は付けない。 */
  private readonly onPointerCancel = (e: PointerEvent): void => {
    if (e.pointerId !== this.dragPointerId) return;
    this.inertia.cancelDrag();
    this.endDrag();
  };

  private readonly onWheel = (e: WheelEvent): void => {
    if (!this._enabled) return;
    e.preventDefault();
    // ピンチ操作（ctrlKey つきのホイール）はページのズームに当たる操作で、速度の変更ではない。
    if (e.ctrlKey) return;
    // 横方向だけのスクロールは、速度の変更ではなく、払いの継続にも数えない。
    if (e.deltaY === 0) return;
    // deltaMode: 0 = ピクセル、1 = 行、2 = ページ。1 ノッチ = 100 ピクセル = 3 行 = 1 ページ分。
    let notches: number;
    switch (e.deltaMode) {
      case 1: // DOM_DELTA_LINE
        notches = e.deltaY / LINES_PER_NOTCH;
        break;
      case 2: // DOM_DELTA_PAGE
        notches = e.deltaY;
        break;
      default: // DOM_DELTA_PIXEL
        notches = e.deltaY / PIXELS_PER_NOTCH;
    }
    const timeMs = typeof e.timeStamp === 'number' ? e.timeStamp : performance.now();
    const effective = this.wheelGesture.consume(notches, timeMs, isDiscreteWheelDelta(e.deltaMode, e.deltaY));
    if (effective !== 0 && this.motion.applyWheel(effective)) this.dispatchSpeedChange();
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (!this._enabled) return;
    if (isMetaKey(e)) {
      this.clearKeys();
      return;
    }
    const action = KEY_MAP[e.code];
    if (!action) return;
    if (isEditableTarget(eventOrigin(e))) return;
    // Ctrl / Meta / Alt との組み合わせはブラウザやOSのショートカットに任せる。
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    this.input[action] = true;
    e.preventDefault();
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    if (isMetaKey(e)) {
      this.clearKeys();
      return;
    }
    // 入力欄にフォーカスが移っていても、離したキーは必ず解除する。
    const action = KEY_MAP[e.code];
    if (!action) return;
    this.input[action] = false;
  };

  private readonly onBlur = (): void => {
    this.clearKeys();
    this.endDrag();
    this.inertia.cancelDrag();
    this.inertia.stop();
  };

  /** 移動キーの押下状態をすべて消す。 */
  private clearKeys(): void {
    Object.assign(this.input, createMoveInput());
  }
}
