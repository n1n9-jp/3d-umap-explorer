import { Vector3 } from 'three';
import { MAX_WHEEL_EVENT_NOTCHES } from './WheelGesture';

/**
 * 飛行カメラの運動の積分。DOM にも three.js のカメラにも依存せず、
 * 入力状態と経過時間から位置・向きを更新する。
 *
 * 座標系は three.js と同じ右手系（+Y が上、カメラは既定で -Z を向く）。
 * yaw は +Y まわりの回転（正で左へ向く）、pitch は水平からの仰角（正で上を向く）。
 */

/** 1 フレーム分のキー入力状態。 */
export interface MoveInput {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  boost: boolean;
}

export function createMoveInput(): MoveInput {
  return { forward: false, backward: false, left: false, right: false, up: false, down: false, boost: false };
}

export interface FlyMotionOptions {
  /** 基準速度（単位/秒）。ユーザーが決める値で、`minSpeed`〜`maxSpeed` に丸められる。 */
  speed?: number;
  /**
   * 実際の移動速度にだけ掛ける係数（既定 1、正の有限値）。密度に応じた自動調整など、
   * 外部が `speed` を書き換えずに速度を変えるために使う。`minSpeed`・`maxSpeed` の制限は受けない。
   */
  speedScale?: number;
  minSpeed?: number;
  maxSpeed?: number;
  /** Shift を押している間の速度倍率。 */
  boostFactor?: number;
  /** 目標速度へ近づく指数応答の時定数（秒）。0 以下で慣性なし。 */
  timeConstant?: number;
  /** ホイール 1 ノッチあたりの速度倍率。 */
  wheelFactor?: number;
  /** 1 回の update で積分する時間の上限（秒）。タブ復帰時の跳躍を防ぐ。 */
  maxDeltaTime?: number;
}

export interface FlyToOptions {
  /** 対象から手前に取る距離。 */
  distance?: number;
  durationMs?: number;
}

export interface FlyPose {
  position: Vector3;
  /** 位置から 1 単位前方の点。`setPose` にそのまま渡せる。 */
  lookAt: Vector3;
  yaw: number;
  pitch: number;
}

export const DEFAULT_FLY_TO_DISTANCE = 0.03;
export const DEFAULT_FLY_TO_DURATION_MS = 600;
export const MAX_PITCH = (89 * Math.PI) / 180;

/** 速度がこれ未満で入力が無ければ停止とみなす（単位/秒）。 */
const STOP_SPEED = 1e-5;
/** 1 回のホイールイベントで反映するノッチ数の上限。 */
const MAX_WHEEL_NOTCHES = MAX_WHEEL_EVENT_NOTCHES;

export function easeOutQuart(t: number): number {
  const u = 1 - Math.min(1, Math.max(0, t));
  return 1 - u * u * u * u;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** 角度差を (-π, π] に畳む。 */
function wrapAngle(a: number): number {
  const twoPi = Math.PI * 2;
  let r = (a + Math.PI) % twoPi;
  if (r <= 0) r += twoPi;
  return r - Math.PI;
}

interface FlightState {
  startPosition: Vector3;
  endPosition: Vector3;
  startYaw: number;
  yawDelta: number;
  startPitch: number;
  endPitch: number;
  durationMs: number;
  elapsedMs: number;
}

export class FlyMotion {
  readonly position = new Vector3();
  yaw = 0;
  pitch = 0;
  /** ワールド座標系の現在速度（単位/秒）。 */
  readonly velocity = new Vector3();

  minSpeed: number;
  maxSpeed: number;
  boostFactor: number;
  timeConstant: number;
  wheelFactor: number;
  maxDeltaTime: number;

  private _speed: number;
  private _speedScale = 1;
  private flight: FlightState | null = null;
  /** rotateBy / setPose による未報告の姿勢変化。次の step で moved として返す。 */
  private dirty = false;

  private readonly forwardDir = new Vector3();
  private readonly rightDir = new Vector3();
  private readonly target = new Vector3();

  constructor(options: FlyMotionOptions = {}) {
    this.minSpeed = options.minSpeed ?? 0.005;
    this.maxSpeed = options.maxSpeed ?? 2;
    this.boostFactor = options.boostFactor ?? 3;
    this.timeConstant = options.timeConstant ?? 0.12;
    this.wheelFactor = options.wheelFactor ?? 1.1;
    this.maxDeltaTime = options.maxDeltaTime ?? 0.1;
    this._speed = clamp(options.speed ?? 0.15, this.minSpeed, this.maxSpeed);
    this.speedScale = options.speedScale ?? 1;
  }

  get speed(): number {
    return this._speed;
  }

  set speed(value: number) {
    this._speed = clamp(value, this.minSpeed, this.maxSpeed);
  }

  /** 実際の移動速度に掛ける係数。正の有限値以外を代入しても無視する（直前の値を保つ）。 */
  get speedScale(): number {
    return this._speedScale;
  }

  set speedScale(value: number) {
    if (Number.isFinite(value) && value > 0) this._speedScale = value;
  }

  get isFlying(): boolean {
    return this.flight !== null;
  }

  /** 現在の視線方向（単位ベクトル）を `out` に書く。 */
  getDirection(out: Vector3): Vector3 {
    const cp = Math.cos(this.pitch);
    return out.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
  }

  getPose(): FlyPose {
    const position = this.position.clone();
    const lookAt = this.getDirection(new Vector3()).add(position);
    return { position, lookAt, yaw: this.yaw, pitch: this.pitch };
  }

  /**
   * 位置と注視点を設定する。速度は 0 に戻り、飛行中なら中断する。
   * `lookAt` が `position` と一致して向きが決まらないときは、現在の向きを保つ。
   */
  setPose(position: Vector3, lookAt: Vector3): void {
    this.flight = null;
    this.velocity.set(0, 0, 0);
    this.position.copy(position);
    this.lookTowards(lookAt.x - position.x, lookAt.y - position.y, lookAt.z - position.z);
    this.dirty = true;
  }

  /** カメラの向き（視線方向ベクトル）から yaw / pitch を設定する。 */
  setDirection(dir: Vector3): void {
    this.lookTowards(dir.x, dir.y, dir.z);
    this.dirty = true;
  }

  /** ホイール操作。`notches` は 1 ノッチ = 1、正で減速、負で加速。速度が変わったら true。 */
  applyWheel(notches: number): boolean {
    const n = clamp(notches, -MAX_WHEEL_NOTCHES, MAX_WHEEL_NOTCHES);
    const before = this._speed;
    this._speed = clamp(before * Math.pow(this.wheelFactor, -n), this.minSpeed, this.maxSpeed);
    return this._speed !== before;
  }

  /** 視点を回す。正の `dYaw` で左へ、正の `dPitch` で上へ。飛行中なら中断する。 */
  rotateBy(dYaw: number, dPitch: number): void {
    if (dYaw === 0 && dPitch === 0) return;
    this.flight = null;
    this.yaw = wrapAngle(this.yaw + dYaw);
    this.pitch = clamp(this.pitch + dPitch, -MAX_PITCH, MAX_PITCH);
    this.dirty = true;
  }

  /**
   * `target` を注視する位置へ移動する自動移動を始める。進行は `step` が受け持つ。
   * 終了位置は、`target` からカメラ方向へ `distance` だけ離れた点。
   */
  flyTo(target: Vector3, options: FlyToOptions = {}): void {
    const distance = Math.max(0, options.distance ?? DEFAULT_FLY_TO_DISTANCE);
    const durationMs = Math.max(0, options.durationMs ?? DEFAULT_FLY_TO_DURATION_MS);

    const offset = this.position.clone().sub(target);
    if (offset.lengthSq() < 1e-18) {
      // カメラが対象と重なっている。今の視線の反対側に退く。
      offset.copy(this.getDirection(new Vector3())).negate();
    }
    offset.normalize();
    const end = target.clone().addScaledVector(offset, distance);

    // end から target を見る向き = -offset。
    let endYaw = this.yaw;
    if (Math.hypot(offset.x, offset.z) > 1e-9) endYaw = Math.atan2(offset.x, offset.z);
    const endPitch = clamp(Math.asin(clamp(-offset.y, -1, 1)), -MAX_PITCH, MAX_PITCH);

    this.velocity.set(0, 0, 0);
    this.flight = {
      startPosition: this.position.clone(),
      endPosition: end,
      startYaw: this.yaw,
      yawDelta: wrapAngle(endYaw - this.yaw),
      startPitch: this.pitch,
      endPitch,
      durationMs,
      elapsedMs: 0,
    };
    if (durationMs === 0) this.advanceFlight(0);
  }

  cancelFlyTo(): void {
    this.flight = null;
  }

  /** 速度と進行中の飛行を捨てる（無効化時など）。 */
  stop(): void {
    this.flight = null;
    this.velocity.set(0, 0, 0);
  }

  /**
   * `dtSeconds` だけ時間を進める。入力は区間内で一定とみなす。
   * 速度は目標速度へ指数的に近づき、位置はその解析解で積分するので、
   * 同じ入力なら刻み幅によらず同じ位置に着く。
   * 位置または向きが変わったら true。
   * `dtSeconds` が NaN・負・無限大のときは、状態を変えずに false を返す。
   */
  step(dtSeconds: number, input: MoveInput): boolean {
    if (!Number.isFinite(dtSeconds) || dtSeconds < 0) return false;
    const dt = clamp(dtSeconds, 0, this.maxDeltaTime);
    let moved = this.dirty;
    this.dirty = false;

    this.computeTargetVelocity(input, this.target);
    const hasMoveInput = this.target.lengthSq() > 0;

    if (this.flight) {
      if (hasMoveInput) {
        this.flight = null; // 操作による中断。以降は通常の移動として扱う。
      } else {
        this.advanceFlight(dt * 1000);
        return true;
      }
    }

    if (dt === 0) return moved;

    const v = this.velocity;
    const tau = this.timeConstant;
    if (tau <= 0) {
      v.copy(this.target);
      this.position.addScaledVector(v, dt);
    } else {
      const decay = Math.exp(-dt / tau);
      // x(t) = target·dt + (v0 − target)·τ·(1 − e^(−dt/τ))、v(t) = target + (v0 − target)·e^(−dt/τ)
      const gain = tau * (1 - decay);
      this.position.x += this.target.x * dt + (v.x - this.target.x) * gain;
      this.position.y += this.target.y * dt + (v.y - this.target.y) * gain;
      this.position.z += this.target.z * dt + (v.z - this.target.z) * gain;
      v.x = this.target.x + (v.x - this.target.x) * decay;
      v.y = this.target.y + (v.y - this.target.y) * decay;
      v.z = this.target.z + (v.z - this.target.z) * decay;
    }

    if (!hasMoveInput && v.lengthSq() < STOP_SPEED * STOP_SPEED) {
      if (v.lengthSq() > 0) moved = true;
      v.set(0, 0, 0);
    }
    if (v.lengthSq() > 0 || hasMoveInput) moved = true;
    return moved;
  }

  private computeTargetVelocity(input: MoveInput, out: Vector3): Vector3 {
    const f = Number(input.forward) - Number(input.backward);
    const r = Number(input.right) - Number(input.left);
    const u = Number(input.up) - Number(input.down);
    out.set(0, 0, 0);
    if (f === 0 && r === 0 && u === 0) return out;

    this.getDirection(this.forwardDir);
    // 右方向は水平面内（ピッチに依らない）。
    this.rightDir.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    out.addScaledVector(this.forwardDir, f).addScaledVector(this.rightDir, r);
    out.y += u;
    const len = out.length();
    if (len === 0) return out; // 打ち消し合った
    const speed = this._speed * this._speedScale * (input.boost ? this.boostFactor : 1);
    return out.multiplyScalar(speed / Math.max(len, 1));
  }

  private advanceFlight(dtMs: number): void {
    const fl = this.flight;
    if (!fl) return;
    fl.elapsedMs += dtMs;
    const t = fl.durationMs <= 0 ? 1 : Math.min(1, fl.elapsedMs / fl.durationMs);
    if (t >= 1) {
      this.position.copy(fl.endPosition);
      this.yaw = wrapAngle(fl.startYaw + fl.yawDelta);
      this.pitch = fl.endPitch;
      this.flight = null;
    } else {
      const e = easeOutQuart(t);
      this.position.lerpVectors(fl.startPosition, fl.endPosition, e);
      this.yaw = wrapAngle(fl.startYaw + fl.yawDelta * e);
      this.pitch = fl.startPitch + (fl.endPitch - fl.startPitch) * e;
    }
    this.velocity.set(0, 0, 0);
    this.dirty = false;
  }

  private lookTowards(x: number, y: number, z: number): void {
    const len = Math.hypot(x, y, z);
    if (len < 1e-12) return;
    if (Math.hypot(x, z) > 1e-9 * len) this.yaw = Math.atan2(-x, -z);
    this.pitch = clamp(Math.asin(clamp(y / len, -1, 1)), -MAX_PITCH, MAX_PITCH);
  }
}
