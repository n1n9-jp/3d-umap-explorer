import { Vector3 } from 'three';
import type { PerspectiveCamera } from 'three';
import { FlyCameraControls } from '../controls/FlyCameraControls';
import type { ViewSpec } from '../render/view';
import { OverviewControls } from './overviewControls';

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
}

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

  constructor(camera: PerspectiveCamera, domElement: HTMLElement, center: Vector3) {
    this.camera = camera;
    this.center = center.clone();
    this.fly = new FlyCameraControls(camera, domElement);
    this.overview = new OverviewControls(camera, domElement);
    this.overview.pivot.copy(this.center);
    this.fly.addEventListener('speedchange', this.notify);
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
    }
    this._mode = mode;
    this.notify();
  }

  toggle(): void {
    this.setMode(this._mode === 'fly' ? 'overview' : 'fly');
  }

  update(dt: number): void {
    if (this._mode === 'fly') this.fly.update(dt);
  }

  setView(view: ViewSpec): void {
    const pos = new Vector3(...view.pos);
    const look = new Vector3(...view.look);
    if (this._mode === 'fly') {
      this.fly.setPose(pos, look);
      return;
    }
    // 俯瞰モードでは、回転の中心を保ったまま、指定の位置から注視点を向かせる。
    this.camera.position.copy(pos);
    this.camera.lookAt(look);
    this.camera.updateMatrixWorld();
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
    };
  }

  dispose(): void {
    this.fly.removeEventListener('speedchange', this.notify);
    this.fly.dispose();
    this.overview.dispose();
    this.listeners.clear();
  }

  private readonly notify = (): void => {
    for (const l of this.listeners) l();
  };
}
