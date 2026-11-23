import { Euler, Vector3 } from 'three';
import type { PerspectiveCamera } from 'three';
import { FlyCameraControls, type FlyToOptions } from '../controls/FlyCameraControls';
import { viewAngles, type ViewAngles, type ViewSpec } from '../render/view';
import { OverviewControls } from './overviewControls';
import type { AutoSpeed } from './autoSpeed';
import { HOME_DURATION_SECONDS, HomeFlight, poseLookAt, type FlightPose } from './homeFlight';
import { isFromEditable } from './keyEvents';
import type { RotationInertiaOptions } from '../controls/RotationInertia';

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
   * 省略すると、時定数 0.3 秒で、「動きを減らす」設定（`prefers-reduced-motion: reduce`）なら無効。
   */
  rotationInertia?: RotationInertiaOptions;
}

/** 飛行モードで、移動中のホーム復帰を中断させるキー（`FlyCameraControls` の移動キーと同じ）。 */
const FLY_MOVE_CODES = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyE', 'KeyQ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
]);

/**
 * 飛行モードと俯瞰モードを持ち、O キーなどで切り替えるカメラ操作。
 * 位置と向きの持ち主は常に `camera` で、切り替えの前後でそれを変えない
 * （飛行 → 俯瞰: 中心だけ決め直す、俯瞰 → 飛行: 現在の姿勢から飛行操作を再開する）。
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

  constructor(camera: PerspectiveCamera, domElement: HTMLElement, center: Vector3, options: CameraRigOptions = {}) {
    this.camera = camera;
    this.domElement = domElement;
    this.win = domElement.ownerDocument?.defaultView ?? window;
    this.center = center.clone();
    this.fly = new FlyCameraControls(camera, domElement, { rotationInertia: options.rotationInertia });
    this.overview = new OverviewControls(camera, domElement, { rotationInertia: options.rotationInertia });
    this.overview.pivot.copy(this.center);
    this.fly.addEventListener('speedchange', this.notify);
    this.autoSpeed = options.autoSpeed ?? null;
    this._autoSpeedEnabled = this.autoSpeed !== null;
    this.win.addEventListener('keydown', this.onKeyDown);
    domElement.addEventListener('pointerdown', this.onPointerDown);
    domElement.addEventListener('wheel', this.onWheel, { passive: true });
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
    if (mode === 'overview') {
      this.fly.enabled = false; // 押されているキーと慣性をここで捨てる
      this.overview.pivot.copy(this.center);
      this.overview.enabled = true;
    } else {
      this.overview.enabled = false;
      this.fly.enabled = true;
      // 俯瞰操作は仰角を ±89° に収めているので、飛行側の制限と食い違わない。
      this.camera.updateMatrixWorld();
      const position = this.camera.getWorldPosition(new Vector3());
      const forward = this.camera.getWorldDirection(this.dir);
      this.fly.setPose(position, position.clone().add(forward));
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
   * ドラッグを離したあとの回転の慣性の時定数（秒。飛行・俯瞰の両方）。0 以下で無効。
   * `null` を代入すると、既定（0.3 秒。「動きを減らす」設定なら無効）へ戻す。
   */
  get rotationTimeConstant(): number {
    return this._mode === 'fly' ? this.fly.rotationTimeConstant : this.overview.rotationTimeConstant;
  }

  set rotationTimeConstant(value: number | null) {
    this.fly.rotationTimeConstant = value;
    this.overview.rotationTimeConstant = value;
  }

  /** 回転の慣性で回っている最中か（現在のモード）。 */
  get isRotatingByInertia(): boolean {
    return this._mode === 'fly' ? this.fly.isRotatingByInertia : this.overview.isRotatingByInertia;
  }

  /** ホームの視点への移動の途中か。 */
  get homing(): boolean {
    return this.flight !== null;
  }

  /**
   * 現在の位置と向きから `view`（ホームの視点）へ、約 1 秒かけて滑らかに移動する。モードは変えない。
   * 位置と向きの両方を補間し、始まりと終わりを緩やかにする。移動中に操作（飛行モードでは移動キーとドラッグ、
   * 俯瞰モードではドラッグとホイール）をするか、`setView` を呼ぶと中断してその場に留まる。
   * 移動の間は、速度の自動調整は働かない（終わったあと、着いた位置から調整し直す）。
   */
  goHome(view: ViewSpec, durationSeconds: number = HOME_DURATION_SECONDS): void {
    // 点への自動移動（flyTo）の途中なら中断する（ホームへの移動が終わったあとに再開しないように）
    this.fly.cancelFlyTo();
    this.flying = false;
    // 回転の慣性も止める（ホームへの移動と重ねて回り続けない）
    this.stopRotationInertia();
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
    this.fly.flyTo(target, options);
    this.flying = this.fly.isFlying;
  }

  /** 回転の慣性を止める（飛行・俯瞰の両方。位置と向きはそのまま）。 */
  stopRotationInertia(): void {
    this.fly.stopRotationInertia();
    this.overview.stopRotationInertia();
  }

  update(dt: number): void {
    if (this.flight) {
      this.stepFlight(dt);
      return;
    }
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
    };
  }

  dispose(): void {
    this.flight = null;
    this.win.removeEventListener('keydown', this.onKeyDown);
    this.domElement.removeEventListener('pointerdown', this.onPointerDown);
    this.domElement.removeEventListener('wheel', this.onWheel);
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
    this.camera.quaternion.setFromEuler(this.euler.set(pose.pitch, pose.yaw, 0, 'YXZ'));
    this.camera.updateMatrixWorld();
    if (this._mode === 'fly') this.fly.setPose(new Vector3(...pose.position), new Vector3(...poseLookAt(pose)));
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

  /** 俯瞰モードのホイールは距離を変える。飛行モードのホイールは速度を変えるだけなので、移動は続ける。 */
  private readonly onWheel = (e: WheelEvent): void => {
    if (this.flight && this._mode === 'overview' && !e.ctrlKey && e.deltaY !== 0) this.cancelHome();
  };

  private readonly notify = (): void => {
    for (const l of this.listeners) l();
  };
}
