import { Euler, Vector3 } from 'three';
import type { PerspectiveCamera } from 'three';
import { FlyCameraControls, type FlyToOptions, type MoveInertiaOptions } from '../controls/FlyCameraControls';
import { MAX_VIEW_PITCH, viewAngles, type ViewAngles, type ViewSpec } from '../render/view';
import { OverviewControls, orbitPose, type OverviewZoomState } from './overviewControls';
import type { AutoSpeed } from './autoSpeed';
import { HOME_DURATION_SECONDS, HomeFlight, poseLookAt, type FlightPose } from './homeFlight';
import { REORIENT_MIN_ANGLE, Reorient, ResidualMotion, wrapAngle } from './modeTransition';
import { isFromEditable } from './keyEvents';
import { prefersReducedMotion, type RotationInertiaOptions } from '../controls/RotationInertia';

export type CameraMode = 'fly' | 'overview';

/** `getState().lookAt` と URL の `look` が、位置から視線方向へ進める距離。 */
export const LOOK_DISTANCE = 0.25;

export interface CameraState {
  mode: CameraMode;
  position: [number, number, number];
  /** 位置から視線方向へ LOOK_DISTANCE だけ進んだ点。`?pos=…&look=…` にそのまま使える。 */
  lookAt: [number, number, number];
  /** 視線方向（単位ベクトル）。 */
  direction: [number, number, number];
  /** 飛行モードの基準速度（単位/秒）。俯瞰モードでも値は保たれる。 */
  speed: number;
  /** 俯瞰モードの回転の中心。飛行モードでは null。 */
  pivot: [number, number, number] | null;
  /** 実際の移動速度に掛けている係数（`fly.speedScale`）。 */
  speedScale: number;
  /** 実際の移動速度（`speed × speedScale`）。 */
  effectiveSpeed: number;
  autoSpeed: AutoSpeedState;
  /** ホームの視点へ移動中か（`goHome` の途中）。 */
  homing: boolean;
  /** ドラッグを離したあとの回転の慣性で回っている最中か（現在のモード）。 */
  rotating: boolean;
  /** 俯瞰モードの中心までの距離の状態（目標の距離・実際の距離・寄っている途中か）。飛行モードでは null。 */
  overview: OverviewZoomState | null;
  /** 飛行モードの移動の慣性（`fly.accelTimeConstant`・`fly.glideTimeConstant`）と、滑走中か（キーを離したあと、残った速度で進んでいる）。 */
  moveInertia: { accelTimeConstant: number; glideTimeConstant: number; gliding: boolean };
  /** 飛行 → 俯瞰の切り替えで、点群の中心へ向き直している最中か（`homing` とは別。位置は動かない）。 */
  reorienting: boolean;
  /**
   * モードを切り替えた瞬間に残っていた移動の速度と回転が、時定数 0.15 秒で消えていく最中か。
   * `reorienting` か `settling` が true の間は、操作をしていなくてもカメラが動いている。
   */
  settling: boolean;
}

/** 密度に応じた速度の自動調整の状態。 */
export interface AutoSpeedState {
  /** 自動調整を使えるか（データセットに `density` があるか）。 */
  available: boolean;
  /** 有効か（T キーで切り替える）。使えないときは常に false。 */
  enabled: boolean;
  /** 自動調整が求めた係数（平滑化後）。無効でも最後の値を保つ。使えないときは 1。 */
  scale: number;
  /** 係数を決めるのに採用した距離（現在地と進行方向の先の小さいほう）。まだ求めていなければ null。 */
  distance: number | null;
}

export interface CameraRigOptions {
  /** 密度に応じた速度の自動調整。なければ係数は 1 のまま。 */
  autoSpeed?: AutoSpeed | null;
  /**
   * ドラッグを離したあとの回転の慣性（飛行・俯瞰の両方）。`timeConstant` を 0 以下にすると無効。
   * 省略すると、時定数は飛行モード 0.35 秒・俯瞰モード 0.45 秒で、「動きを減らす」設定（`prefers-reduced-motion: reduce`）なら無効。
   */
  rotationInertia?: RotationInertiaOptions;
  /**
   * 俯瞰モードで、距離が目標へ近づく速さの時定数（秒）。0 以下で、ホイールごとに距離が 1 度に動く。
   * 省略すると、0.15 秒で、「動きを減らす」設定（`prefers-reduced-motion: reduce`）なら 0。
   */
  zoomTimeConstant?: number;
  /**
   * 飛行モードの移動の慣性（加速 0.15 秒・滑走 0.5 秒）。省略した項目は既定で、
   * 「動きを減らす」設定（`prefers-reduced-motion: reduce`）なら、どちらも 0.12 秒（キーを離すとすぐ止まる）。
   */
  moveInertia?: MoveInertiaOptions;
}

/** 飛行モードで、移動中のホーム復帰を中断させるキー（`FlyCameraControls` の移動キーと同じ）。 */
const FLY_MOVE_CODES = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyE', 'KeyQ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
]);

/**
 * 飛行モードと俯瞰モードを持ち、O キーなどで切り替えるカメラ操作。
 * 位置と向きの持ち主は常に `camera` で、切り替えの瞬間にそれを跳ばさない
 * （飛行 → 俯瞰: 回転の中心を点群の中心にして、位置を保ったまま 0.5 秒で中心へ向き直す（向きのずれが 3° 未満なら何もしない）、
 * 俯瞰 → 飛行: 現在の姿勢から飛行操作を再開する）。
 * 切り替えた瞬間に残っている移動の速度と回転の慣性は、時定数 0.15 秒で減らして消す（切り替え先の入力はすぐに受け付ける）。
 * 滑走中に切り替えても、滑走（時定数 0.5 秒）は引き継がず、その速度を残った動き（0.15 秒）として消す。俯瞰 → 飛行では、
 * 飛行は速度 0 から始まり、寄っている途中の距離は止める。残った動きが消えるまでの間は、`getState().settling` が true。
 * 「動きを減らす」設定（`prefers-reduced-motion: reduce`）では、向き直さず、残った動きも捨てる（従来の切り替え）。
 * 有効でない側の操作は入力に反応しない。
 */
export class CameraRig {
  readonly camera: PerspectiveCamera;
  readonly fly: FlyCameraControls;
  readonly overview: OverviewControls;
  /** 俯瞰モードの回転の中心（点群の中心）。 */
  readonly center: Vector3;

  private _mode: CameraMode = 'fly';
  private readonly listeners = new Set<() => void>();
  private readonly dir = new Vector3();
  private readonly autoSpeed: AutoSpeed | null;
  private _autoSpeedEnabled: boolean;
  private readonly prevPosition = new Vector3();
  private readonly velocity = new Vector3();
  private readonly euler = new Euler(0, 0, 0, 'YXZ');
  private readonly win: Window;
  private readonly domElement: HTMLElement;
  /** ホームの視点へ移動中なら、その移動。 */
  private flight: HomeFlight | null = null;
  /** flyTo による自動移動の最中（速度の自動調整を止めている） */
  private flying = false;
  /** 飛行 → 俯瞰の切り替えで、点群の中心へ向き直している最中なら、その動き。 */
  private reorient: Reorient | null = null;
  /** 切り替えた瞬間に残っていた移動の速度と回転の慣性（時定数 0.15 秒で減らして消す）。 */
  private readonly residual = new ResidualMotion();

  constructor(camera: PerspectiveCamera, domElement: HTMLElement, center: Vector3, options: CameraRigOptions = {}) {
    this.camera = camera;
    this.domElement = domElement;
    this.win = domElement.ownerDocument?.defaultView ?? window;
    this.center = center.clone();
    this.fly = new FlyCameraControls(camera, domElement, { rotationInertia: options.rotationInertia, moveInertia: options.moveInertia });
    this.overview = new OverviewControls(camera, domElement, {
      rotationInertia: options.rotationInertia,
      zoomTimeConstant: options.zoomTimeConstant,
    });
    this.overview.pivot.copy(this.center);
    this.fly.addEventListener('speedchange', this.notify);
    this.autoSpeed = options.autoSpeed ?? null;
    this._autoSpeedEnabled = this.autoSpeed !== null;
    this.win.addEventListener('keydown', this.onKeyDown);
    domElement.addEventListener('pointerdown', this.onPointerDown);
    domElement.addEventListener('wheel', this.onWheel, { passive: true });
    domElement.addEventListener('pointerdown', this.onTransitionPointerDown);
    domElement.addEventListener('wheel', this.onTransitionWheel, { passive: true });
  }

  get mode(): CameraMode {
    return this._mode;
  }

  /** モードや速度が変わったときに呼ばれる。 */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setMode(mode: CameraMode): void {
    if (mode === this._mode) return;
    this.reorient = null;
    if (mode === 'overview') {
      // 無効にする前に、残っている移動の速度と回転の慣性を読む。キーを離したあとの滑走中なら、その速度も含む。
      // 滑走（時定数 0.5 秒）は引き継がず、切り替えの残った動き（時定数 0.15 秒）として消す。
      const left = this.fly.getResidualMotion();
      this.fly.enabled = false; // 押されているキー・滑走・慣性をここで捨てる
      this.overview.pivot.copy(this.center);
      this.overview.enabled = true;
      this.carryResidual(left.velocity, left.yawRate, left.pitchRate, false);
      this.startReorient();
    } else {
      const left = this.overview.getResidualRotation();
      this.overview.enabled = false; // 寄っている途中の距離も止める（俯瞰へ戻しても再開しない）
      // 飛行は速度 0 から始める。前に飛行 → 俯瞰で引き継いだ移動の速度が残っていても、ここで捨てる。
      this.residual.stop();
      this.fly.enabled = true;
      // 俯瞰操作は仰角を ±89° に収めているので、飛行側の制限と食い違わない。
      this.camera.updateMatrixWorld();
      const position = this.camera.getWorldPosition(new Vector3());
      const forward = this.camera.getWorldDirection(this.dir);
      this.fly.setPose(position, position.clone().add(forward));
      this.carryResidual(null, left.yawRate, left.pitchRate, true);
      // 止まった状態から始まるので、係数は次のフレームで現在地の目標へそろえてよい。
      this.autoSpeed?.reset();
    }
    this._mode = mode;
    this.notify();
  }

  toggle(): void {
    this.setMode(this._mode === 'fly' ? 'overview' : 'fly');
  }

  /** 速度の自動調整を使えるか（データセットに `density` があるか）。 */
  get autoSpeedAvailable(): boolean {
    return this.autoSpeed !== null;
  }

  /** 速度の自動調整が有効か。使えないときは常に false。無効にすると係数を 1 に戻す。 */
  get autoSpeedEnabled(): boolean {
    return this._autoSpeedEnabled;
  }

  set autoSpeedEnabled(value: boolean) {
    const next = value && this.autoSpeed !== null;
    if (next === this._autoSpeedEnabled) return;
    this._autoSpeedEnabled = next;
    if (next) {
      // 係数 1 の状態から、いつもの平滑化で目標へ近づける（有効にした瞬間に速度が跳ばない）。
      this.autoSpeed?.continueFrom(this.fly.speedScale);
    } else {
      this.fly.speedScale = 1;
    }
    this.notify();
  }

  toggleAutoSpeed(): void {
    this.autoSpeedEnabled = !this._autoSpeedEnabled;
  }

  /**
   * ドラッグを離したあとの回転の慣性の時定数（秒。現在のモードの値を返し、代入は飛行・俯瞰の両方に効く）。0 以下で無効。
   * `null` を代入すると、モードごとの既定（飛行 0.35 秒・俯瞰 0.45 秒。「動きを減らす」設定なら無効）へ戻す。
   */
  get rotationTimeConstant(): number {
    return this._mode === 'fly' ? this.fly.rotationTimeConstant : this.overview.rotationTimeConstant;
  }

  set rotationTimeConstant(value: number | null) {
    this.fly.rotationTimeConstant = value;
    this.overview.rotationTimeConstant = value;
  }

  /**
   * 俯瞰モードで、距離が目標へ近づく速さの時定数（秒）。0 以下で、ホイール・ピンチごとに距離が 1 度に動く。
   * `null` を代入すると、既定（0.15 秒。「動きを減らす」設定なら 0）へ戻す。
   */
  get zoomTimeConstant(): number {
    return this.overview.zoomTimeConstant;
  }

  set zoomTimeConstant(value: number | null) {
    this.overview.zoomTimeConstant = value;
  }

  /** 回転の慣性で回っている最中か（現在のモード）。 */
  get isRotatingByInertia(): boolean {
    return this._mode === 'fly' ? this.fly.isRotatingByInertia : this.overview.isRotatingByInertia;
  }

  /** ホームの視点への移動の途中か。 */
  get homing(): boolean {
    return this.flight !== null;
  }

  /** 飛行 → 俯瞰の切り替えで、点群の中心へ向き直している最中か。 */
  get reorienting(): boolean {
    return this.reorient !== null;
  }

  /**
   * 現在の位置と向きから `view`（ホームの視点）へ、約 1 秒かけて滑らかに移動する。モードは変えない。
   * 位置と向きの両方を補間し、始まりと終わりを緩やかにする。移動中に操作（飛行モードでは移動キーとドラッグ、
   * 俯瞰モードではドラッグとホイール・ピンチ）をするか、`setView` を呼ぶと中断してその場に留まる。
   * 移動の間は、速度の自動調整は働かない（終わったあと、着いた位置から調整し直す）。
   */
  goHome(view: ViewSpec, durationSeconds: number = HOME_DURATION_SECONDS): void {
    // 点への自動移動（flyTo）の途中なら中断する（ホームへの移動が終わったあとに再開しないように）
    this.fly.cancelFlyTo();
    this.flying = false;
    // 回転の慣性も止める（ホームへの移動と重ねて回り続けない）
    this.stopRotationInertia();
    this.overview.stopZoom(); // 寄っている途中の距離も止める（ホームへの移動と重ねて動かない）
    this.stopTransition();
    const from = this.currentPose();
    const to: FlightPose = { position: [...view.pos], ...viewAngles(view, from) };
    this.flight = new HomeFlight(from, to, durationSeconds);
    this.notify();
  }

  /** ホームの視点への移動を中断して、その場に留まる。移動中でなければ何もしない。 */
  cancelHome(): void {
    if (!this.flight) return;
    this.flight = null;
    // 動いた位置から調整し直す（移動の速度を測って係数に反映しない）
    this.autoSpeed?.reset();
    this.notify();
  }

  /**
   * `target` を注視する位置へ自動移動する（`FlyCameraControls.flyTo`）。俯瞰モードなら飛行モードへ切り替えてから。
   * 移動中は速度の自動調整を止め（移動の速さは所要時間で決まり、係数には依らない）、着いたら止まった状態として測り直す。
   */
  flyTo(target: Vector3, options?: FlyToOptions): void {
    this.cancelHome(); // ホームへの移動中なら中断して、その場から飛ぶ
    this.setMode('fly');
    this.stopTransition(); // 切り替えで残った動きは、flyTo の移動に重ねない
    this.fly.flyTo(target, options);
    this.flying = this.fly.isFlying;
  }

  /**
   * 押下 `e`（pointerdown）が、回転の慣性を止めた押下か（現在のモードの操作）。点のクリックの判定が、
   * 慣性を止めるための押下を、選択・選択の解除・ダブルクリックのどれにも数えないために使う。
   * 飛行・俯瞰のカメラ操作と、このメソッドを呼ぶリスナーの登録順によらず、同じ答えになる。
   */
  pressStopsInertia(e: Event): boolean {
    return this.fly.pressStopsInertia(e) || this.overview.pressStopsInertia(e);
  }

  /** 回転の慣性を止める（飛行・俯瞰の両方。位置と向きはそのまま）。 */
  stopRotationInertia(): void {
    this.fly.stopRotationInertia();
    this.overview.stopRotationInertia();
    this.residual.stopRotation();
  }

  update(dt: number): void {
    if (this.flight) {
      this.stepFlight(dt);
      return;
    }
    this.stepTransition(dt);
    if (this._mode !== 'fly') {
      this.overview.update(dt); // ドラッグを離したあとの回転の慣性
      return;
    }
    this.prevPosition.copy(this.camera.position);
    this.fly.update(dt);
    if (this.flying) {
      if (this.fly.isFlying) return;
      this.flying = false; // 着いた（または操作で中断した）
      this.autoSpeed?.reset();
      return;
    }
    if (!this._autoSpeedEnabled || !this.autoSpeed) return;
    // 速度は、このフレームの移動量から求める（setView などによる瞬間移動はフレームの外で起きるので含まない）。
    if (dt > 0 && Number.isFinite(dt)) this.velocity.subVectors(this.camera.position, this.prevPosition).divideScalar(dt);
    else this.velocity.set(0, 0, 0);
    const scale = this.autoSpeed.update({ position: this.camera.position, velocity: this.velocity, dt });
    if (Number.isFinite(scale) && scale > 0) this.fly.speedScale = scale;
  }

  setView(view: ViewSpec): void {
    this.cancelHome();
    this.stopRotationInertia();
    this.overview.stopZoom();
    this.stopTransition();
    const pos = new Vector3(...view.pos);
    const look = new Vector3(...view.look);
    if (this._mode === 'fly') {
      this.fly.setPose(pos, look); // 速度も 0 になる。仰角は ±89° に収まる
      this.autoSpeed?.reset();
      return;
    }
    // 俯瞰モードでは、回転の中心を保ったまま、指定の位置から注視点を向かせる。
    // `camera.lookAt` を使うと真上・真下を向けるので、飛行モードと同じ ±89° に収めた向きを直接与える。
    this.applyPose({ position: view.pos, ...viewAngles(view, this.currentPose()) });
  }

  getState(): CameraState {
    this.camera.updateMatrixWorld();
    const position = this.camera.getWorldPosition(new Vector3());
    const dir = this.camera.getWorldDirection(this.dir);
    const lookAt = position.clone().addScaledVector(dir, LOOK_DISTANCE);
    return {
      mode: this._mode,
      position: position.toArray(),
      lookAt: lookAt.toArray(),
      direction: dir.toArray(),
      speed: this.fly.speed,
      pivot: this._mode === 'overview' ? this.overview.pivot.toArray() : null,
      speedScale: this.fly.speedScale,
      effectiveSpeed: this.fly.speed * this.fly.speedScale,
      autoSpeed: {
        available: this.autoSpeed !== null,
        enabled: this._autoSpeedEnabled,
        scale: this.autoSpeed ? this.autoSpeed.scale : 1,
        distance: this.autoSpeed ? this.autoSpeed.distance : null,
      },
      homing: this.flight !== null,
      rotating: this.isRotatingByInertia,
      overview: this._mode === 'overview' ? this.overview.zoomState() : null,
      moveInertia: {
        accelTimeConstant: this.fly.accelTimeConstant,
        glideTimeConstant: this.fly.glideTimeConstant,
        gliding: this._mode === 'fly' && this.fly.isGliding,
      },
      reorienting: this.reorient !== null,
      settling: this.residual.active,
    };
  }

  dispose(): void {
    this.flight = null;
    this.stopTransition();
    this.win.removeEventListener('keydown', this.onKeyDown);
    this.domElement.removeEventListener('pointerdown', this.onPointerDown);
    this.domElement.removeEventListener('wheel', this.onWheel);
    this.domElement.removeEventListener('pointerdown', this.onTransitionPointerDown);
    this.domElement.removeEventListener('wheel', this.onTransitionWheel);
    this.fly.removeEventListener('speedchange', this.notify);
    this.fly.dispose();
    this.overview.dispose();
    this.listeners.clear();
  }

  /** カメラの現在の位置と向き（yaw / pitch）。 */
  private currentPose(): FlightPose {
    this.camera.updateMatrixWorld();
    const position = this.camera.getWorldPosition(new Vector3());
    const forward = this.camera.getWorldDirection(this.dir);
    const angles = viewAngles({ pos: position.toArray(), look: position.clone().add(forward).toArray() });
    return { position: position.toArray(), ...angles };
  }

  /** 位置と向きをカメラへ反映する。飛行モードでは飛行操作の状態も同じ姿勢にそろえる。 */
  private applyPose(pose: FlightPose & ViewAngles): void {
    this.camera.position.set(...pose.position);
    this.setCameraAngles(pose.yaw, pose.pitch);
    if (this._mode === 'fly') this.fly.setPose(new Vector3(...pose.position), new Vector3(...poseLookAt(pose)));
  }

  /** カメラの向きだけを yaw / pitch で決める（横傾きなし）。 */
  private setCameraAngles(yaw: number, pitch: number): void {
    this.camera.quaternion.setFromEuler(this.euler.set(pitch, yaw, 0, 'YXZ'));
    this.camera.updateMatrixWorld();
  }

  /** カメラの現在の向き（yaw / pitch）。 */
  private cameraAngles(fallback?: ViewAngles): ViewAngles {
    this.camera.updateMatrixWorld();
    const forward = this.camera.getWorldDirection(this.dir);
    return viewAngles({ pos: [0, 0, 0], look: [forward.x, forward.y, forward.z] }, fallback);
  }

  // ---- モードの切り替えの移り変わり ----

  /** 切り替えた瞬間に残っていた動きを、減らして消す動きとして引き継ぐ。「動きを減らす」設定やホームへの移動中は捨てる。 */
  private carryResidual(velocity: Vector3 | null, yawRate: number, pitchRate: number, orbit: boolean): void {
    if (prefersReducedMotion(this.win) || this.flight) {
      this.residual.stop();
      return;
    }
    if (velocity) this.residual.addVelocity(velocity);
    this.residual.setRotation(yawRate, pitchRate, orbit);
  }

  /**
   * 飛行 → 俯瞰の切り替えで、位置を保ったまま点群の中心へ向き直す動きを始める。向きのずれが 3° 未満なら何もしない。
   * 「動きを減らす」設定なら向き直さない（従来どおり、位置も向きも保ったまま回転の中心だけを決め直す）。
   * ホームへの移動中は、その移動を優先する。
   */
  private startReorient(): void {
    if (this.flight || prefersReducedMotion(this.win)) return;
    this.camera.updateMatrixWorld();
    const position = this.camera.getWorldPosition(new Vector3());
    const toCenter = this.center.clone().sub(position);
    if (!(toCenter.length() > 1e-9)) return;
    const forward = this.camera.getWorldDirection(this.dir);
    if (!(forward.angleTo(toCenter) >= REORIENT_MIN_ANGLE)) return;
    this.reorient = new Reorient(this.cameraAngles());
  }

  /** 向き直しを中断して、その場の向きに留まる（回転の中心は点群の中心のまま）。向き直しの最中でなければ何もしない。 */
  cancelReorient(): void {
    if (!this.reorient) return;
    this.reorient = null;
    this.notify();
  }

  /** 向き直しも、残った動きも捨てる（位置と向きはそのまま）。 */
  private stopTransition(): void {
    this.reorient = null;
    this.residual.stop();
  }

  /** 向き直しと、残った動きの減衰を `dt` 秒進める。位置は残った移動の速度でだけ動く。 */
  private stepTransition(dt: number): void {
    const reorient = this.reorient;
    const residual = this.residual;
    if (!reorient && !residual.active) return;
    if (!Number.isFinite(dt) || dt <= 0) return;
    const step = residual.step(dt);
    this.camera.position.add(step.translation);
    if (step.dYaw !== 0 || step.dPitch !== 0) {
      if (residual.orbit) this.orbitCamera(step.dYaw, step.dPitch);
      else if (reorient) reorient.rotateBaseline(step.dYaw, step.dPitch); // 向き直しの始まりへ引き継ぐ
      else this.turnCamera(step.dYaw, step.dPitch);
    }
    if (reorient) this.stepReorient(reorient, dt);
    this.camera.updateMatrixWorld();
    // 飛行モードでは、外から動かした位置と向きを飛行操作へ取り込む（キー入力と慣性は保つ）
    if (this._mode === 'fly') this.fly.syncFromCamera();
  }

  private stepReorient(reorient: Reorient, dt: number): void {
    const p = this.camera.position;
    const current = this.cameraAngles();
    // 目標は毎フレーム、いまの位置から中心を見る向きで決める（残った移動の速度で位置がずれても、終わりは中心を向く）
    const target = viewAngles({ pos: [p.x, p.y, p.z], look: this.center.toArray() }, current);
    const angles = reorient.advance(dt, target);
    this.setCameraAngles(angles.yaw, angles.pitch);
    if (reorient.done) {
      this.reorient = null;
      this.residual.stopRotation(); // 残った回転は向き直しに取り込み済み。終わったあとに中心から外さない
      this.notify();
    }
  }

  /** その場で向きを回す（飛行モードの慣性の残り）。仰角は ±89° に収め、端に当たったら角速度を捨てる。 */
  private turnCamera(dYaw: number, dPitch: number): void {
    const angles = this.cameraAngles();
    const pitch = Math.min(MAX_VIEW_PITCH, Math.max(-MAX_VIEW_PITCH, angles.pitch + dPitch));
    if (dPitch !== 0 && Math.abs(pitch - (angles.pitch + dPitch)) > 1e-12) this.residual.blockPitch();
    this.setCameraAngles(wrapAngle(angles.yaw + dYaw), pitch);
  }

  /** 点群の中心のまわりを回る（俯瞰モードの慣性の残り）。仰角は ±89° に収め、端に当たったら角速度を捨てる。 */
  private orbitCamera(dYaw: number, dPitch: number): void {
    const pitchBefore = this.cameraAngles().pitch;
    const next = orbitPose({ position: this.camera.position, quaternion: this.camera.quaternion }, this.center, dYaw, dPitch);
    this.camera.position.copy(next.position);
    this.camera.quaternion.copy(next.quaternion);
    this.camera.updateMatrixWorld();
    if (dPitch !== 0 && Math.abs(this.cameraAngles().pitch - (pitchBefore + dPitch)) > 1e-12) this.residual.blockPitch();
  }

  private stepFlight(dt: number): void {
    const flight = this.flight;
    if (!flight) return;
    this.applyPose(flight.advance(dt));
    if (!flight.done) return;
    this.flight = null;
    this.autoSpeed?.reset(); // 止まった状態から始まるので、係数は次のフレームで現在地の目標へそろえてよい
    this.notify();
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (!this.flight || this._mode !== 'fly' || !FLY_MOVE_CODES.has(e.code)) return;
    if (e.ctrlKey || e.metaKey || e.altKey || isFromEditable(e)) return;
    this.cancelHome();
  };

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (this.flight && e.button === 0) this.cancelHome();
  };

  /**
   * 俯瞰モードのホイールとピンチ（ctrlKey つきのホイール）は距離を変える。
   * 飛行モードのホイールは速度を変えるだけなので、移動は続ける。
   */
  private readonly onWheel = (e: WheelEvent): void => {
    if (this.flight && this._mode === 'overview' && e.deltaY !== 0) this.cancelHome();
  };

  /** ポインタを押したら、残った回転は止める（慣性と同じ）。左ボタンのドラッグなら、向き直しも中断する。 */
  private readonly onTransitionPointerDown = (e: PointerEvent): void => {
    this.residual.stopRotation();
    if (this.reorient && e.button === 0) this.cancelReorient();
  };

  /**
   * 俯瞰モードのホイールとピンチ（ctrlKey つきのホイール。どちらも距離の変更）で、向き直しを中断する。
   * 距離の変更はそのまま働く。飛行モードのホイールは速度を変えるだけ。
   */
  private readonly onTransitionWheel = (e: WheelEvent): void => {
    if (this.reorient && this._mode === 'overview' && e.deltaY !== 0) this.cancelReorient();
  };

  private readonly notify = (): void => {
    for (const l of this.listeners) l();
  };
}
